import { and, eq, sql } from "drizzle-orm";
import { openSecret } from "@kj/ai";
import { db } from "../../db/index.ts";
import { secret, type Env, type SessionUser } from "../../env.ts";
import { parserSettings, parseUsage } from "../tables.ts";
import { agentParser, checkConnection, selfhostParser, stubParser, type ExternalParser, type MineruMode } from "./mineru.ts";

export { maskUrl, normalizeBaseUrl } from "./mineru.ts";

/** Pages one teacher may send to the external parser and the vision model per day (China time), together. */
export const PARSE_DAY_PAGES = 300;

/** Vision models known to be free. Any other model may cost money per page, so it waits for "允许付费兜底". */
export const FREE_VISION_MODELS: readonly string[] = ["glm-4.6v-flash"];
export const isFreeVisionModel = (model: string) => FREE_VISION_MODELS.includes(model.trim().toLowerCase());

export type ExternalChoice = "auto" | "off";
export type MineruApi = "agent" | "selfhost";
type Sealed = { sealed: string; hint: string };

export interface ParserSettings {
  externalChoice: ExternalChoice;
  mineruMode: MineruApi;
  selfhostUrlSealed: string | null;
  selfhostUrlHint: string | null;
  selfhostKeySealed: string | null;
  selfhostKeyHint: string | null;
  paidEnabled: boolean;
}

/** Sealed values: an object to store, null to remove, undefined to keep. */
export interface SettingsPatch {
  externalChoice?: ExternalChoice;
  mineruMode?: MineruApi;
  selfhostUrl?: Sealed | null;
  selfhostKey?: Sealed | null;
  paidEnabled?: boolean;
}

function defaultMode(env: Env): MineruApi {
  return env.PARSER_MINERU_MODE === "selfhost" ? "selfhost" : "agent";
}

export async function parserSettingsOf(env: Env, orgId: string): Promise<ParserSettings> {
  const row = (await db(env).select().from(parserSettings).where(eq(parserSettings.orgId, orgId)).limit(1))[0];
  return (
    row ?? {
      externalChoice: "auto",
      mineruMode: defaultMode(env),
      selfhostUrlSealed: null,
      selfhostUrlHint: null,
      selfhostKeySealed: null,
      selfhostKeyHint: null,
      paidEnabled: false,
    }
  );
}

const keep = (patch: Sealed | null | undefined, sealed: string | null, hint: string | null): [string | null, string | null] =>
  patch === undefined ? [sealed, hint] : patch === null ? [null, null] : [patch.sealed, patch.hint];

export async function saveParserSettings(env: Env, user: SessionUser, patch: SettingsPatch): Promise<void> {
  const current = await parserSettingsOf(env, user.orgId);
  const [selfhostUrlSealed, selfhostUrlHint] = keep(patch.selfhostUrl, current.selfhostUrlSealed, current.selfhostUrlHint);
  const [selfhostKeySealed, selfhostKeyHint] = keep(patch.selfhostKey, current.selfhostKeySealed, current.selfhostKeyHint);
  const next = {
    externalChoice: patch.externalChoice ?? current.externalChoice,
    mineruMode: patch.mineruMode ?? current.mineruMode,
    selfhostUrlSealed,
    selfhostUrlHint,
    selfhostKeySealed,
    selfhostKeyHint,
    paidEnabled: patch.paidEnabled ?? current.paidEnabled,
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

/** What the chosen API still lacks: `url` (self-hosted), or null when it can run (the agent API needs nothing). */
export function missingConfig(env: Env, settings: ParserSettings): "url" | null {
  return effectiveMode(env, settings) === "selfhost" && !settings.selfhostUrlSealed ? "url" : null;
}

/**
 * Whether pages may go to the external parser: `off` when the admin turned it off, `unconfigured` when the
 * self-hosted server has no URL yet, else `on` (`auto` means on once configured).
 */
export type ExternalState = { state: "on" } | { state: "off" } | { state: "unconfigured"; missing: "url" };

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
  const url = await openSecret(settings.selfhostUrlSealed!, key);
  return selfhostParser(url, settings.selfhostKeySealed ? await openSecret(settings.selfhostKeySealed, key) : null, f);
}

/** "测试连接" for the chosen API, whether or not the switch is on. Sends no page. */
export async function testExternalConnection(env: Env, settings: ParserSettings, f: typeof fetch = fetch): Promise<{ ok: boolean; message: string }> {
  if (missingConfig(env, settings)) return { ok: false, message: "还没有填写自部署 MinerU 的地址 · No self-hosted URL yet" };
  return checkConnection(effectiveMode(env, settings), (await configuredParser(env, settings, f))!, f);
}

/** The external parser pages may go to, or null while it is off or not configured. */
export async function externalParserFor(env: Env, settings: ParserSettings, f: typeof fetch = fetch): Promise<ExternalParser | null> {
  return externalState(env, settings).state === "on" ? configuredParser(env, settings, f) : null;
}

/** Calendar day in China (UTC+8): the daily limit resets at local midnight. */
export const chinaDay = (ms = Date.now()) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);

/** Pages a teacher sent today (external parser and vision model), or (no userId) the whole organisation. */
export async function parsedPagesToday(env: Env, orgId: string, userId?: string, day = chinaDay()): Promise<number> {
  const row = (
    await db(env)
      .select({ n: sql<number>`coalesce(sum(${parseUsage.pageCount}), 0)` })
      .from(parseUsage)
      .where(and(eq(parseUsage.orgId, orgId), eq(parseUsage.day, day), userId ? eq(parseUsage.userId, userId) : undefined))
  )[0];
  return row?.n ?? 0;
}

export type Refusal = { status: 429; code: "PARSE_QUOTA"; remaining: number } | { status: 402; code: "PARSE_BUDGET" };

/** Whether `pages` more pages may be sent. Pure. A paid model (vision only) needs "允许付费兜底" on. */
export function parseAllowance(usedToday: number, req: { pages: number; paid: boolean }, paidEnabled: boolean): Refusal | null {
  if (req.pages > PARSE_DAY_PAGES - usedToday) return { status: 429, code: "PARSE_QUOTA", remaining: Math.max(0, PARSE_DAY_PAGES - usedToday) };
  if (req.paid && !paidEnabled) return { status: 402, code: "PARSE_BUDGET" };
  return null;
}

export function refusalMessage(r: Refusal, what: string): string {
  if (r.code === "PARSE_BUDGET") return `${what}要付费，管理员还没有开启“允许付费兜底” · Paid parsing is off`;
  return `你今天的${what}额度（每天 ${PARSE_DAY_PAGES} 页）用完了，明天再试 · Parsing quota reached`;
}
