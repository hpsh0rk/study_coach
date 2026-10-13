import { and, count, eq, gte, ne } from "drizzle-orm";
import { createAiLayer, openSecret, STUB_PROVIDER_ID, type AiConfig, type ProviderConfig } from "@kj/ai";
import { db } from "./db/index.ts";
import { aiCalls, aiProviders } from "./db/schema.ts";
import { secret, type Env, type SessionUser } from "./env.ts";
import { HttpError } from "./http.ts";

/** Real model calls (the stub is free) per account per China day, retries included; `AI_DAILY_CALLS` overrides. A 40-slide lesson takes about 45. */
export const DAILY_MODEL_CALLS = 400;
const DAY_MS = 86_400_000;
const CHINA_MS = 8 * 3_600_000;
const chinaDayStart = (ms = Date.now()) => Math.floor((ms + CHINA_MS) / DAY_MS) * DAY_MS - CHINA_MS;
export const dailyModelCalls = (env: Env) => Number(env.AI_DAILY_CALLS) || DAILY_MODEL_CALLS;

/** Real model calls today, of one account or (no userId) the whole organisation. */
export async function modelCallsToday(env: Env, orgId: string, userId?: string): Promise<number> {
  const rows = await db(env)
    .select({ n: count() })
    .from(aiCalls)
    .where(and(eq(aiCalls.orgId, orgId), gte(aiCalls.createdAt, chinaDayStart()), ne(aiCalls.providerId, STUB_PROVIDER_ID), userId ? eq(aiCalls.userId, userId) : undefined));
  return rows[0]?.n ?? 0;
}

/** Called before an outline draft or a slide that needs the model. */
export async function assertModelAllowance(env: Env, user: SessionUser): Promise<void> {
  const cap = dailyModelCalls(env);
  const used = await modelCallsToday(env, user.orgId, user.id);
  if (used >= cap) {
    throw new HttpError(429, "DAILY_MODEL_LIMIT", `今天已经调用 AI 模型 ${used} 次，到了每人每天 ${cap} 次的上限，请明天再生成；确实不够用请联系管理员 · Daily model-call limit reached`);
  }
}

type ProviderRow = typeof aiProviders.$inferSelect;

/** The enabled provider of each purpose (at most one each). */
async function enabledProviders(env: Env, orgId: string): Promise<{ text: ProviderRow | null; vision: ProviderRow | null }> {
  const rows = await db(env)
    .select()
    .from(aiProviders)
    .where(and(eq(aiProviders.orgId, orgId), eq(aiProviders.enabled, true), ne(aiProviders.model, "")));
  return { text: rows.find((r) => r.purpose === "text") ?? null, vision: rows.find((r) => r.purpose === "vision") ?? null };
}

/** A stored provider row with its key and custom headers unsealed, ready for `@kj/ai`. Server-side only. */
export async function providerConfigOf(env: Env, p: ProviderRow): Promise<ProviderConfig> {
  const key = secret(env, "AI_CONFIG_KEY");
  return {
    id: p.id,
    kind: p.kind,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: await openSecret(p.apiKeySealed, key),
    protocol: p.protocol,
    ...(p.maxTokens ? { maxTokens: p.maxTokens } : {}),
    ...(p.headersSealed ? { headers: JSON.parse(await openSecret(p.headersSealed, key)) as Record<string, string> } : {}),
  };
}

/** Provider, model and API key all come from the admin backend (D1), never from env vars. */
export async function loadAiConfig(env: Env, orgId: string): Promise<AiConfig> {
  const { text, vision } = await enabledProviders(env, orgId);
  const config = (p: ProviderRow) => providerConfigOf(env, p);
  return {
    active: text && { provider: await config(text), model: text.model },
    vision: vision && { provider: await config(vision), model: vision.model },
  };
}

/** The model that reads page images: the enabled vision provider's, else null. */
export async function visionModelOf(env: Env, orgId: string): Promise<string | null> {
  return (await enabledProviders(env, orgId)).vision?.model || null;
}

/** Model time per HTTP request, all calls and retries together; below DRAFT_LOCK_MS so a slow model never outlives its lock. */
export const MODEL_DEADLINE_MS = 120_000;

/**
 * `live`: a provider is configured. `stub`: none, and the deterministic templates answer instead
 * (dev/CI/demo) — the UI says so on every page. `off`: none and no stub, generation fails.
 */
export async function aiMode(env: Env, orgId: string): Promise<"live" | "stub" | "off"> {
  const { text } = await enabledProviders(env, orgId);
  return text ? "live" : env.AI_ALLOW_STUB === "true" ? "stub" : "off";
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
