import { newId } from "@kj/schema";
import { CAPABILITIES, type CapabilityInput, type CapabilityName, type CapabilityOutput } from "./capabilities.ts";
import { chatCompletion, ProviderError, type AiConfigSource, type ChatMessage, type FetchLike, type ProviderConfig, type RouteTarget } from "./providers.ts";

export interface CallContext {
  orgId: string;
  userId: string;
  projectId?: string;
  gateToken?: string;
}

export interface GateVerifier {
  /** Must check the token against the project's current confirmed outline. */
  verify(projectId: string, gateToken: string): Promise<boolean>;
}

export interface AiCallRecord {
  id: string;
  capability: string;
  promptVersion: string;
  providerId: string;
  model: string;
  status: "ok" | "error" | "rejected";
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error?: string;
  ctx: CallContext;
}

export interface Meter {
  record(rec: AiCallRecord): Promise<void>;
}

export class AiGateError extends Error {
  readonly code = "OUTLINE_NOT_CONFIRMED";
  constructor(message: string) {
    super(message);
    this.name = "AiGateError";
  }
}

export class AiOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiOutputError";
  }
}

export interface AiLayerOptions {
  config: AiConfigSource;
  gate: GateVerifier;
  meter: Meter;
  fetch?: FetchLike;
  /** When no route is configured, use the deterministic stub. Off in production once providers are set. */
  allowStubFallback: boolean;
}

export interface AiResult<T> {
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

/** The single entry point for every model call in the system (red line 3). */
export function createAiLayer(opts: AiLayerOptions) {
  async function call<N extends CapabilityName>(name: N, rawInput: CapabilityInput<N>, ctx: CallContext): Promise<AiResult<CapabilityOutput<N>>> {
    const cap = CAPABILITIES[name];
    const callId = newId("ai");
    const started = Date.now();
    const base = { id: callId, capability: cap.name, promptVersion: cap.promptVersion, ctx };

    if (cap.requiresGate) {
      if (!ctx.projectId || !ctx.gateToken) {
        await opts.meter.record({ ...base, providerId: "-", model: "-", status: "rejected", inputTokens: 0, outputTokens: 0, latencyMs: 0, error: "missing gate token" });
        throw new AiGateError(`${cap.name} requires a confirmed-outline gate token`);
      }
      if (!(await opts.gate.verify(ctx.projectId, ctx.gateToken))) {
        await opts.meter.record({ ...base, providerId: "-", model: "-", status: "rejected", inputTokens: 0, outputTokens: 0, latencyMs: 0, error: "stale gate token" });
        throw new AiGateError(`${cap.name}: gate token is not valid for the current outline`);
      }
    }

    const input = cap.input.parse(rawInput) as never;
    const config = await opts.config.load();
    const route = config.routes[cap.name] ?? config.routes.default;
    const providers = new Map(config.providers.filter((p) => p.enabled).map((p) => [p.id, p]));
    const targets: { provider: ProviderConfig; target: RouteTarget }[] = [];
    for (const t of [route?.primary, route?.fallback]) {
      const provider = t && providers.get(t.providerId);
      if (t && provider) targets.push({ provider, target: t });
    }

    if (targets.length === 0) {
      if (!opts.allowStubFallback) throw new ProviderError(`no AI provider configured for ${cap.name}; configure one in /admin`, undefined, false);
      const output = cap.output.parse(cap.stub(input)) as CapabilityOutput<N>;
      await opts.meter.record({ ...base, providerId: STUB_PROVIDER_ID, model: "stub", status: "ok", inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - started });
      return { output, callId, providerId: STUB_PROVIDER_ID, model: "stub" };
    }

    let lastError: unknown;
    for (const { provider, target } of targets) {
      let inputTokens = 0;
      let outputTokens = 0;
      try {
        const messages: ChatMessage[] = cap.buildMessages(input);
        for (let attempt = 0; attempt < 2; attempt++) {
          const res = await chatCompletion(
            provider,
            { model: target.model, messages, temperature: route?.temperature ?? cap.temperature, json: true, timeoutMs: cap.timeoutMs },
            opts.fetch,
          );
          inputTokens += res.usage.inputTokens;
          outputTokens += res.usage.outputTokens;
          let problem: string;
          try {
            const parsed = cap.output.safeParse(extractJson(res.text));
            if (parsed.success) {
              await opts.meter.record({ ...base, providerId: provider.id, model: res.model, status: "ok", inputTokens, outputTokens, latencyMs: Date.now() - started });
              return { output: parsed.data as CapabilityOutput<N>, callId, providerId: provider.id, model: res.model };
            }
            problem = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
          } catch (err) {
            problem = (err as Error).message;
          }
          // One automatic repair round (plan §8), then fall through to the fallback route.
          messages.push({ role: "assistant", content: res.text }, { role: "user", content: `Your JSON was invalid: ${problem}. Return the corrected JSON object only.` });
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

  return { call };
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
