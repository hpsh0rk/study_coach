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
    });
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
    };
    await admin.req("POST", "/api/admin/ai/providers", { kind: "deepseek", name: "DeepSeek", apiKey: secrets.text, model: "deepseek-chat" });
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
});
