import { describe, expect, it, vi } from "vitest";
import { AiGateError, createAiLayer, findGlossaryTerms, openSecret, sealSecret, type AiCallRecord, type AiConfig, type FetchLike } from "../src/index.ts";

const outlineItem = { id: "oi_1", kind: "content" as const, title: "Describing waves", points: [], chapterIds: ["ch_1"] };
const sourceText =
  "A wave transfers energy from one place to another without transferring matter. The amplitude of a wave is the maximum displacement of a point from its rest position. The wavelength is the distance between two adjacent crests.";

function setup(config: AiConfig, fetchImpl?: FetchLike, gateOk = true) {
  const records: AiCallRecord[] = [];
  const ai = createAiLayer({
    config: { load: async () => config },
    gate: { verify: async () => gateOk },
    meter: { record: async (r) => void records.push(r) },
    allowStubFallback: true,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return { ai, records };
}

const ctx = { orgId: "org_1", userId: "usr_1", projectId: "prj_1", gateToken: "olc_1" };

function okResponse(content: unknown) {
  return new Response(JSON.stringify({ model: "deepseek-chat", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const goodSlots = { layout: "title-bullets", title: "Describing waves", bullets: ["Waves transfer energy."], terms: [], notes: { en: ["Hi"], zhTerms: [] } };

describe("AI capability layer", () => {
  it("rejects gated capabilities without a gate token", async () => {
    const { ai, records } = setup({ providers: [], routes: {} });
    await expect(ai.call("slide.generate", { outlineItem, sourceText }, { orgId: "o", userId: "u", projectId: "prj_1" })).rejects.toBeInstanceOf(AiGateError);
    expect(records[0]?.status).toBe("rejected");
  });

  it("rejects stale gate tokens", async () => {
    const { ai } = setup({ providers: [], routes: {} }, undefined, false);
    await expect(ai.call("slide.generate", { outlineItem, sourceText }, ctx)).rejects.toBeInstanceOf(AiGateError);
  });

  it("falls back to the deterministic stub when nothing is configured", async () => {
    const { ai, records } = setup({ providers: [], routes: {} });
    const res = await ai.call("slide.generate", { outlineItem, sourceText }, ctx);
    expect(res.providerId).toBe("stub");
    expect(res.output.bullets.length).toBeGreaterThan(0);
    expect(res.output.terms.map((t) => t.term)).toEqual(expect.arrayContaining(["amplitude", "wavelength"]));
    expect(records[0]).toMatchObject({ status: "ok", capability: "slide.generate" });
  });

  it("calls the admin-configured provider and repairs invalid JSON once", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValueOnce(okResponse("not json")).mockResolvedValueOnce(okResponse(goodSlots));
    const { ai } = setup(
      {
        providers: [{ id: "aip_1", kind: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-test", enabled: true }],
        routes: { default: { primary: { providerId: "aip_1", model: "deepseek-chat" } } },
      },
      fetchMock,
    );
    const res = await ai.call("slide.generate", { outlineItem, sourceText }, ctx);
    expect(res.output.title).toBe("Describing waves");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body as string).model).toBe("deepseek-chat");
  });

  it("uses the fallback route when the primary provider fails", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValueOnce(new Response("overloaded", { status: 503 })).mockResolvedValueOnce(okResponse(goodSlots));
    const { ai, records } = setup(
      {
        providers: [
          { id: "aip_ds", kind: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey: "k1", enabled: true },
          { id: "aip_glm", kind: "glm", name: "GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "k2", enabled: true },
        ],
        routes: { "slide.generate": { primary: { providerId: "aip_ds", model: "deepseek-chat" }, fallback: { providerId: "aip_glm", model: "glm-4.5" } } },
      },
      fetchMock,
    );
    const res = await ai.call("slide.generate", { outlineItem, sourceText }, ctx);
    expect(res.providerId).toBe("aip_glm");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    expect(records.map((r) => r.status)).toEqual(["error", "ok"]);
  });
});

describe("secrets", () => {
  it("round-trips sealed API keys", async () => {
    const sealed = await sealSecret("sk-abc", "server-secret");
    expect(sealed).not.toContain("sk-abc");
    expect(await openSecret(sealed, "server-secret")).toBe("sk-abc");
    await expect(openSecret(sealed, "wrong")).rejects.toThrow();
  });
});

describe("glossary", () => {
  it("prefers longer multi-word terms", () => {
    expect(findGlossaryTerms("A transverse wave has a wavelength").map((t) => t.term)).toEqual(["transverse wave", "wavelength"]);
  });
});
