import { describe, expect, it } from "vitest";
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

describe("secrets", () => {
  it("round-trips sealed API keys", async () => {
    const sealed = await sealSecret("sk-abc", "k1");
    expect(sealed).not.toContain("sk-abc");
    expect(await openSecret(sealed, "k1")).toBe("sk-abc");
    await expect(openSecret(sealed, "k2")).rejects.toThrow();
  });
});
