export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  ENVIRONMENT: string;
  AI_ALLOW_STUB?: string;
  AI_DAILY_CALLS?: string;
  AI_CONFIG_KEY?: string;
  /** Default MinerU API for the "外部解析服务" setting: `agent` (token-free) or `token`; `stub` replays a recorded response (tests and E2E only). */
  PARSER_MINERU_MODE?: string;
  MINERU_API_TOKEN?: string;
}

export interface SessionUser {
  id: string;
  orgId: string;
  username: string;
  displayName: string | null;
  role: "admin" | "teacher";
  mustChangePassword: boolean;
}

export type AppBindings = { Bindings: Env; Variables: { user: SessionUser } };

const TEST_FALLBACK = "kj-vitest-only";

/** Only the vitest pool may run without the secret; local runs get a generated one from scripts/local.mjs. */
export function secret(env: Env, name: "AI_CONFIG_KEY"): string {
  const value = env[name];
  if (value) return value;
  if (env.ENVIRONMENT === "test") return `${TEST_FALLBACK}:${name}`;
  throw new Error(`${name} secret is not set: start locally with pnpm dev / pnpm start:local, or run wrangler secret put ${name}`);
}
