import { eq, sql } from "drizzle-orm";
import { openSecret } from "@kj/ai";
import { db } from "../../db/index.ts";
import { secret, type Env, type SessionUser } from "../../env.ts";
import { parserSettings, parseUsage } from "../tables.ts";
import { MINERU_AGENT_PARSER, MINERU_PARSER } from "@kj/textbook";
import { agentParser, checkConnection, selfhostParser, stubParser, tokenParser, type ExternalParser, type MineruMode } from "./mineru.ts";

export { maskUrl, normalizeBaseUrl } from "./mineru.ts";

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

export type ExternalChoice = "auto" | "on" | "off";
export type MineruApi = "agent" | "token" | "selfhost";
type Sealed = { sealed: string; hint: string };

export interface ParserSettings {
  externalChoice: ExternalChoice;
  mineruMode: MineruApi;
  mineruTokenSealed: string | null;
  mineruTokenHint: string | null;
  selfhostUrlSealed: string | null;
  selfhostUrlHint: string | null;
  selfhostKeySealed: string | null;
  selfhostKeyHint: string | null;
  paidEnabled: boolean;
  monthlyBudgetMicroYuan: number;
  visionPriceMicroYuan: number | null;
}

/** Sealed values: an object to store, null to remove, undefined to keep. */
export interface SettingsPatch {
  externalChoice?: ExternalChoice;
  mineruMode?: MineruApi;
  token?: Sealed | null;
  selfhostUrl?: Sealed | null;
  selfhostKey?: Sealed | null;
  paidEnabled?: boolean;
  monthlyBudgetMicroYuan?: number;
  /** null: back to the list price. */
  visionPriceMicroYuan?: number | null;
}

function defaultMode(env: Env): MineruApi {
  return env.PARSER_MINERU_MODE === "token" || env.PARSER_MINERU_MODE === "selfhost" ? env.PARSER_MINERU_MODE : "agent";
}

export async function parserSettingsOf(env: Env, orgId: string): Promise<ParserSettings> {
  const row = (await db(env).select().from(parserSettings).where(eq(parserSettings.orgId, orgId)).limit(1))[0];
  return (
    row ?? {
      externalChoice: "auto",
      mineruMode: defaultMode(env),
      mineruTokenSealed: null,
      mineruTokenHint: null,
      selfhostUrlSealed: null,
      selfhostUrlHint: null,
      selfhostKeySealed: null,
      selfhostKeyHint: null,
      paidEnabled: false,
      monthlyBudgetMicroYuan: 0,
      visionPriceMicroYuan: null,
    }
  );
}

const keep = (patch: Sealed | null | undefined, sealed: string | null, hint: string | null): [string | null, string | null] =>
  patch === undefined ? [sealed, hint] : patch === null ? [null, null] : [patch.sealed, patch.hint];

export async function saveParserSettings(env: Env, user: SessionUser, patch: SettingsPatch): Promise<void> {
  const current = await parserSettingsOf(env, user.orgId);
  const [mineruTokenSealed, mineruTokenHint] = keep(patch.token, current.mineruTokenSealed, current.mineruTokenHint);
  const [selfhostUrlSealed, selfhostUrlHint] = keep(patch.selfhostUrl, current.selfhostUrlSealed, current.selfhostUrlHint);
  const [selfhostKeySealed, selfhostKeyHint] = keep(patch.selfhostKey, current.selfhostKeySealed, current.selfhostKeyHint);
  const next = {
    externalChoice: patch.externalChoice ?? current.externalChoice,
    mineruMode: patch.mineruMode ?? current.mineruMode,
    mineruTokenSealed,
    mineruTokenHint,
    selfhostUrlSealed,
    selfhostUrlHint,
    selfhostKeySealed,
    selfhostKeyHint,
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

/**
 * `stub` (tests and E2E) replaces MinerU's online APIs only: a self-hosted server is whatever URL the admin
 * entered, which in tests is a local mock.
 */
export function effectiveMode(env: Env, settings: ParserSettings): MineruMode {
  if (env.PARSER_MINERU_MODE === "stub" && settings.mineruMode !== "selfhost") {
    if (env.ENVIRONMENT === "production") throw new Error("PARSER_MINERU_MODE=stub is for tests only");
    return "stub";
  }
  return settings.mineruMode;
}

/** What the chosen API still lacks: `token` (precise API), `url` (self-hosted), or null when it can run. */
export function missingConfig(env: Env, settings: ParserSettings): "token" | "url" | null {
  const mode = effectiveMode(env, settings);
  if (mode === "token" && !settings.mineruTokenSealed && !env.MINERU_API_TOKEN) return "token";
  if (mode === "selfhost" && !settings.selfhostUrlSealed) return "url";
  return null;
}

/**
 * Whether pages may go to the external parser: `off` when the admin turned it off, `unconfigured` when the
 * chosen API lacks its token or URL, else `on` (`auto` means on once configured).
 */
export type ExternalState = { state: "on" } | { state: "off" } | { state: "unconfigured"; missing: "token" | "url" };

export function externalState(env: Env, settings: ParserSettings): ExternalState {
  if (settings.externalChoice === "off") return { state: "off" };
  const missing = missingConfig(env, settings);
  return missing ? { state: "unconfigured", missing } : { state: "on" };
}

/** The parser for the chosen API, ignoring the on/off choice (the admin's connection test uses it too); null while unconfigured. */
export async function configuredParser(env: Env, settings: ParserSettings, f: typeof fetch = fetch): Promise<ExternalParser | null> {
  if (missingConfig(env, settings)) return null;
  const mode = effectiveMode(env, settings);
  const key = secret(env, "AI_CONFIG_KEY");
  if (mode === "stub") return stubParser();
  if (mode === "agent") return agentParser(f);
  if (mode === "selfhost") {
    const url = await openSecret(settings.selfhostUrlSealed!, key);
    return selfhostParser(url, settings.selfhostKeySealed ? await openSecret(settings.selfhostKeySealed, key) : null, f);
  }
  return tokenParser(settings.mineruTokenSealed ? await openSecret(settings.mineruTokenSealed, key) : env.MINERU_API_TOKEN!, f);
}

/** "测试连接" for the chosen API, whether or not the switch is on. Sends no page. */
export async function testExternalConnection(env: Env, settings: ParserSettings, f: typeof fetch = fetch): Promise<{ ok: boolean; message: string }> {
  const missing = missingConfig(env, settings);
  if (missing) {
    return { ok: false, message: missing === "url" ? "还没有填写自部署 MinerU 的地址 · No self-hosted URL yet" : "还没有填写 MinerU Token · No token yet" };
  }
  const parser = (await configuredParser(env, settings, f))!;
  const mode = effectiveMode(env, settings);
  const token =
    mode === "token" ? (settings.mineruTokenSealed ? await openSecret(settings.mineruTokenSealed, secret(env, "AI_CONFIG_KEY")) : (env.MINERU_API_TOKEN ?? null)) : null;
  return checkConnection(mode, parser, token, f);
}

/** The external parser pages may go to, or null while it is off or not configured. */
export async function externalParserFor(env: Env, settings: ParserSettings, f: typeof fetch = fetch): Promise<ExternalParser | null> {
  return externalState(env, settings).state === "on" ? configuredParser(env, settings, f) : null;
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

/** MinerU's free daily allowance (online APIs) is what the site-wide limit protects; vision pages and a self-hosted server do not use it. */
const isMineruRow = sql`${parseUsage.parser} in (${MINERU_AGENT_PARSER}, ${MINERU_PARSER})`;

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
