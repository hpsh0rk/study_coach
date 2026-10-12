import { and, eq, ne } from "drizzle-orm";
import { createAiLayer, openSecret, type AiConfig } from "@kj/ai";
import { db } from "./db/index.ts";
import { aiCalls, aiProviders } from "./db/schema.ts";
import { secret, type Env } from "./env.ts";

/** Provider, model and API key all come from the admin backend (D1), never from env vars. */
export async function loadAiConfig(env: Env, orgId: string): Promise<AiConfig> {
  const p = (await db(env).select().from(aiProviders).where(and(eq(aiProviders.orgId, orgId), eq(aiProviders.enabled, true), ne(aiProviders.model, ""))).limit(1))[0];
  if (!p) return { active: null };
  return { active: { provider: { id: p.id, kind: p.kind, name: p.name, baseUrl: p.baseUrl, apiKey: await openSecret(p.apiKeySealed, secret(env, "AI_CONFIG_KEY")) }, model: p.model } };
}

/** Model time per HTTP request, all calls and retries together; below DRAFT_LOCK_MS so a slow model never outlives its lock. */
export const MODEL_DEADLINE_MS = 120_000;

/**
 * `live`: a provider is configured. `stub`: none, and the deterministic templates answer instead
 * (dev/CI/demo) — the UI says so on every page. `off`: none and no stub, generation fails.
 */
export async function aiMode(env: Env, orgId: string): Promise<"live" | "stub" | "off"> {
  const p = (await db(env).select({ id: aiProviders.id }).from(aiProviders).where(and(eq(aiProviders.orgId, orgId), eq(aiProviders.enabled, true), ne(aiProviders.model, ""))).limit(1))[0];
  return p ? "live" : env.AI_ALLOW_STUB === "true" ? "stub" : "off";
}

export function makeAi(env: Env, orgId: string) {
  return createAiLayer({
    deadlineMs: MODEL_DEADLINE_MS,
    config: { load: () => loadAiConfig(env, orgId) },
    meter: {
      async record(r) {
        await db(env)
          .insert(aiCalls)
          .values({
            id: r.id,
            orgId: r.ctx.orgId,
            userId: r.ctx.userId,
            lessonId: r.ctx.lessonId ?? null,
            capability: r.capability,
            promptVersion: r.promptVersion,
            providerId: r.providerId,
            model: r.model,
            status: r.status,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            latencyMs: r.latencyMs,
            error: r.error ?? null,
          });
      },
    },
    allowStubFallback: env.AI_ALLOW_STUB === "true",
  });
}
