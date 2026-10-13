import { z } from "zod";

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

export const ProviderConfig = z.object({
  id: z.string(),
  kind: ProviderKind,
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  /** Extra headers some OpenAI-compatible gateways need. */
  headers: z.record(z.string(), z.string()).optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export interface AiConfig {
  /** The one provider and model every call uses; null when none is configured. `visionModel`: the same provider's model for image input, if any. */
  active: { provider: ProviderConfig; model: string; visionModel?: string | null } | null;
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

/** All supported providers speak the OpenAI chat-completions dialect. */
export async function chatCompletion(
  provider: ProviderConfig,
  req: { model: string; messages: (ChatMessage | ImageMessage)[]; temperature?: number; json?: boolean; maxTokens?: number; timeoutMs?: number },
  fetchImpl: FetchLike = fetch,
): Promise<ChatResult> {
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const { messages, extra } = forProvider(provider, req.messages);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${provider.apiKey}`,
        ...(provider.headers ?? {}),
      },
      body: JSON.stringify({
        model: req.model,
        messages,
        temperature: req.temperature ?? 0.4,
        ...(req.json ? { response_format: { type: "json_object" } } : {}),
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        ...extra,
        stream: false,
      }),
      signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
    });
  } catch (err) {
    throw new ProviderError(`network error calling ${provider.name}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    throw new ProviderError(`${provider.name} HTTP ${res.status}: ${body}`, res.status, res.status >= 500 || res.status === 429);
  }
  const data = (await res.json()) as {
    model?: string;
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new ProviderError(`${provider.name}: empty completion`, res.status, true);
  return {
    text,
    model: data.model ?? req.model,
    usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
  };
}
