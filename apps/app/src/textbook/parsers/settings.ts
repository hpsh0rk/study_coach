import { eq, sql } from "drizzle-orm";
import { openSecret } from "@kj/ai";
import { db } from "../../db/index.ts";
import { secret, type Env, type SessionUser } from "../../env.ts";
import { HttpError } from "../../http.ts";
import { parserSettings, parseUsage } from "../tables.ts";
import { agentParser, stubParser, tokenParser, type ExternalParser, type MineruMode } from "./mineru.ts";

/** Guardrails on pages sent to external parsers and vision models (pdf-parsing research §7.6). Money in micro-yuan. */
export const PARSE_LIMITS = { bookAutoPages: 300, userDayPages: 300, siteDayPages: 900, bookCostMicroYuan: 5_000_000 } as const;

/** List prices per page image (research §3.3: about 1,200 tokens in and 1,000 out), in micro-yuan. */
export const VISION_PRICES: Readonly<Record<string, number>> = {
  "glm-4.6v-flash": 0,
  "glm-4.6v-flashx": 1_700,
  "glm-4.6v": 4_200,
  "qwen-vl-ocr": 900,
  "qwen3-vl-flash": 1_700,
  "qwen3-vl-plus": 11_000,
};
/** A model not in the list is priced like the dearest one: paid, so it stays off until an admin allows paid parsing or enters its price. */
export const UNKNOWN_VISION_PRICE = 11_000;

export interface ParserSettings {
  externalEnabled: boolean;
  mineruMode: "agent" | "token";
  mineruTokenSealed: string | null;
  mineruTokenHint: string | null;
  paidEnabled: boolean;
  monthlyBudgetMicroYuan: number;
  visionPriceMicroYuan: number | null;
}

export interface SettingsPatch {
  externalEnabled?: boolean;
  mineruMode?: "agent" | "token";
  /** A sealed token to store, null to remove it, undefined to keep it. */
  token?: { sealed: string; hint: string } | null;
  paidEnabled?: boolean;
  monthlyBudgetMicroYuan?: number;
  /** null: back to the list price. */
  visionPriceMicroYuan?: number | null;
}

function defaultMode(env: Env): "agent" | "token" {
  return env.PARSER_MINERU_MODE === "token" ? "token" : "agent";
}

export async function parserSettingsOf(env: Env, orgId: string): Promise<ParserSettings> {
  const row = (await db(env).select().from(parserSettings).where(eq(parserSettings.orgId, orgId)).limit(1))[0];
  return (
    row ?? {
      externalEnabled: false,
      mineruMode: defaultMode(env),
      mineruTokenSealed: null,
      mineruTokenHint: null,
      paidEnabled: false,
      monthlyBudgetMicroYuan: 0,
      visionPriceMicroYuan: null,
    }
  );
}

export async function saveParserSettings(env: Env, user: SessionUser, patch: SettingsPatch): Promise<void> {
  const current = await parserSettingsOf(env, user.orgId);
  const next = {
    externalEnabled: patch.externalEnabled ?? current.externalEnabled,
    mineruMode: patch.mineruMode ?? current.mineruMode,
    mineruTokenSealed: patch.token === undefined ? current.mineruTokenSealed : (patch.token?.sealed ?? null),
    mineruTokenHint: patch.token === undefined ? current.mineruTokenHint : (patch.token?.hint ?? null),
    paidEnabled: patch.paidEnabled ?? current.paidEnabled,
    monthlyBudgetMicroYuan: patch.monthlyBudgetMicroYuan ?? current.monthlyBudgetMicroYuan,
    visionPriceMicroYuan: patch.visionPriceMicroYuan === undefined ? current.visionPriceMicroYuan : patch.visionPriceMicroYuan,
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

export interface VisionPrice {
  microYuanPerPage: number;
  /** `admin`: entered in the backend. `list`: VISION_PRICES. `unknown`: priced as the dearest listed model. */
  source: "admin" | "list" | "unknown";
}

export function visionPriceOf(model: string, settings: ParserSettings): VisionPrice {
  if (settings.visionPriceMicroYuan !== null) return { microYuanPerPage: settings.visionPriceMicroYuan, source: "admin" };
  const listed = VISION_PRICES[model.toLowerCase()];
  return listed === undefined ? { microYuanPerPage: UNKNOWN_VISION_PRICE, source: "unknown" } : { microYuanPerPage: listed, source: "list" };
}

/** Calendar day in China (UTC+8): the daily limits reset at local midnight, the monthly budget on the 1st. */
export const chinaDay = (ms = Date.now()) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
const monthStart = (day: string) => `${day.slice(0, 7)}-01`;

/** MinerU's free daily allowance is what the site-wide limit protects; vision pages do not use it. */
const isMineruRow = sql`${parseUsage.parser} like 'mineru%'`;

export interface ParseUsed {
  bookAutoPages: number;
  bookCostMicroYuan: number;
  userDayPages: number;
  siteDayPages: number;
  orgMonthCostMicroYuan: number;
}

/** Pages and money already spent: on this book, by this teacher today, MinerU pages site-wide today, and this organisation this month. One query. */
export async function parseUsed(env: Env, user: SessionUser, documentId: string, day = chinaDay()): Promise<ParseUsed> {
  const row = (
    await db(env)
      .select({
        bookAutoPages: sql<number>`coalesce(sum(case when ${parseUsage.documentId} = ${documentId} and ${parseUsage.reason} = 'auto' then ${parseUsage.pageCount} end), 0)`,
        bookCostMicroYuan: sql<number>`coalesce(sum(case when ${parseUsage.documentId} = ${documentId} then ${parseUsage.costMicroYuan} end), 0)`,
        userDayPages: sql<number>`coalesce(sum(case when ${parseUsage.day} = ${day} and ${parseUsage.userId} = ${user.id} then ${parseUsage.pageCount} end), 0)`,
        siteDayPages: sql<number>`coalesce(sum(case when ${parseUsage.day} = ${day} and ${isMineruRow} then ${parseUsage.pageCount} end), 0)`,
        orgMonthCostMicroYuan: sql<number>`coalesce(sum(case when ${parseUsage.day} >= ${monthStart(day)} and ${parseUsage.orgId} = ${user.orgId} then ${parseUsage.costMicroYuan} end), 0)`,
      })
      .from(parseUsage)
      .where(sql`${parseUsage.day} >= ${monthStart(day)} or ${parseUsage.documentId} = ${documentId}`)
  )[0];
  return row ?? { bookAutoPages: 0, bookCostMicroYuan: 0, userDayPages: 0, siteDayPages: 0, orgMonthCostMicroYuan: 0 };
}

/** For the admin page: MinerU pages today site-wide, pages today in this organisation, and its spend this month. */
export async function parseUsageToday(env: Env, orgId: string): Promise<{ site: number; org: number; monthCostMicroYuan: number }> {
  const day = chinaDay();
  const row = (
    await db(env)
      .select({
        site: sql<number>`coalesce(sum(case when ${parseUsage.day} = ${day} and ${isMineruRow} then ${parseUsage.pageCount} end), 0)`,
        org: sql<number>`coalesce(sum(case when ${parseUsage.day} = ${day} and ${parseUsage.orgId} = ${orgId} then ${parseUsage.pageCount} end), 0)`,
        monthCostMicroYuan: sql<number>`coalesce(sum(case when ${parseUsage.orgId} = ${orgId} then ${parseUsage.costMicroYuan} end), 0)`,
      })
      .from(parseUsage)
      .where(sql`${parseUsage.day} >= ${monthStart(day)}`)
  )[0];
  return row ?? { site: 0, org: 0, monthCostMicroYuan: 0 };
}

export type Refusal =
  | { status: 429; code: "PARSE_QUOTA"; scope: "book" | "user" | "site"; remaining: number }
  | { status: 402; code: "PARSE_BUDGET"; scope: "off" | "month" | "book"; remaining: number };

/**
 * Whether `pages` more pages may be sent. Pure. Must-fix pages count against the book's automatic allowance;
 * pages the teacher asks for do not. Only MinerU pages count against the site-wide day. A paid request
 * (cost > 0) needs "允许付费兜底" on, and stays within the organisation's monthly budget and the per-book cap.
 */
export function parseAllowance(
  used: ParseUsed,
  req: { pages: number; reason: "auto" | "refine"; costMicroYuan: number; mineru: boolean },
  budget: Pick<ParserSettings, "paidEnabled" | "monthlyBudgetMicroYuan">,
): Refusal | null {
  const quota = (scope: "book" | "user" | "site", left: number): Refusal | null => (req.pages > left ? { status: 429, code: "PARSE_QUOTA", scope, remaining: Math.max(0, left) } : null);
  const money = (scope: "off" | "month" | "book", left: number): Refusal | null =>
    req.costMicroYuan > left ? { status: 402, code: "PARSE_BUDGET", scope, remaining: Math.max(0, left) } : null;
  return (
    (req.reason === "auto" ? quota("book", PARSE_LIMITS.bookAutoPages - used.bookAutoPages) : null) ??
    quota("user", PARSE_LIMITS.userDayPages - used.userDayPages) ??
    (req.mineru ? quota("site", PARSE_LIMITS.siteDayPages - used.siteDayPages) : null) ??
    (req.costMicroYuan > 0
      ? (budget.paidEnabled ? null : money("off", 0)) ??
        money("month", budget.monthlyBudgetMicroYuan - used.orgMonthCostMicroYuan) ??
        money("book", PARSE_LIMITS.bookCostMicroYuan - used.bookCostMicroYuan)
      : null)
  );
}

export function refusalMessage(r: Refusal, what: string): string {
  if (r.code === "PARSE_BUDGET") {
    return {
      off: `${what}要付费，管理员还没有开启“允许付费兜底” · Paid parsing is off`,
      month: "本月的付费解析预算用完了，请管理员调整预算 · This month's parsing budget is used up",
      book: "这本书的付费解析费用已到上限（5 元）· This book reached its parsing budget",
    }[r.scope];
  }
  return { book: `这本书自动送去${what}的页数已到上限`, user: `你今天的${what}额度用完了，明天再试`, site: `本站今天的${what}额度用完了，明天再试` }[r.scope] + " · Parsing quota reached";
}
