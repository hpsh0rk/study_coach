import { z } from "zod";
import { newId } from "@kj/schema";
import { chatCompletion, ProviderError, type AiConfigSource, type ChatMessage, type ChatRequest, type FetchLike, type ProviderConfig } from "./providers.ts";

/** What a call is for; recorded with every call for metering. */
export type CapabilityName = "outline.draft" | "slide.write" | "page.read";

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
  /** With no provider configured, answer from the caller's deterministic stub (local dev, CI, evals). */
  allowStubFallback: boolean;
  /**
   * Total model time for every call made through this layer (one layer per HTTP request): each call,
   * retries included, gets at most what is left, so a request ends well inside the Worker and draft-lock limits.
   */
  deadlineMs?: number;
}

/** A call is not started with less than this left of the request deadline. */
const MIN_CALL_MS = 5_000;

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

export interface VisionRequest {
  capability: CapabilityName;
  promptVersion: string;
  instructions: string;
  /** `data:image/jpeg;base64,…` (or png / webp). */
  image: string;
  maxTokens?: number;
  timeoutMs?: number;
  ctx: CallContext;
}

export interface VisionResult {
  text: string;
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
const jsonSchemas = new WeakMap<z.ZodType, unknown>();

/** JSON Schema of a zod schema, computed once per schema object (Workers CPU budget). */
export function jsonSchemaOf(schema: z.ZodType): unknown {
  let json = jsonSchemas.get(schema);
  if (json === undefined) jsonSchemas.set(schema, (json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" })));
  return json;
}

/** The single entry point for every model call in the system. */
export function createAiLayer(opts: AiLayerOptions) {
  const deadline = opts.deadlineMs === undefined ? Infinity : Date.now() + opts.deadlineMs;
  const timeoutFor = (wanted: number): number => {
    const left = deadline - Date.now();
    if (left < MIN_CALL_MS) throw new ProviderError("模型调用超出本次请求的时间上限，请稍后重试 · The model took too long for this request; try again", 504);
    return Math.min(wanted, left);
  };

  async function callStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const callId = newId("ai");
    const started = Date.now();
    const base = { id: callId, capability: req.capability, promptVersion: req.promptVersion, ctx: req.ctx };

    const { active } = await opts.config.load();
    if (!active) {
      if (!opts.allowStubFallback) throw new ProviderError("no AI provider configured; configure one in /admin · 请在后台配置模型", undefined, false);
      const output = req.schema.parse(req.stub());
      await opts.meter.record({ ...base, providerId: STUB_PROVIDER_ID, model: "stub", status: "ok", inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - started });
      return { output, callId, providerId: STUB_PROVIDER_ID, model: "stub" };
    }

    const { provider, model } = active;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const messages: ChatMessage[] = [...req.messages];
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await chatCompletion(provider, { model, messages, temperature: req.temperature ?? 0.4, json: true, timeoutMs: timeoutFor(req.timeoutMs ?? 90_000) }, opts.fetch);
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
      throw new AiOutputError(`${provider.name}/${model} returned invalid output twice`);
    } catch (err) {
      await opts.meter.record({ ...base, providerId: provider.id, model, status: "error", inputTokens, outputTokens, latencyMs: Date.now() - started, error: (err as Error).message.slice(0, 500) });
      throw err;
    }
  }

  /**
   * One image and an instruction to the provider's vision model; plain text back. Never stubbed: a made-up
   * transcription would pass for the page. Without a vision model configured it refuses.
   */
  async function callVision(req: VisionRequest): Promise<VisionResult> {
    const callId = newId("ai");
    const started = Date.now();
    const base = { id: callId, capability: req.capability, promptVersion: req.promptVersion, ctx: req.ctx };
    const target = (await opts.config.load()).vision;
    if (!target) throw new ProviderError("no vision model configured; set one in /admin · 请在后台“AI 模型”里配置看图模型", undefined, false);
    const { provider, model } = target;
    try {
      const res = await chatCompletion(
        provider,
        {
          model,
          messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: req.image } }, { type: "text", text: req.instructions }] }],
          temperature: 0,
          maxTokens: req.maxTokens ?? 4096,
          timeoutMs: timeoutFor(req.timeoutMs ?? 90_000),
        },
        opts.fetch,
      );
      await opts.meter.record({ ...base, providerId: provider.id, model: res.model, status: "ok", inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, latencyMs: Date.now() - started });
      return { text: res.text, callId, providerId: provider.id, model: res.model };
    } catch (err) {
      await opts.meter.record({ ...base, providerId: provider.id, model, status: "error", inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - started, error: (err as Error).message.slice(0, 500) });
      throw err;
    }
  }

  return { callStructured, callVision };
}

export type AiLayer = ReturnType<typeof createAiLayer>;

/** What the admin "测试连接" shows: OK with latency and the start of the reply, or which of the usual problems it is. */
export type ConnectionTest =
  | { ok: true; model: string; latencyMs: number; reply: string; message: string }
  | { ok: false; kind: "auth" | "model" | "unreachable" | "empty" | "http"; status?: number; latencyMs: number; error: string; message: string };

const MODEL_PROBLEM = /model[_ ]?not[_ ]?found|unknown model|invalid model|model .*(not exist|does not exist|not found|not supported|invalid)|模型.*(不存在|无效|不支持)/i;

/** Plain-Chinese reading of a failed test call. */
export function classifyTestFailure(err: unknown, provider: ProviderConfig, model: string): { kind: "auth" | "model" | "unreachable" | "empty" | "http"; status?: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const status = err instanceof ProviderError ? err.status : undefined;
  if (status === undefined) {
    const timedOut = /timeout|timed out|aborted/i.test(raw);
    return {
      kind: "unreachable",
      message: timedOut
        ? `连不上：${provider.baseUrl} 在规定时间内没有回应。请检查 Base URL，以及这台服务器能否访问它。`
        : `连不上：访问 ${provider.baseUrl} 失败（网络不通、地址写错或服务没开）。请检查 Base URL。`,
    };
  }
  if (status === 401 || status === 403) return { kind: "auth", status, message: `Key 不对或没有权限（HTTP ${status}）：请检查 API Key${provider.headers ? "和自定义请求头" : ""}。` };
  if (MODEL_PROBLEM.test(raw) || status === 404)
    return {
      kind: "model",
      status,
      message: MODEL_PROBLEM.test(raw) ? `模型名不对：服务端不认识“${model}”（HTTP ${status}）。请检查模型名。` : `找不到（HTTP 404）：模型名“${model}”或 Base URL 不对，或者接口协议选错了。`,
    };
  if (/empty completion/.test(raw)) return { kind: "empty", status, message: "连上了，但模型没有返回文字。请换一个模型名再试。" };
  return { kind: "http", status, message: `服务端返回错误（HTTP ${status}）：${raw.replace(/^[^:]*HTTP \d+: ?/, "").slice(0, 160)}` };
}

async function runTest(provider: ProviderConfig, model: string, req: Omit<ChatRequest, "model">, fetchImpl?: FetchLike): Promise<ConnectionTest> {
  const started = Date.now();
  try {
    const res = await chatCompletion(provider, { model, ...req }, fetchImpl);
    const latencyMs = Date.now() - started;
    const reply = res.text.replace(/\s+/g, " ").trim().slice(0, 60);
    return { ok: true, model: res.model, latencyMs, reply, message: `连接成功 · ${latencyMs} ms · 模型 ${res.model} 回复：“${reply}”` };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message.slice(0, 300), ...classifyTestFailure(err, provider, model) };
  }
}

/** Used by the admin "test connection" button. */
export function testProvider(provider: ProviderConfig, model: string, fetchImpl?: FetchLike): Promise<ConnectionTest> {
  return runTest(provider, model, { messages: [{ role: "user", content: 'Reply with the JSON object {"ok":true}' }], json: true, timeoutMs: 20_000, temperature: 0 }, fetchImpl);
}

/** A 32×32 white PNG: some vision APIs reject images under 10–28 px on a side. */
const TEST_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJklEQVR42u3NMQ0AAAwDoPo33arYsQQMkB6LQCAQCAQCgUAg+BIMi1X0ptsIcT0AAAAASUVORK5CYII=";

/** The admin "测试连接" for a vision model: one tiny image, a few tokens back. Sends no page. */
export function testVision(provider: ProviderConfig, model: string, fetchImpl?: FetchLike): Promise<ConnectionTest> {
  return runTest(
    provider,
    model,
    { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: TEST_IMAGE } }, { type: "text", text: "What colour is this image? One word." }] }], maxTokens: 16, timeoutMs: 30_000, temperature: 0 },
    fetchImpl,
  );
}
