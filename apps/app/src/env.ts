export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  ENVIRONMENT: string;
  AI_ALLOW_STUB?: string;
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

const DEV_FALLBACK = "kj-local-development-only";

/** Local dev works without .dev.vars; anything else must set real secrets. */
export function secret(env: Env, name: "AI_CONFIG_KEY"): string {
  const value = env[name];
  if (value) return value;
  if (env.ENVIRONMENT === "development" || env.ENVIRONMENT === "test") return `${DEV_FALLBACK}:${name}`;
  throw new Error(`${name} secret is not set (wrangler secret put ${name})`);
}
