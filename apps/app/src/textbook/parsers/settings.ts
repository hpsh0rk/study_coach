import { and, eq, sql } from "drizzle-orm";
import { openSecret } from "@kj/ai";
import { db } from "../../db/index.ts";
import { secret, type Env, type SessionUser } from "../../env.ts";
import { HttpError } from "../../http.ts";
import { parserSettings, parseUsage } from "../tables.ts";
import { agentParser, stubParser, tokenParser, type ExternalParser, type MineruMode } from "./mineru.ts";

/** Guardrails on pages sent to external parsers (pdf-parsing research §7). */
export const PARSE_LIMITS = { bookAutoPages: 300, userDayPages: 300, siteDayPages: 900, bookCostFen: 500 } as const;

export interface ParserSettings {
  externalEnabled: boolean;
  mineruMode: "agent" | "token";
  mineruTokenSealed: string | null;
  mineruTokenHint: string | null;
}

function defaultMode(env: Env): "agent" | "token" {
  return env.PARSER_MINERU_MODE === "token" ? "token" : "agent";
}

export async function parserSettingsOf(env: Env, orgId: string): Promise<ParserSettings> {
  const row = (await db(env).select().from(parserSettings).where(eq(parserSettings.orgId, orgId)).limit(1))[0];
  return row ?? { externalEnabled: false, mineruMode: defaultMode(env), mineruTokenSealed: null, mineruTokenHint: null };
}

/** `token`: a sealed token to store, null to remove it, undefined to keep it. */
export async function saveParserSettings(
  env: Env,
  user: SessionUser,
  patch: { externalEnabled?: boolean; mineruMode?: "agent" | "token"; token?: { sealed: string; hint: string } | null },
): Promise<void> {
  const current = await parserSettingsOf(env, user.orgId);
  const next = {
    externalEnabled: patch.externalEnabled ?? current.externalEnabled,
    mineruMode: patch.mineruMode ?? current.mineruMode,
    mineruTokenSealed: patch.token === undefined ? current.mineruTokenSealed : (patch.token?.sealed ?? null),
    mineruTokenHint: patch.token === undefined ? current.mineruTokenHint : (patch.token?.hint ?? null),
    updatedAt: Date.now(),
    updatedBy: user.id,
  };
  await db(env)
    .insert(parserSettings)
    .values({ orgId: user.orgId, ...next })
    .onConflictDoUpdate({ target: parserSettings.orgId, set: next });
}

export function effectiveMode(env: Env, settings: ParserSettings): MineruMode {
  if (env.PARSER_MINERU_MODE === "stub") {
    if (env.ENVIRONMENT === "production") throw new Error("PARSER_MINERU_MODE=stub is for tests only");
    return "stub";
  }
  return settings.mineruMode;
}

/** The external parser pages may go to, or null while the admin switch is off. */
export async function externalParserFor(env: Env, settings: ParserSettings, f: typeof fetch = fetch): Promise<ExternalParser | null> {
  if (!settings.externalEnabled) return null;
  const mode = effectiveMode(env, settings);
  if (mode === "stub") return stubParser();
  if (mode === "agent") return agentParser(f);
  const token = settings.mineruTokenSealed ? await openSecret(settings.mineruTokenSealed, secret(env, "AI_CONFIG_KEY")) : env.MINERU_API_TOKEN;
  if (!token) throw new HttpError(503, "PARSER_NOT_CONFIGURED", "外部解析服务选了精准接口但没有 Token，请管理员在后台填写 · The precise API needs a MinerU token");
  return tokenParser(token, f);
}

/** Calendar day in China (UTC+8): the daily limits reset at local midnight. */
export const chinaDay = (ms = Date.now()) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);

export interface ParseUsed {
  bookAutoPages: number;
  bookCostFen: number;
  userDayPages: number;
  siteDayPages: number;
}

/** Pages already sent: for this book (auto), by this teacher today, and by everyone today. One query. */
export async function parseUsed(env: Env, userId: string, documentId: string, day = chinaDay()): Promise<ParseUsed> {
  const row = (
    await db(env)
      .select({
        bookAutoPages: sql<number>`coalesce(sum(case when ${parseUsage.documentId} = ${documentId} and ${parseUsage.reason} = 'auto' then ${parseUsage.pageCount} end), 0)`,
        bookCostFen: sql<number>`coalesce(sum(case when ${parseUsage.documentId} = ${documentId} then ${parseUsage.costFen} end), 0)`,
        userDayPages: sql<number>`coalesce(sum(case when ${parseUsage.day} = ${day} and ${parseUsage.userId} = ${userId} then ${parseUsage.pageCount} end), 0)`,
        siteDayPages: sql<number>`coalesce(sum(case when ${parseUsage.day} = ${day} then ${parseUsage.pageCount} end), 0)`,
      })
      .from(parseUsage)
      .where(sql`${parseUsage.day} = ${day} or ${parseUsage.documentId} = ${documentId}`)
  )[0];
  return row ?? { bookAutoPages: 0, bookCostFen: 0, userDayPages: 0, siteDayPages: 0 };
}

/** For the admin page: pages sent today, site-wide and in this organisation. */
export async function parseUsageToday(env: Env, orgId: string): Promise<{ site: number; org: number }> {
  const day = chinaDay();
  const row = (
    await db(env)
      .select({
        site: sql<number>`coalesce(sum(${parseUsage.pageCount}), 0)`,
        org: sql<number>`coalesce(sum(case when ${parseUsage.orgId} = ${orgId} then ${parseUsage.pageCount} end), 0)`,
      })
      .from(parseUsage)
      .where(and(eq(parseUsage.day, day)))
  )[0];
  return row ?? { site: 0, org: 0 };
}

export type Refusal = { status: 429 | 402; code: "PARSE_QUOTA" | "PARSE_BUDGET"; scope: "book" | "user" | "site"; remaining: number };

/**
 * Whether `pages` more pages may be sent. Pure. Must-fix pages count against the book's automatic allowance;
 * pages the teacher asks for do not. Paid parsers (cost > 0) also stop at the per-book cost cap.
 */
export function parseAllowance(used: ParseUsed, req: { pages: number; reason: "auto" | "refine"; costFen: number }): Refusal | null {
  const quota = (scope: Refusal["scope"], left: number): Refusal | null => (req.pages > left ? { status: 429, code: "PARSE_QUOTA", scope, remaining: Math.max(0, left) } : null);
  return (
    (req.reason === "auto" ? quota("book", PARSE_LIMITS.bookAutoPages - used.bookAutoPages) : null) ??
    quota("user", PARSE_LIMITS.userDayPages - used.userDayPages) ??
    quota("site", PARSE_LIMITS.siteDayPages - used.siteDayPages) ??
    (req.costFen > 0 && used.bookCostFen + req.costFen > PARSE_LIMITS.bookCostFen ? { status: 402, code: "PARSE_BUDGET", scope: "book", remaining: Math.max(0, PARSE_LIMITS.bookCostFen - used.bookCostFen) } : null)
  );
}
