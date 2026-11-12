import { z } from "zod";
import { readSse } from "./sse.ts";

export const ProviderKind = z.enum(["deepseek", "glm", "custom"]);
export type ProviderKind = z.infer<typeof ProviderKind>;

/** Defaults shown in the admin form. Teachers never see this; admins can override base URL and model. */
export const PROVIDER_PRESETS: Record<ProviderKind, { label: string; baseUrl: string; models: string[]; visionModels: string[]; docs: string }> = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    visionModels: [],
    docs: "https://api-docs.deepseek.com/",
  },
  glm: {
    label: "GLM · 智谱",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.5", "glm-4.5-air", "glm-4-flash"],
    visionModels: ["glm-4.6v-flash", "glm-4.6v-flashx", "glm-4.6v"],
    docs: "https://docs.bigmodel.cn/",
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    baseUrl: "",
    models: [],
    visionModels: ["qwen-vl-ocr", "qwen3-vl-flash"],
    docs: "",
  },
};

export const ProviderProtocol = z.enum(["openai", "messages"]);
export type ProviderProtocol = z.infer<typeof ProviderProtocol>;

export const ProviderConfig = z.object({
  id: z.string(),
  kind: ProviderKind,
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  /** Extra headers some gateways need, e.g. `x-source`. */
  headers: z.record(z.string(), z.string()).optional(),
  /** `openai`: POST {base}/chat/completions. `messages`: POST {base}/v1/messages (Anthropic Messages dialect). Default `openai`. */
  protocol: ProviderProtocol.optional(),
  /** Default `max_tokens` when a call does not set one; Messages requires a value (4096 if unset). */
  maxTokens: z.number().int().positive().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export interface AiConfig {
  /** The one provider and model every text call uses; null when none is configured. */
  active: { provider: ProviderConfig; model: string } | null;
  /** The provider and model for image input (reading pages), e.g. DeepSeek writes and GLM or Qwen reads; may share the text provider's base URL and key. */
  vision?: { provider: ProviderConfig; model: string } | null;
}

export interface AiConfigSource {
  load(): Promise<AiConfig>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** `image_url.url` is a `data:image/…;base64,` URL. */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** A user turn with an image, for vision models. */
export interface ImageMessage {
  role: "user";
  content: ContentPart[];
}

/** GLM's documented form for inline images is the bare base64 string; it also turns "thinking" off for transcription. */
function forProvider(provider: ProviderConfig, messages: (ChatMessage | ImageMessage)[]): { messages: unknown[]; extra: Record<string, unknown> } {
  const hasImage = messages.some((m) => typeof m.content !== "string");
  if (provider.kind !== "glm" || !hasImage) return { messages, extra: {} };
  return {
    messages: messages.map((m) =>
      typeof m.content === "string" ? m : { ...m, content: m.content.map((p) => (p.type === "image_url" ? { ...p, image_url: { url: p.image_url.url.replace(/^data:[^,]*;base64,/, "") } } : p)) },
    ),
    extra: { thinking: { type: "disabled" } },
  };
}

export interface ChatResult {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retriable = true,
    /** The message quotes the gateway's own error text (some echo part of the key): it goes to `ai_calls.error` only. */
    readonly fromGateway = false,
    /** Server-advised wait in ms parsed from `retry-after-ms` or `Retry-After`, when present on an error response. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** What a teacher may see: the status and what to do, never the gateway's text. */
  get publicMessage(): string {
    if (!this.fromGateway) return this.message;
    const s = this.status;
    if (s === undefined) return "连不上 AI 模型服务，请稍后再试 · Could not reach the AI provider";
    if (s === 401 || s === 403) return `AI 模型拒绝了请求（HTTP ${s}），请联系管理员检查后台的 API Key · The AI provider refused the request`;
    if (s === 404) return "AI 模型服务找不到这个模型或地址（HTTP 404），请联系管理员检查后台的模型名和 Base URL · Model or address not found";
    if (s === 429) return "AI 模型正忙（限流），请稍后再试 · The AI provider is rate-limited; try again later";
    if (s < 400) return "AI 模型的回复中断了，请稍后再试 · The AI provider's reply broke off";
    return `AI 模型服务出错（HTTP ${s}），请稍后再试 · The AI provider failed`;
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RetryOptions {
  /** Retries after the initial attempt on retriable ProviderError (default 2; 0 disables retries). */
  maxRetries?: number;
  /** Initial exponential backoff delay in ms (default 500). */
  baseDelayMs?: number;
  /** Cap on any single retry wait in ms, including Retry-After (default 8_000). */
  maxDelayMs?: number;
  /** Absolute request deadline (Date.now() ms) after which another retry + call cannot start. */
  deadlineAtMs?: number;
  /** Minimum ms remaining after sleeping required to start another attempt (default 5_000). */
  minRemainingMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: ProviderError }) => void;
}

export interface ChatRequest {
  model: string;
  messages: (ChatMessage | ImageMessage)[];
  temperature?: number;
  json?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
  retry?: RetryOptions;
}

export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 8_000;
const DEFAULT_MIN_REMAINING_MS = 5_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Parses HTTP `retry-after-ms` or `Retry-After` (delta-seconds or HTTP-date) into non-negative ms. */
export function parseRetryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const msHeader = headers.get("retry-after-ms")?.trim();
  if (msHeader && /^\d+(?:\.\d+)?$/.test(msHeader)) {
    const ms = Math.round(Number(msHeader));
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const ms = Math.round(Number(raw) * 1000);
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

const trimBase = (url: string) => url.replace(/\/+$/, "");

/** `{base}/v1/messages`, without doubling `/v1` when the admin already typed it. */
export function messagesUrl(baseUrl: string): string {
  const base = trimBase(baseUrl);
  return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
}

function dataUrlParts(url: string): { media_type: string; data: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? { media_type: m[1]!, data: m[2]! } : { media_type: "image/png", data: url };
}

function messagesBody(provider: ProviderConfig, req: ChatRequest): Record<string, unknown> {
  const system = req.messages
    .filter((m): m is ChatMessage => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const messages = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role,
      content:
        typeof m.content === "string"
          ? m.content
          : m.content.map((p) => (p.type === "text" ? p : { type: "image", source: { type: "base64", ...dataUrlParts(p.image_url.url) } })),
    }));
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? provider.maxTokens ?? 4096,
    messages,
    ...(system ? { system } : {}),
    temperature: req.temperature ?? 0.4,
    stream: true,
  };
}

function openaiBody(provider: ProviderConfig, req: ChatRequest): Record<string, unknown> {
  const { messages, extra } = forProvider(provider, req.messages);
  const maxTokens = req.maxTokens ?? provider.maxTokens;
  return {
    model: req.model,
    messages,
    temperature: req.temperature ?? 0.4,
    ...(req.json ? { response_format: { type: "json_object" } } : {}),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...extra,
    stream: true,
    ...(provider.kind === "deepseek" ? { stream_options: { include_usage: true } } : {}),
  };
}

interface Collected {
  text: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
}

async function collectOpenai(res: Response): Promise<Collected> {
  const out: Collected = { text: "", inputTokens: 0, outputTokens: 0 };
  const take = (d: { model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } | null }) => {
    if (d.model) out.model = d.model;
    if (d.usage) {
      out.inputTokens = d.usage.prompt_tokens ?? out.inputTokens;
      out.outputTokens = d.usage.completion_tokens ?? out.outputTokens;
    }
  };
  if (!isSse(res)) {
    const data = (await res.json()) as { model?: string; choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    take(data);
    out.text = data.choices?.[0]?.message?.content ?? "";
    return out;
  }
  let done = false;
  for await (const ev of readSse(res.body!)) {
    if (ev.data === "[DONE]") {
      done = true;
      break;
    }
    const d = JSON.parse(ev.data) as {
      model?: string;
      choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      error?: { message?: string };
    };
    if (d.error) throw new ProviderError(d.error.message ?? "stream error", res.status, true, true);
    take(d);
    if (d.choices?.some((c) => c.finish_reason)) done = true;
    out.text += d.choices?.[0]?.delta?.content ?? "";
  }
  if (!done) throw new Error("incomplete SSE stream");
  return out;
}

type MessagesUsage = { input_tokens?: number; output_tokens?: number };

async function collectMessages(res: Response): Promise<Collected> {
  const out: Collected = { text: "", inputTokens: 0, outputTokens: 0 };
  if (!isSse(res)) {
    const data = (await res.json()) as { model?: string; content?: { type: string; text?: string }[]; usage?: MessagesUsage };
    out.model = data.model;
    out.text = (data.content ?? []).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
    out.inputTokens = data.usage?.input_tokens ?? 0;
    out.outputTokens = data.usage?.output_tokens ?? 0;
    return out;
  }
  let done = false;
  for await (const ev of readSse(res.body!)) {
    const d = JSON.parse(ev.data) as {
      type?: string;
      message?: { model?: string; usage?: MessagesUsage };
      delta?: { type?: string; text?: string };
      usage?: MessagesUsage;
      error?: { message?: string };
    };
    const type = d.type ?? ev.event;
    if (type === "error") throw new ProviderError(d.error?.message ?? "stream error", res.status, true, true);
    if (type === "message_start") {
      out.model = d.message?.model;
      out.inputTokens = d.message?.usage?.input_tokens ?? 0;
      out.outputTokens = d.message?.usage?.output_tokens ?? 0;
    } else if (type === "content_block_delta" && d.delta?.type === "text_delta") out.text += d.delta.text ?? "";
    else if (type === "message_delta" && d.usage) out.outputTokens = d.usage.output_tokens ?? out.outputTokens;
    else if (type === "message_stop") {
      done = true;
      break;
    }
  }
  if (!done) throw new Error("missing message_stop");
  return out;
}

const isSse = (res: Response) => (res.headers.get("content-type") ?? "").includes("text/event-stream") && res.body !== null;

async function chatCompletionOnce(provider: ProviderConfig, req: ChatRequest, fetchImpl: FetchLike): Promise<ChatResult> {
  const messagesProtocol = provider.protocol === "messages";
  const url = messagesProtocol ? messagesUrl(provider.baseUrl) : `${trimBase(provider.baseUrl)}/chat/completions`;
  const body = messagesProtocol ? messagesBody(provider, req) : openaiBody(provider, req);
  let res: Response;
  let collected: Collected;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream, application/json",
        authorization: `Bearer ${provider.apiKey}`,
        ...(messagesProtocol ? { "anthropic-version": "2023-06-01" } : {}),
        ...(provider.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
    });
  } catch (err) {
    throw new ProviderError(`network error calling ${provider.name}: ${(err as Error).message}`, undefined, true, true);
  }
  if (!res.ok) {
    const retryAfterMs = parseRetryAfterMs(res.headers);
    const text = (await res.text()).slice(0, 500);
    throw new ProviderError(`${provider.name} HTTP ${res.status}: ${text}`, res.status, res.status >= 500 || res.status === 429, true, retryAfterMs);
  }
  try {
    collected = messagesProtocol ? await collectMessages(res) : await collectOpenai(res);
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`${provider.name}: stream broke off: ${(err as Error).message}`, res.status, true, true);
  }
  if (!collected.text) throw new ProviderError(`${provider.name}: empty completion`, res.status, true, true);
  return { text: collected.text, model: collected.model ?? req.model, usage: { inputTokens: collected.inputTokens, outputTokens: collected.outputTokens } };
}

/**
 * One chat turn, streamed (SSE) in either dialect and assembled into the full text, with bounded
 * exponential backoff + `Retry-After` on retriable `429` / `5xx` / transient stream errors.
 */
export async function chatCompletion(provider: ProviderConfig, req: ChatRequest, fetchImpl: FetchLike = fetch): Promise<ChatResult> {
  const retry = req.retry;
  const maxRetries = Math.max(0, retry?.maxRetries ?? DEFAULT_MAX_RETRIES);
  const baseDelayMs = Math.max(0, retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = Math.max(baseDelayMs, retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const deadlineAtMs = retry?.deadlineAtMs ?? Infinity;
  const minRemainingMs = retry?.minRemainingMs ?? DEFAULT_MIN_REMAINING_MS;
  const sleep = retry?.sleep ?? defaultSleep;
  const random = retry?.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    let timeoutMs = req.timeoutMs ?? 60_000;
    if (deadlineAtMs !== Infinity) {
      const left = deadlineAtMs - Date.now();
      if (left < minRemainingMs) {
        throw new ProviderError("模型调用超出本次请求的时间上限，请稍后重试 · The model took too long for this request; try again", 504, false);
      }
      timeoutMs = Math.min(timeoutMs, left);
    }
    try {
      return await chatCompletionOnce(provider, { ...req, timeoutMs }, fetchImpl);
    } catch (err) {
      if (!(err instanceof ProviderError) || !err.retriable || attempt >= maxRetries) throw err;
      const jitter = 1 + 0.25 * Math.min(1, Math.max(0, random()));
      const expMs = Math.round(baseDelayMs * 2 ** attempt * jitter);
      const rawDelayMs = err.retryAfterMs !== undefined && err.retryAfterMs > 0 ? Math.round(err.retryAfterMs * jitter) : expMs;
      const delayMs = Math.min(maxDelayMs, rawDelayMs);
      if (deadlineAtMs !== Infinity && deadlineAtMs - Date.now() - delayMs < minRemainingMs) throw err;
      retry?.onRetry?.({ attempt: attempt + 1, delayMs, error: err });
      if (delayMs > 0) await sleep(delayMs);
    }
  }
}
