import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAiLayer, openSecret, sealSecret, type AiCallRecord, type AiConfig, type FetchLike } from "../src/index.ts";

const Out = z.object({ title: z.string().max(20), n: z.number() });

function setup(config: AiConfig, fetchImpl?: FetchLike, allowStubFallback = true) {
  const records: AiCallRecord[] = [];
  const ai = createAiLayer({ config: { load: async () => config }, meter: { record: async (r) => void records.push(r) }, allowStubFallback, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return { ai, records };
}

const ctx = { orgId: "org_1", userId: "usr_1" };
const req = { capability: "slide.write" as const, promptVersion: "t@1", schema: Out, messages: [{ role: "user" as const, content: "x" }], stub: () => ({ title: "stub", n: 1 }), ctx };

function okResponse(content: unknown) {
  return new Response(JSON.stringify({ model: "deepseek-chat", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const provider = (id: string) => ({ id, kind: "deepseek" as const, name: id, baseUrl: `https://${id}.example/v1`, apiKey: "sk-test-123456" });
const only = (id: string, model = "m"): AiConfig => ({ active: { provider: provider(id), model } });

describe("AI layer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shares one model-time deadline across every call and retry of a request", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let fetches = 0;
    const replies: unknown[] = [{ title: "ok", n: 1 }, "not json"];
    const fetchImpl: FetchLike = async () => {
      fetches++;
      now += 30_000;
      return okResponse(replies.shift());
    };
    const records: AiCallRecord[] = [];
    const ai = createAiLayer({ config: { load: async () => only("a") }, meter: { record: async (r) => void records.push(r) }, allowStubFallback: true, fetch: fetchImpl, deadlineMs: 64_000 });
    expect((await ai.callStructured(req)).output).toEqual({ title: "ok", n: 1 });
    // Second call: its first attempt is invalid and takes 30 s; the repair attempt would start with 4 s left.
    await expect(ai.callStructured(req)).rejects.toThrow(/took too long/);
    expect(fetches).toBe(2);
    expect(records.at(-1)).toMatchObject({ status: "error" });
    await expect(ai.callStructured(req)).rejects.toThrow(/took too long/);
    expect(fetches).toBe(2);
  });

  it("answers from the stub when nothing is configured", async () => {
    const { ai, records } = setup({ active: null });
    const res = await ai.callStructured(req);
    expect(res).toMatchObject({ providerId: "stub", output: { title: "stub" } });
    expect(records[0]).toMatchObject({ status: "ok", capability: "slide.write" });
  });

  it("refuses without a provider when stubs are disabled", async () => {
    const { ai } = setup({ active: null }, undefined, false);
    await expect(ai.callStructured(req)).rejects.toThrow(/no AI provider/);
  });

  it("repairs invalid JSON once, sending the validation issues back", async () => {
    const bodies: string[] = [];
    const replies = ["not json", { title: "This title is far too long to fit", n: 1 }, { title: "ok", n: 2 }];
    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(String(init.body));
      return okResponse(replies.shift());
    };
    const { ai, records } = setup(only("a"), fetchImpl);
    await expect(ai.callStructured(req)).rejects.toThrow(/invalid output twice/);
    expect(bodies[1]).toContain("did not return a JSON object");
    expect(records[0]).toMatchObject({ status: "error", providerId: "a" });
    const res = await ai.callStructured(req);
    expect(res.output).toEqual({ title: "ok", n: 2 });
  });

  it("calls the one configured provider and model and meters tokens", async () => {
    const calls: { url: string; model: string }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, model: (JSON.parse(String(init.body)) as { model: string }).model });
      return okResponse({ title: "fine", n: 3 });
    };
    const { ai, records } = setup(only("b", "glm-4.5"), fetchImpl);
    await ai.callStructured(req);
    expect(calls).toEqual([{ url: "https://b.example/v1/chat/completions", model: "glm-4.5" }]);
    expect(records[0]).toMatchObject({ providerId: "b", capability: "slide.write", inputTokens: 10, outputTokens: 20, status: "ok" });
  });

  it("does not retry provider errors", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return new Response("bad request", { status: 400 });
    };
    const { ai, records } = setup(only("a"), fetchImpl);
    await expect(ai.callStructured(req)).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
    expect(records[0]?.status).toBe("error");
  });
});

describe("vision calls", () => {
  const image = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  const vreq = { capability: "page.read" as const, promptVersion: "p@1", instructions: "Transcribe.", image, ctx };
  const capture = () => {
    const bodies: Record<string, any>[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return okResponse("$v = u + at$");
    };
    return { bodies, fetchImpl };
  };

  it("sends the image to the provider's vision model and returns its text, metered", async () => {
    const { bodies, fetchImpl } = capture();
    const { ai, records } = setup({ active: { provider: { ...provider("q"), kind: "custom" }, model: "chat", visionModel: "qwen-vl-ocr" } }, fetchImpl);
    expect((await ai.callVision(vreq)).text).toBe("$v = u + at$");
    expect(bodies[0]).toMatchObject({ model: "qwen-vl-ocr", temperature: 0, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: image } }, { type: "text", text: "Transcribe." }] }] });
    expect(bodies[0]!.response_format).toBeUndefined();
    expect(records[0]).toMatchObject({ capability: "page.read", status: "ok", inputTokens: 10 });
  });

  it("GLM gets bare base64 and no thinking", async () => {
    const { bodies, fetchImpl } = capture();
    const { ai } = setup({ active: { provider: { ...provider("g"), kind: "glm" }, model: "glm-4.5", visionModel: "glm-4.6v-flash" } }, fetchImpl);
    await ai.callVision(vreq);
    expect(bodies[0]!.messages[0].content[0].image_url.url).toBe("/9j/4AAQSkZJRg==");
    expect(bodies[0]!.thinking).toEqual({ type: "disabled" });
  });

  it("is never stubbed: no vision model, no call", async () => {
    const { bodies, fetchImpl } = capture();
    await expect(setup({ active: null }, fetchImpl).ai.callVision(vreq)).rejects.toThrow(/no vision model/);
    await expect(setup(only("a"), fetchImpl).ai.callVision(vreq)).rejects.toThrow(/no vision model/);
    expect(bodies).toHaveLength(0);
  });
});

describe("secrets", () => {
  it("round-trips sealed API keys", async () => {
    const sealed = await sealSecret("sk-abc", "k1");
    expect(sealed).not.toContain("sk-abc");
    expect(await openSecret(sealed, "k1")).toBe("sk-abc");
    await expect(openSecret(sealed, "k2")).rejects.toThrow();
  });
});
