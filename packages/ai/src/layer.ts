import { z } from "zod";
import { newId } from "@kj/schema";
import { chatCompletion, ProviderError, type AiConfigSource, type ChatMessage, type FetchLike, type ProviderConfig, type RouteTarget } from "./providers.ts";

/** Capabilities that can be routed to a model in /admin; "default" covers anything unlisted. */
export const KNOWN_CAPABILITIES = ["outline.draft", "slide.write"] as const;
export type CapabilityName = (typeof KNOWN_CAPABILITIES)[number];

export interface CallContext {
  orgId: string;
  userId: string;
  lessonId?: string;
}

export interface AiCallRecord {
  id: string;
  capability: string;
  promptVersion: string;
  providerId: string;
  model: string;
  status: "ok" | "error";
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error?: string;
  ctx: CallContext;
}

export interface Meter {
  record(rec: AiCallRecord): Promise<void>;
}

export class AiOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiOutputError";
  }
}

export interface AiLayerOptions {
  config: AiConfigSource;
  meter: Meter;
  fetch?: FetchLike;
  /** With no provider routed, answer from the caller's deterministic stub (local dev, CI, evals). */
  allowStubFallback: boolean;
}

export interface StructuredRequest<T> {
  capability: CapabilityName;
  promptVersion: string;
  schema: z.ZodType<T>;
  messages: ChatMessage[];
  /** Deterministic answer used when no provider is configured. Must satisfy `schema`. */
  stub: () => unknown;
  temperature?: number;
  timeoutMs?: number;
  ctx: CallContext;
}

export interface StructuredResult<T> {
  output: T;
  callId: string;
  providerId: string;
  model: string;
}

export const STUB_PROVIDER_ID = "stub";

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new AiOutputError("model did not return a JSON object");
  return JSON.parse(trimmed.slice(start, end + 1));
}

export function issuesText(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/** JSON Schema shown to the model; refinements (word budgets) are restated in the prompt text. */
export function jsonSchemaOf(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
}

/** The single entry point for every model call in the system. */
export function createAiLayer(opts: AiLayerOptions) {
  async function callStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const callId = newId("ai");
    const started = Date.now();
    const base = { id: callId, capability: req.capability, promptVersion: req.promptVersion, ctx: req.ctx };

    const config = await opts.config.load();
    const route = config.routes[req.capability] ?? config.routes.default;
    const providers = new Map(config.providers.filter((p) => p.enabled).map((p) => [p.id, p]));
    const targets: { provider: ProviderConfig; target: RouteTarget }[] = [];
    for (const t of [route?.primary, route?.fallback]) {
      const provider = t && providers.get(t.providerId);
      if (t && provider) targets.push({ provider, target: t });
    }

    if (targets.length === 0) {
      if (!opts.allowStubFallback) throw new ProviderError(`no AI provider configured for ${req.capability}; configure one in /admin · 请在后台配置模型`, undefined, false);
      const output = req.schema.parse(req.stub());
      await opts.meter.record({ ...base, providerId: STUB_PROVIDER_ID, model: "stub", status: "ok", inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - started });
      return { output, callId, providerId: STUB_PROVIDER_ID, model: "stub" };
    }

    let lastError: unknown;
    for (const { provider, target } of targets) {
      let inputTokens = 0;
      let outputTokens = 0;
      try {
        const messages: ChatMessage[] = [...req.messages];
        for (let attempt = 0; attempt < 2; attempt++) {
          const res = await chatCompletion(
            provider,
            { model: target.model, messages, temperature: route?.temperature ?? req.temperature ?? 0.4, json: true, timeoutMs: req.timeoutMs ?? 90_000 },
            opts.fetch,
          );
          inputTokens += res.usage.inputTokens;
          outputTokens += res.usage.outputTokens;
          let problem: string;
          try {
            const parsed = req.schema.safeParse(extractJson(res.text));
            if (parsed.success) {
              await opts.meter.record({ ...base, providerId: provider.id, model: res.model, status: "ok", inputTokens, outputTokens, latencyMs: Date.now() - started });
              return { output: parsed.data, callId, providerId: provider.id, model: res.model };
            }
            problem = issuesText(parsed.error);
          } catch (err) {
            problem = (err as Error).message;
          }
          messages.push({ role: "assistant", content: res.text }, { role: "user", content: `Your JSON was invalid: ${problem}. Shorten or fix the offending fields and return the corrected JSON object only.` });
        }
        throw new AiOutputError(`${provider.name}/${target.model} returned invalid output twice`);
      } catch (err) {
        lastError = err;
        await opts.meter.record({ ...base, providerId: provider.id, model: target.model, status: "error", inputTokens, outputTokens, latencyMs: Date.now() - started, error: (err as Error).message.slice(0, 500) });
        if (err instanceof ProviderError && !err.retriable && err.status !== 401 && err.status !== 403) break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return { callStructured };
}

export type AiLayer = ReturnType<typeof createAiLayer>;

/** Used by the admin "test connection" button. */
export async function testProvider(provider: ProviderConfig, model: string, fetchImpl?: FetchLike): Promise<{ ok: true; model: string; latencyMs: number } | { ok: false; error: string }> {
  const started = Date.now();
  try {
    const res = await chatCompletion(
      provider,
      { model, messages: [{ role: "user", content: 'Reply with the JSON object {"ok":true}' }], json: true, timeoutMs: 20_000, temperature: 0 },
      fetchImpl,
    );
    return { ok: true, model: res.model, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
