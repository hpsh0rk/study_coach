import type { ProjectDO } from "./do/project-do.ts";
import type { UserGateDO } from "./do/user-gate-do.ts";
import type { GenerateParams } from "./workflows/generate.ts";
import type { IngestParams } from "./workflows/ingest.ts";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  PROJECT: DurableObjectNamespace<ProjectDO>;
  USER_GATE: DurableObjectNamespace<UserGateDO>;
  INGEST_WF: Workflow<IngestParams>;
  GENERATE_WF: Workflow<GenerateParams>;

  ENVIRONMENT: string;
  PARSER: string;
  HEAVY_URL?: string;
  HEAVY_ENGINE?: string;
  CALLBACK_BASE_URL?: string;
  AI_ALLOW_STUB?: string;
  AI_CONFIG_KEY?: string;
  INTERNAL_SECRET?: string;
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
export function secret(env: Env, name: "AI_CONFIG_KEY" | "INTERNAL_SECRET"): string {
  const value = env[name];
  if (value) return value;
  if (env.ENVIRONMENT === "development" || env.ENVIRONMENT === "test") return `${DEV_FALLBACK}:${name}`;
  throw new Error(`${name} secret is not set (wrangler secret put ${name})`);
}
