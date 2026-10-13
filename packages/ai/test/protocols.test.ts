import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chatCompletion, createAiLayer, messagesUrl, ProviderError, testProvider, testVision, type FetchLike, type ProviderConfig } from "../src/index.ts";

/** An SSE response delivered in awkward 7-byte pieces, so events straddle chunk boundaries. */
function sse(events: string[]): Response {
  const bytes = new TextEncoder().encode(events.join(""));
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
      c.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function messagesStream(text: string[], model = "glm-5.3-flash"): Response {
  return sse([
    ev("message_start", { type: "message_start", message: { model, usage: { input_tokens: 11, output_tokens: 1 } } }),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ev("ping", { type: "ping" }),
    ...text.map((t) => ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }),
    ev("message_stop", { type: "message_stop" }),
  ]);
}

const llmbox: ProviderConfig = {
  id: "m",
  kind: "custom",
  name: "llmbox",
  baseUrl: "http://llmbox.example.test",
  apiKey: "sk-test",
  protocol: "messages",
  maxTokens: 31200,
  headers: { "x-source": "tensorhawk" },
};

function capture(respond: () => Response) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return respond();
  };
  return { calls, fetchImpl };
}

describe("Messages protocol", () => {
  it("posts {base}/v1/messages with Bearer, custom headers, max_tokens and stream, and assembles the SSE text", async () => {
    const { calls, fetchImpl } = capture(() => messagesStream(["你", "好", "！"]));
    const res = await chatCompletion(llmbox, { model: "glm-5.3-flash", messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }] }, fetchImpl);
    expect(res).toEqual({ text: "你好！", model: "glm-5.3-flash", usage: { inputTokens: 11, outputTokens: 7 } });
    const [call] = calls;
    expect(call!.url).toBe("http://llmbox.example.test/v1/messages");
    expect(call!.headers.authorization).toBe("Bearer sk-test");
    expect(call!.headers["x-source"]).toBe("tensorhawk");
    expect(call!.body).toMatchObject({ model: "glm-5.3-flash", max_tokens: 31200, stream: true, system: "be brief", messages: [{ role: "user", content: "hi" }] });
  });

  it("does not double /v1 in the URL", () => {
    expect(messagesUrl("https://gw.example.test/v1/")).toBe("https://gw.example.test/v1/messages");
    expect(messagesUrl("http://llmbox-global.byteintl.net")).toBe("http://llmbox-global.byteintl.net/v1/messages");
  });

  it("sends images as base64 image blocks", async () => {
    const { calls, fetchImpl } = capture(() => messagesStream(["white"]));
    await chatCompletion(llmbox, { model: "v", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } }, { type: "text", text: "read" }] }] }, fetchImpl);
    expect(calls[0]!.body.messages).toEqual([
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } }, { type: "text", text: "read" }] },
    ]);
  });

  it("turns a stream error event and HTTP errors into ProviderError", async () => {
    const broken = capture(() => sse([ev("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })]));
    await expect(chatCompletion(llmbox, { model: "x", messages: [{ role: "user", content: "hi" }] }, broken.fetchImpl)).rejects.toThrow(/Overloaded/);
    const denied = capture(() => new Response('{"error":"bad key"}', { status: 401 }));
    const err = await chatCompletion(llmbox, { model: "x", messages: [{ role: "user", content: "hi" }] }, denied.fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(401);
    expect((err as ProviderError).retriable).toBe(false);
  });

  it("accepts a plain JSON answer from a server that ignores stream", async () => {
    const { fetchImpl } = capture(() => Response.json({ model: "m1", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 2, output_tokens: 1 } }));
    expect(await chatCompletion(llmbox, { model: "x", messages: [{ role: "user", content: "hi" }] }, fetchImpl)).toEqual({ text: "ok", model: "m1", usage: { inputTokens: 2, outputTokens: 1 } });
  });

  it("drives structured calls through the layer", async () => {
    const { fetchImpl } = capture(() => messagesStream(['{"ti', 'tle":"运动"}']));
    const ai = createAiLayer({ config: { load: async () => ({ active: { provider: llmbox, model: "glm-5.3-flash" } }) }, meter: { record: async () => {} }, allowStubFallback: false, fetch: fetchImpl });
    const out = await ai.callStructured({ capability: "outline.draft", promptVersion: "t", schema: z.object({ title: z.string() }), messages: [{ role: "user", content: "x" }], stub: () => ({}), ctx: { orgId: "o", userId: "u" } });
    expect(out.output).toEqual({ title: "运动" });
  });
});

describe("OpenAI protocol streaming", () => {
  it("streams chat completions with custom headers and the provider's max_tokens", async () => {
    const chunk = (content: string) => `data: ${JSON.stringify({ model: "glm-4.5", choices: [{ delta: { content } }] })}\n\n`;
    const { calls, fetchImpl } = capture(() =>
      sse([chunk("Hel"), chunk("lo"), `data: ${JSON.stringify({ model: "glm-4.5", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`, "data: [DONE]\n\n"]),
    );
    const provider: ProviderConfig = { id: "o", kind: "glm", name: "glm", baseUrl: "https://open.example.test/v4/", apiKey: "k", maxTokens: 900, headers: { "x-source": "t" } };
    const res = await chatCompletion(provider, { model: "glm-4.5", messages: [{ role: "user", content: "hi" }] }, fetchImpl);
    expect(res).toEqual({ text: "Hello", model: "glm-4.5", usage: { inputTokens: 5, outputTokens: 2 } });
    expect(calls[0]!.url).toBe("https://open.example.test/v4/chat/completions");
    expect(calls[0]!.headers["x-source"]).toBe("t");
    expect(calls[0]!.body).toMatchObject({ stream: true, max_tokens: 900 });
  });
});

describe("测试连接 results", () => {
  const answer = (status: number, body: string) => capture(() => new Response(body, { status })).fetchImpl;

  it("OK: latency, model and the start of the reply", async () => {
    const r = await testProvider(llmbox, "glm-5.3-flash", capture(() => messagesStream(['{"ok":', "true}"])).fetchImpl);
    expect(r).toMatchObject({ ok: true, model: "glm-5.3-flash", reply: '{"ok":true}' });
    expect(r.message).toMatch(/^连接成功 · \d+ ms · 模型 glm-5\.3-flash 回复：“\{"ok":true\}”$/);
  });

  it.each([
    [401, '{"error":"invalid api key"}', "auth", "Key 不对或没有权限（HTTP 401）"],
    [403, "forbidden", "auth", "HTTP 403"],
    [404, "Not Found", "model", "找不到（HTTP 404）：模型名“m1”或 Base URL 不对"],
    [400, '{"error":{"type":"invalid_request_error","message":"model m1 does not exist"}}', "model", "模型名不对：服务端不认识“m1”（HTTP 400）"],
    [400, '{"error":{"code":"model_not_found"}}', "model", "模型名不对"],
    [500, "upstream exploded", "http", "服务端返回错误（HTTP 500）：upstream exploded"],
  ])("HTTP %i → %s", async (status, body, kind, text) => {
    const r = await testProvider(llmbox, "m1", answer(status, body));
    expect(r).toMatchObject({ ok: false, kind, status });
    expect(r.message).toContain(text);
  });

  it("unreachable and empty replies", async () => {
    const down: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await testVision(llmbox, "v", down)).toMatchObject({ ok: false, kind: "unreachable", message: expect.stringContaining("连不上：访问 http://llmbox.example.test 失败") });
    const slow: FetchLike = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    expect((await testProvider(llmbox, "m", slow)).message).toContain("在规定时间内没有回应");
    expect(await testProvider(llmbox, "m", capture(() => messagesStream([])).fetchImpl)).toMatchObject({ ok: false, kind: "empty" });
  });
});
