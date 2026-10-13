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
  /** The one provider and model every call uses; null when none is configured. `visionModel`: the same provider's model for image input, if any. */
  active: { provider: ProviderConfig; model: string; visionModel?: string | null } | null;
  /** A separate provider (own key) for image input, e.g. DeepSeek writes and GLM or Qwen reads pages; wins over `active.visionModel`. */
  vision?: { provider: ProviderConfig; model: string } | null;
}

/** Where image input goes: the separate vision provider, else the active provider's vision model, else nowhere. */
export function visionTarget(config: AiConfig): { provider: ProviderConfig; model: string } | null {
  if (config.vision) return config.vision;
  return config.active?.visionModel ? { provider: config.active.provider, model: config.active.visionModel } : null;
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
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ChatRequest {
  model: string;
  messages: (ChatMessage | ImageMessage)[];
  temperature?: number;
  json?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
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
  for await (const ev of readSse(res.body!)) {
    if (ev.data === "[DONE]") break;
    const d = JSON.parse(ev.data) as { model?: string; choices?: { delta?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } | null; error?: { message?: string } };
    if (d.error) throw new ProviderError(d.error.message ?? "stream error", res.status, true);
    take(d);
    out.text += d.choices?.[0]?.delta?.content ?? "";
  }
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
  for await (const ev of readSse(res.body!)) {
    const d = JSON.parse(ev.data) as {
      type?: string;
      message?: { model?: string; usage?: MessagesUsage };
      delta?: { type?: string; text?: string };
      usage?: MessagesUsage;
      error?: { message?: string };
    };
    const type = d.type ?? ev.event;
    if (type === "error") throw new ProviderError(d.error?.message ?? "stream error", res.status, true);
    if (type === "message_start") {
      out.model = d.message?.model;
      out.inputTokens = d.message?.usage?.input_tokens ?? 0;
      out.outputTokens = d.message?.usage?.output_tokens ?? 0;
    } else if (type === "content_block_delta" && d.delta?.type === "text_delta") out.text += d.delta.text ?? "";
    else if (type === "message_delta" && d.usage) out.outputTokens = d.usage.output_tokens ?? out.outputTokens;
    else if (type === "message_stop") break;
  }
  return out;
}

const isSse = (res: Response) => (res.headers.get("content-type") ?? "").includes("text/event-stream") && res.body !== null;

/**
 * One chat turn, streamed (SSE) in either dialect and assembled into the full text. A server that ignores
 * `stream: true` and answers with plain JSON is accepted too.
 */
export async function chatCompletion(provider: ProviderConfig, req: ChatRequest, fetchImpl: FetchLike = fetch): Promise<ChatResult> {
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
    throw new ProviderError(`network error calling ${provider.name}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new ProviderError(`${provider.name} HTTP ${res.status}: ${text}`, res.status, res.status >= 500 || res.status === 429);
  }
  try {
    collected = messagesProtocol ? await collectMessages(res) : await collectOpenai(res);
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`${provider.name}: stream broke off: ${(err as Error).message}`, res.status, true);
  }
  if (!collected.text) throw new ProviderError(`${provider.name}: empty completion`, res.status, true);
  return { text: collected.text, model: collected.model ?? req.model, usage: { inputTokens: collected.inputTokens, outputTokens: collected.outputTokens } };
}
