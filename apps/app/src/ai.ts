import { eq } from "drizzle-orm";
import { createAiLayer, openSecret, type AiConfig, type CapabilityRoute } from "@kj/ai";
import { db } from "./auth/session.ts";
import { aiCalls, aiProviders, aiRoutes } from "./db/schema.ts";
import { secret, type Env } from "./env.ts";

/** Provider, model and API key all come from the admin backend (D1), never from env vars. */
export async function loadAiConfig(env: Env, orgId: string): Promise<AiConfig> {
  const d = db(env);
  const [providers, routes] = await Promise.all([
    d.select().from(aiProviders).where(eq(aiProviders.orgId, orgId)),
    d.select().from(aiRoutes).where(eq(aiRoutes.orgId, orgId)),
  ]);
  const key = secret(env, "AI_CONFIG_KEY");
  return {
    providers: await Promise.all(
      providers.map(async (p) => ({ id: p.id, kind: p.kind, name: p.name, baseUrl: p.baseUrl, apiKey: await openSecret(p.apiKeySealed, key), enabled: p.enabled })),
    ),
    routes: Object.fromEntries(
      routes.map((r): [string, CapabilityRoute] => [
        r.capability,
        {
          primary: { providerId: r.primaryProviderId, model: r.primaryModel },
          ...(r.fallbackProviderId && r.fallbackModel ? { fallback: { providerId: r.fallbackProviderId, model: r.fallbackModel } } : {}),
          ...(r.temperature != null ? { temperature: r.temperature } : {}),
        },
      ]),
    ),
  };
}

export function makeAi(env: Env, orgId: string) {
  return createAiLayer({
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
