import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.ts";
import { externalNote } from "../src/textbook/parsers/jobs.ts";
import { parserSettingsOf } from "../src/textbook/parsers/settings.ts";
import { e, loggedIn, seedUser, type Client } from "./client.ts";

let admin: Client;
let teacher: Client;

const TEXT = "Waves carry energy from one place to another without moving matter. The wave speed equals frequency times wavelength.";

async function newBook(): Promise<string> {
  const id = (
    await teacher.req("POST", "/api/documents", {
      filename: "waves.pdf",
      title: "Waves",
      sizeBytes: 3000,
      pageCount: 2,
      chapters: [{ id: "c0", parentId: null, level: 1, ord: 0, title: "1 Waves", pageStart: 1, pageEnd: 2, words: 40 }],
    })
  ).json.id as string;
  await teacher.req("POST", `/api/documents/${id}/pages`, {
    pages: [
      { no: 1, text: TEXT, kind: "text" },
      { no: 2, text: TEXT, kind: "formula-lost" },
    ],
  });
  return id;
}

const status = async () => (await admin.req("GET", "/api/admin/status")).json;
const readers = async (id: string) => (await teacher.req("GET", `/api/documents/${id}`)).json.readers;

beforeAll(async () => {
  await seedUser("usr_ka", "keysadmin", "Admin12345", { role: "admin", mustChange: false });
  await seedUser("usr_kt", "keysteacher", "Teach12345", { mustChange: false });
  admin = await loggedIn("keysadmin", "Admin12345");
  teacher = await loggedIn("keysteacher", "Teach12345");
});
afterEach(() => vi.restoreAllMocks());

describe("keys and reminders", () => {
  it("the admin overview and the teacher's chapters step say which feature is off and whom to ask", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no outside calls"));
    const id = await newBook();

    expect(await status()).toEqual({
      ai: { state: "stub" },
      vision: { state: "none" },
      external: { state: "on", mode: "agent", stub: true },
      counts: { users: expect.any(Number), textbooks: expect.any(Number), lessons: expect.any(Number), parsedPagesToday: 0 },
    });
    const { counts } = (await status()) as { counts: { users: number; textbooks: number } };
    expect(counts.users).toBeGreaterThanOrEqual(2);
    expect(counts.textbooks).toBeGreaterThanOrEqual(1);
    expect(await readers(id)).toEqual({ external: null, vision: expect.stringContaining("看图模型未配置：请联系管理员在后台“AI 模型”里填写看图模型") });
    expect((await teacher.req("GET", "/api/admin/status")).status).toBe(403);

    // Tests stub MinerU's online APIs, so a missing token only shows outside the stub.
    await admin.req("PUT", "/api/admin/parsing", { mineruMode: "token" });
    expect((await status()).external).toEqual({ state: "on", mode: "token", stub: true });
    const live = { ...e, PARSER_MINERU_MODE: "agent" } as Env;
    expect(externalNote(live, await parserSettingsOf(live, "org_default"))).toMatch(/^外部解析未配置：请联系管理员在后台“外部解析服务”里填写 MinerU Token/);

    await admin.req("PUT", "/api/admin/parsing", { mineruMode: "selfhost" });
    expect((await status()).external).toEqual({ state: "unconfigured", missing: "url", mode: "selfhost", stub: false });
    expect((await readers(id)).external).toMatch(/^外部解析未配置：请联系管理员在后台“外部解析服务”里填写自部署 MinerU 的地址/);
    expect((await teacher.req("GET", `/api/documents/${id}`)).json.externalParser).toBeNull();

    await admin.req("PUT", "/api/admin/parsing", { mineruMode: "agent", externalChoice: "off" });
    expect((await status()).external).toMatchObject({ state: "off" });
    expect((await readers(id)).external).toContain("管理员关闭了外部解析服务");
    await admin.req("PUT", "/api/admin/parsing", { externalChoice: "auto" });

    // A paid vision model stays off until paid parsing is allowed; the teacher is told why.
    await admin.req("POST", "/api/admin/ai/providers", { kind: "custom", name: "Bailian", baseUrl: "https://dashscope.test/v1", apiKey: "sk-bailian-0000", model: "qwen-plus", visionModel: "qwen-vl-ocr" });
    expect(await status()).toMatchObject({ ai: { state: "live", provider: "Bailian", model: "qwen-plus" }, vision: { state: "paid_off", model: "qwen-vl-ocr", separate: false } });
    expect((await readers(id)).vision).toContain("按页收费，管理员还没有允许付费兜底");
    await admin.req("PUT", "/api/admin/parsing", { paidEnabled: true });
    expect((await status()).vision).toMatchObject({ state: "on" });
    expect((await readers(id)).vision).toBeNull();
    await admin.req("PUT", "/api/admin/parsing", { paidEnabled: false });
    await e.DB.prepare("DELETE FROM ai_providers").run();
  });

  it("no key, token, self-hosted URL or self-hosted key appears in any admin or teacher response", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no outside calls"));
    const secrets = {
      text: "sk-text-7f3a9c1e5b2d8a4f",
      vision: "glm-vision-2b8e6d4c1a9f7e3b",
      token: "mineru-token-5c1d9e7a3b8f2e6d",
      url: "http://10.20.30.40:8123",
      selfKey: "selfhost-key-8e2c6a4f1d9b7e3c",
      header: "hdr-value-4d7b1e9c6a2f",
    };
    await admin.req("POST", "/api/admin/ai/providers", { kind: "deepseek", name: "DeepSeek", apiKey: secrets.text, model: "deepseek-chat", headers: { "x-source": secrets.header } });
    await admin.req("POST", "/api/admin/ai/providers", { kind: "glm", name: "GLM", apiKey: secrets.vision, model: "glm-4.6v-flash", purpose: "vision" });
    expect((await admin.req("PUT", "/api/admin/parsing", { mineruMode: "token", token: secrets.token })).status).toBe(200);
    expect((await admin.req("PUT", "/api/admin/parsing", { selfhostUrl: secrets.url, selfhostKey: secrets.selfKey })).status).toBe(200);
    const id = await newBook();

    const responses: string[] = [];
    for (const mode of ["token", "selfhost"]) {
      await admin.req("PUT", "/api/admin/parsing", { mineruMode: mode });
      for (const path of ["/api/admin/ai", "/api/admin/parsing", "/api/admin/status", "/api/admin/audit", "/api/admin/users", "/api/auth/me"]) {
        responses.push(JSON.stringify((await admin.req("GET", path)).json));
      }
      for (const path of ["/api/auth/me", "/api/documents", `/api/documents/${id}`, "/api/lessons"]) {
        const res = await teacher.req("GET", path);
        expect(res.status).toBe(200);
        responses.push(JSON.stringify(res.json));
      }
    }
    const all = responses.join("\n");
    for (const value of [...Object.values(secrets), "10.20.30.40"]) expect(all).not.toContain(value);
    expect(all).toContain("mineru-selfhost/1");
    expect(all).toContain("http://10.2…:8123");
  });

  it("a Messages provider keeps protocol, max_tokens and custom headers server-side and sends them on 测试连接", async () => {
    const body = { kind: "custom", name: "llmbox", baseUrl: "http://llmbox.test", apiKey: "sk-llmbox-1234", model: "glm-5.3-flash", protocol: "messages", maxTokens: 31200, headers: { "x-source": "tensorhawk" } };
    const created = await admin.req("POST", "/api/admin/ai/providers", body);
    expect(created.status).toBe(201);
    const id = (created.json as { id: string }).id;
    const row = () => admin.req("GET", "/api/admin/ai").then((r) => (r.json as { providers: Record<string, unknown>[] }).providers.find((p) => p.id === id)!);
    expect(await row()).toMatchObject({ protocol: "messages", maxTokens: 31200, headerHints: { "x-source": expect.not.stringContaining("tensorhawk") } });

    expect((await admin.req("PATCH", `/api/admin/ai/providers/${id}`, { headers: { "x-source": "", "x-extra": "two" } })).status).toBe(200);
    expect(Object.keys((await row()).headerHints as object)).toEqual(["x-source", "x-extra"]);
    expect((await admin.req("POST", "/api/admin/ai/providers", { ...body, headers: { Authorization: "x" } })).status).toBe(400);

    const sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      sent.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
      const events = [
        { type: "message_start", message: { model: "glm-5.3-flash", usage: { input_tokens: 3 } } },
        { type: "content_block_delta", delta: { type: "text_delta", text: '{"ok":true}' } },
        { type: "message_stop" },
      ];
      return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    });
    const test = await admin.req("POST", `/api/admin/ai/providers/${id}/test`, {});
    expect(test.json).toMatchObject({ ok: true, model: "glm-5.3-flash" });
    expect(sent[0]).toMatchObject({ url: "http://llmbox.test/v1/messages", headers: { authorization: "Bearer sk-llmbox-1234", "x-source": "tensorhawk", "x-extra": "two" }, body: { max_tokens: 31200, stream: true } });
  });

  it("a stored key and header values never follow a changed address, protocol or self-hosted URL", async () => {
    const body = { kind: "custom", name: "gw", baseUrl: "http://gw.test", apiKey: "sk-gw-secret-1234", model: "m", headers: { "x-source": "tensorhawk" } };
    const id = (await admin.req("POST", "/api/admin/ai/providers", body)).json.id as string;
    const patch = (b: object) => admin.req("PATCH", `/api/admin/ai/providers/${id}`, b);
    expect((await patch({ baseUrl: "http://evil.test" })).json.error.code).toBe("KEY_REQUIRED");
    expect((await patch({ protocol: "messages", headers: { "x-source": "" } })).json.error.code).toBe("KEY_REQUIRED");
    expect((await patch({ protocol: "openai", maxTokens: 100 })).status).toBe(200);

    expect((await patch({ baseUrl: "http://new.test", apiKey: "sk-new-key-5678", headers: { "x-source": "" } })).status).toBe(200);
    const sent: { url: string; headers: Record<string, string> }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      sent.push({ url: String(url), headers: init!.headers as Record<string, string> });
      return Response.json({ model: "m", choices: [{ message: { content: '{"ok":true}' } }] });
    });
    await admin.req("POST", `/api/admin/ai/providers/${id}/test`, {});
    expect(sent[0]!.url.startsWith("http://new.test/")).toBe(true);
    expect(sent[0]!.headers.authorization).toBe("Bearer sk-new-key-5678");
    expect(sent[0]!.headers["x-source"]).toBeUndefined();

    expect((await admin.req("PUT", "/api/admin/parsing", { selfhostUrl: "http://mineru.school.test", selfhostKey: "selfhost-key-1" })).status).toBe(200);
    expect((await admin.req("PUT", "/api/admin/parsing", { selfhostUrl: "http://mineru.school.test" })).status).toBe(200);
    expect((await admin.req("PUT", "/api/admin/parsing", { selfhostUrl: "http://elsewhere.test" })).json.error.code).toBe("KEY_REQUIRED");
    expect((await admin.req("PUT", "/api/admin/parsing", { selfhostUrl: "http://elsewhere.test", selfhostKey: null })).status).toBe(200);
    expect((await parserSettingsOf(e, "org_default")).selfhostKeySealed).toBeNull();
    expect((await admin.req("PUT", "/api/admin/parsing", { selfhostUrl: "http://mineru.school.test" })).status).toBe(200);
  });
});
