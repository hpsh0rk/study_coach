import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAiLayer, openSecret, parseRetryAfterMs, ProviderError, sealSecret, testProvider, testVision, type AiCallRecord, type AiConfig, type FetchLike, type RetryOptions } from "../src/index.ts";

const Out = z.object({ title: z.string().max(20), n: z.number() });

function setup(config: AiConfig, fetchImpl?: FetchLike, allowStubFallback = true, retry?: RetryOptions) {
  const records: AiCallRecord[] = [];
  const ai = createAiLayer({
    config: { load: async () => config },
    meter: { record: async (r) => void records.push(r) },
    allowStubFallback,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    ...(retry ? { retry } : {}),
  });
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

  it("extracts fenced or balanced JSON even when surrounding prose contains LaTeX braces", async () => {
    const replies = [
      'Here is the corrected JSON for $\\frac{d}{dt}$:\n```json\n{"title":"wave speed","n":4}\n```\nFormula $\\frac{\\lambda}{T}$ stays in notes.',
      '{"title":"inline {braces}","n":5} — kept $\\frac{1}{2}mv^2$ concise.',
    ];
    const fetchImpl: FetchLike = async () => okResponse(replies.shift());
    const { ai } = setup(only("a"), fetchImpl);
    expect((await ai.callStructured(req)).output).toEqual({ title: "wave speed", n: 4 });
    expect((await ai.callStructured(req)).output).toEqual({ title: "inline {braces}", n: 5 });
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

  it("does not retry non-retriable 4xx provider errors", async () => {
    for (const status of [400, 401, 403, 404]) {
      let calls = 0;
      const sleeps: number[] = [];
      const fetchImpl: FetchLike = async () => {
        calls++;
        return new Response("client error", { status });
      };
      const { ai, records } = setup(only("a"), fetchImpl, true, { sleep: async (ms) => void sleeps.push(ms) });
      await expect(ai.callStructured(req)).rejects.toThrow(new RegExp(`HTTP ${status}`));
      expect(calls).toBe(1);
      expect(sleeps).toEqual([]);
      expect(records[0]?.status).toBe("error");
    }
  });

  it("retries transient 429 and 5xx errors in callStructured and callVision with bounded backoff + jitter", async () => {
    const sleeps: number[] = [];
    const responses = [
      () => new Response("rate limited", { status: 429 }),
      () => new Response("gateway unavailable", { status: 503 }),
      () => okResponse({ title: "recovered", n: 7 }),
    ];
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return responses.shift()!();
    };
    const { ai, records } = setup(only("a"), fetchImpl, false, {
      baseDelayMs: 500,
      maxDelayMs: 8_000,
      maxRetries: 2,
      random: () => 0.4,
      sleep: async (ms) => void sleeps.push(ms),
    });
    const res = await ai.callStructured(req);
    expect(res.output).toEqual({ title: "recovered", n: 7 });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([550, 1100]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "ok", inputTokens: 10, outputTokens: 20 });

    // Vision also retries transient 502 and stops after maxRetries when 429 persists.
    const visionSleeps: number[] = [];
    const visionReplies = [() => new Response("bad gateway", { status: 502 }), () => okResponse("$F = ma$")];
    const visionAi = setup(
      { active: null, vision: { provider: { ...provider("v"), kind: "custom" }, model: "mock-vl" } },
      async () => visionReplies.shift()!(),
      false,
      { baseDelayMs: 400, random: () => 0, sleep: async (ms) => void visionSleeps.push(ms) },
    );
    expect((await visionAi.ai.callVision({ capability: "page.read", promptVersion: "p@1", instructions: "Read.", image: "data:image/png;base64,QUJD", ctx })).text).toBe("$F = ma$");
    expect(visionSleeps).toEqual([400]);

    let exhaustedCalls = 0;
    const exhaustedSleeps: number[] = [];
    const always429 = setup(
      only("a"),
      async () => {
        exhaustedCalls++;
        return new Response("too many requests", { status: 429 });
      },
      false,
      { baseDelayMs: 500, maxRetries: 2, random: () => 0, sleep: async (ms) => void exhaustedSleeps.push(ms) },
    );
    const err = await always429.ai.callStructured(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(429);
    expect(exhaustedCalls).toBe(3);
    expect(exhaustedSleeps).toEqual([500, 1000]);
  });

  it("honours Retry-After / retry-after-ms within maxDelayMs and stops before exceeding deadlineMs", async () => {
    const refNow = Date.parse("2026-11-12T08:00:00.000Z");
    expect(parseRetryAfterMs(new Headers({ "Retry-After": "2.5" }), refNow)).toBe(2500);
    expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "750" }), refNow)).toBe(750);
    expect(parseRetryAfterMs(new Headers({ "Retry-After": "Thu, 12 Nov 2026 08:00:04 GMT" }), refNow)).toBe(4000);
    expect(parseRetryAfterMs(new Headers({ "Retry-After": "not-a-date" }), refNow)).toBeUndefined();

    const sleeps: number[] = [];
    const replies = [
      () => new Response("slow down", { status: 429, headers: { "Retry-After": "3" } }),
      () => new Response("huge wait", { status: 429, headers: { "Retry-After": "60" } }),
      () => okResponse({ title: "after-wait", n: 9 }),
    ];
    const { ai } = setup(only("a"), async () => replies.shift()!(), false, {
      baseDelayMs: 500,
      maxDelayMs: 8_000,
      maxRetries: 2,
      random: () => 0,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect((await ai.callStructured(req)).output).toEqual({ title: "after-wait", n: 9 });
    expect(sleeps).toEqual([3_000, 8_000]);

    // When Retry-After leaves less than MIN_CALL_MS (5 s) before deadlineMs, fail immediately with 429 instead of sleeping.
    const now = 2_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const tightSleeps: number[] = [];
    let tightCalls = 0;
    const tightAi = createAiLayer({
      config: { load: async () => only("a") },
      meter: { record: async () => undefined },
      allowStubFallback: false,
      deadlineMs: 10_000,
      retry: { maxDelayMs: 8_000, random: () => 0, sleep: async (ms) => void tightSleeps.push(ms) },
      fetch: async () => {
        tightCalls++;
        return new Response("rate limited", { status: 429, headers: { "retry-after-ms": "6000" } });
      },
    });
    const tightErr = await tightAi.callStructured(req).catch((e: unknown) => e);
    expect(tightErr).toBeInstanceOf(ProviderError);
    expect((tightErr as ProviderError).status).toBe(429);
    expect(tightCalls).toBe(1);
    expect(tightSleeps).toEqual([]);
  });

  it("does not retry interactive testProvider or testVision probes on 429 or 5xx", async () => {
    let providerCalls = 0;
    const r1 = await testProvider(provider("a"), "m", async () => {
      providerCalls++;
      return new Response("rate limited", { status: 429 });
    });
    expect(r1).toMatchObject({ ok: false, kind: "http", status: 429 });
    expect(providerCalls).toBe(1);

    let visionCalls = 0;
    const r2 = await testVision({ ...provider("v"), kind: "custom" }, "mock-vl", async () => {
      visionCalls++;
      return new Response("bad gateway", { status: 503 });
    });
    expect(r2).toMatchObject({ ok: false, kind: "http", status: 503 });
    expect(visionCalls).toBe(1);
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
    const { ai, records } = setup({ active: null, vision: { provider: { ...provider("q"), kind: "custom" }, model: "qwen-vl-ocr" } }, fetchImpl);
    expect((await ai.callVision(vreq)).text).toBe("$v = u + at$");
    expect(bodies[0]).toMatchObject({ model: "qwen-vl-ocr", temperature: 0, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: image } }, { type: "text", text: "Transcribe." }] }] });
    expect(bodies[0]!.response_format).toBeUndefined();
    expect(records[0]).toMatchObject({ capability: "page.read", status: "ok", inputTokens: 10 });
  });

  it("GLM gets bare base64 and no thinking", async () => {
    const { bodies, fetchImpl } = capture();
    const { ai } = setup({ active: null, vision: { provider: { ...provider("g"), kind: "glm" }, model: "glm-4.6v-flash" } }, fetchImpl);
    await ai.callVision(vreq);
    expect(bodies[0]!.messages[0].content[0].image_url.url).toBe("/9j/4AAQSkZJRg==");
    expect(bodies[0]!.thinking).toEqual({ type: "disabled" });
  });

  it("the vision provider (own key) reads pages, with or without a text model", async () => {
    const urls: string[] = [];
    const keys: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      urls.push(String(url));
      keys.push(String((init.headers as Record<string, string>).Authorization ?? (init.headers as Record<string, string>).authorization));
      return okResponse("text");
    };
    const glm = { ...provider("glm"), kind: "glm" as const, apiKey: "glm-key-123456" };
    await setup({ active: { provider: provider("ds"), model: "deepseek-chat" }, vision: { provider: glm, model: "glm-4.6v-flash" } }, fetchImpl).ai.callVision(vreq);
    await setup({ active: null, vision: { provider: glm, model: "glm-4.6v-flash" } }, fetchImpl).ai.callVision(vreq);
    expect(urls.every((u) => u.startsWith("https://glm.example/v1"))).toBe(true);
    expect(keys).toEqual(["Bearer glm-key-123456", "Bearer glm-key-123456"]);
  });

  it("testVision sends one small image, caps max_tokens at 256 for thinking models, and disables JSON mode", async () => {
    const { bodies, fetchImpl } = capture();
    expect(await testVision({ ...provider("q"), kind: "custom" }, "qwen-vl-ocr", fetchImpl)).toMatchObject({ ok: true });
    expect(bodies[0]).toMatchObject({ model: "qwen-vl-ocr", max_tokens: 256 });
    expect(bodies[0]!.messages[0].content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(bodies[0]!.response_format).toBeUndefined();
    const failing: FetchLike = async () => new Response("bad key", { status: 401 });
    expect(await testVision(provider("q"), "qwen-vl-ocr", failing)).toMatchObject({ ok: false });
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
