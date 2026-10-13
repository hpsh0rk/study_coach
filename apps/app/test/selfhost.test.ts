import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MINERU_SELFHOST_PARSER } from "@kj/textbook";
import { selfhostParser } from "../src/textbook/parsers/mineru.ts";
import { e, loggedIn, seedUser, type Client } from "./client.ts";

const TEXT = "Waves carry energy from one place to another without moving matter. The wave speed equals frequency times wavelength.";
const LOSSY = "3.1 Equations of motion For an object that starts with velocity u the final velocity and the displacement are given below.";
const PDF = new TextEncoder().encode("%PDF-1.7\n% a sub-PDF stands in here\n%%EOF\n");
const BASE = "https://mineru.school.test";
const KEY = "school-mineru-key";
const MD = "KJPAGE 1\n\n## 3.1 Equations of motion\n\n$$v = u + at$$\n\nKJPAGE 2\n\n## 3.2 Graphs\n\n$$s = ut + \\frac{1}{2}at^2$$\n";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const urlOf = (input: RequestInfo | URL) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

/** A self-hosted MinerU 4 as the Worker sees it (/v1/tasks with the raw PDF). Checks the key when one is set. Nothing leaves the test. */
function school(key: string | null = KEY) {
  const seen: { method: string; url: string; auth: string | null; contentType: string | null; body: string }[] = [];
  let polls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = urlOf(input);
    if (!url.startsWith(`${BASE}/`)) throw new Error(`unexpected fetch ${url}`);
    const headers = new Headers(init?.headers);
    const body = init?.body ? await new Response(init.body as BodyInit).text() : "";
    seen.push({ method: init?.method ?? "GET", url, auth: headers.get("authorization"), contentType: headers.get("content-type"), body });
    const path = new URL(url).pathname;
    if (path === "/v1/health") return json({ version: "4.0.12" });
    if (key && headers.get("authorization") !== `Bearer ${key}`) return json({ error: { code: "invalid_api_key" } }, 401);
    const prefix = "/v1/tasks";
    if (!path.startsWith(prefix)) return json({ detail: "Not Found" }, 404);
    if (path === prefix && init?.method === "POST") return json({ task_id: "t-42", status: "queued" }, 202);
    if (path === `${prefix}/t-42`) {
      polls++;
      return json(polls < 2 ? { task_id: "t-42", status: "running", files: [] } : { task_id: "t-42", status: "completed", files: [{ status: "completed" }] });
    }
    if (path === `${prefix}/t-42/result`) return json({ status: "completed", files: [{ status: "completed", content: { markdown: MD } }] });
    return json({ detail: "Task not found" }, 404);
  });
  return seen;
}

afterEach(() => vi.restoreAllMocks());

describe("self-hosted MinerU adapter (MinerU 自部署)", () => {
  it("MinerU 4 (/v1): the upload streams the raw PDF and creates the task; poll and result follow the task id", async () => {
    const seen = school();
    const p = selfhostParser(`${BASE}/v1/`, KEY);
    expect(p.id).toBe(MINERU_SELFHOST_PARSER);
    expect(await p.detect()).toEqual({ version: "4.0.12" });
    const sub = await p.submit({ ocr: true });
    expect(sub).toEqual({ taskId: "", uploadUrl: "ocr" });
    const taskId = await p.upload(sub.uploadUrl, new Blob([PDF]).stream(), PDF.byteLength);
    expect(taskId).toBe("t-42");
    const post = seen.find((s) => s.method === "POST")!;
    expect(post.url).toBe(`${BASE}/v1/tasks?filename=pages.pdf&ocr_mode=ocr&output_formats=markdown`);
    expect(post).toMatchObject({ auth: `Bearer ${KEY}`, contentType: "application/octet-stream", body: new TextDecoder().decode(PDF) });
    expect(await p.poll(taskId!)).toEqual({ state: "running" });
    expect(await p.poll(taskId!)).toEqual({ state: "done", resultUrl: "t-42" });
    const res = await p.result("t-42", 2);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe(MD);
  });

  it("a wrong key, an unreachable server and a busy one each say so in words the teacher can pass on", async () => {
    school();
    await expect(selfhostParser(BASE, "wrong-key").upload("auto", new Blob([PDF]).stream(), PDF.byteLength)).rejects.toMatchObject({ status: 503, code: "PARSER_AUTH" });
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("connect ECONNREFUSED"));
    await expect(selfhostParser(BASE, null).submit({ ocr: false })).rejects.toMatchObject({ status: 503, code: "PARSER_UNREACHABLE" });
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    await expect(selfhostParser(BASE, null).submit({ ocr: false })).rejects.toMatchObject({ status: 503, code: "PARSER_BUSY" });
  });
});

describe("self-hosted MinerU through the routes", () => {
  let admin: Client;
  let teacher: Client;
  beforeAll(async () => {
    await seedUser("usr_sa", "selfadmin", "Admin12345", { role: "admin", mustChange: false });
    await seedUser("usr_st", "selfteacher", "Teach12345", { mustChange: false });
    admin = await loggedIn("selfadmin", "Admin12345");
    teacher = await loggedIn("selfteacher", "Teach12345");
  });

  async function newBook(sha: string): Promise<string> {
    const id = (
      await teacher.req("POST", "/api/documents", {
        filename: "kinematics.pdf",
        title: "Kinematics",
        sizeBytes: 4000,
        pageCount: 3,
        chapters: [{ id: "c0", parentId: null, level: 1, ord: 0, title: "3 Motion", pageStart: 1, pageEnd: 3, words: 60 }],
        sha256: sha,
      })
    ).json.id as string;
    await teacher.req("POST", `/api/documents/${id}/pages`, {
      pages: [
        { no: 1, text: TEXT, kind: "text" },
        { no: 2, text: LOSSY, kind: "formula-lost" },
        { no: 3, text: LOSSY, kind: "scanned" },
      ],
    });
    return id;
  }

  it("without a URL it is unconfigured: the teacher is told to ask the admin, and nothing is sent", async () => {
    const seen = school();
    expect((await admin.req("PUT", "/api/admin/parsing", { mineruMode: "selfhost" })).status).toBe(200);
    expect((await admin.req("GET", "/api/admin/parsing")).json).toMatchObject({ externalChoice: "auto", external: { state: "unconfigured", missing: "url" }, stub: false });
    expect((await admin.req("POST", "/api/admin/parsing/test")).json).toMatchObject({ ok: false });
    const id = await newBook("5".repeat(64));
    expect((await teacher.req("GET", `/api/documents/${id}`)).json.externalParser).toBeNull();
    const refused = await teacher.req("POST", `/api/documents/${id}/parse`, { pages: [2], reason: "auto" });
    expect(refused.status).toBe(403);
    expect(refused.json.error).toMatchObject({ code: "PARSER_NOT_CONFIGURED" });
    expect(refused.json.error.message).toContain("外部解析未配置");
    expect(seen).toHaveLength(0);
  });

  it("with a URL and key it turns on by itself; the URL and key never reach the browser; pages come back as mineru-selfhost text", async () => {
    const seen = school();
    expect((await admin.req("PUT", "/api/admin/parsing", { selfhostUrl: `${BASE}/v1`, selfhostKey: KEY })).status).toBe(200);
    const view = await admin.req("GET", "/api/admin/parsing");
    expect(view.json).toMatchObject({ external: { state: "on" }, mineruMode: "selfhost", selfhostUrlHint: "https://mine…", selfhostKeyHint: expect.any(String) });
    expect(JSON.stringify(view.json)).not.toContain("school.test");
    expect(JSON.stringify(view.json)).not.toContain(KEY);
    expect((await admin.req("POST", "/api/admin/parsing/test")).json).toEqual({ ok: true, message: expect.stringContaining("4.0.12") });

    const id = await newBook("6".repeat(64));
    const doc = await teacher.req("GET", `/api/documents/${id}`);
    expect(doc.json.externalParser).toEqual({ parser: MINERU_SELFHOST_PARSER, maxPagesPerJob: 20, maxBytes: 90 * 1024 * 1024 });
    expect(JSON.stringify(doc.json)).not.toContain("school.test");

    const created = await teacher.req("POST", `/api/documents/${id}/parse`, { pages: [2, 3], reason: "auto", ocr: true });
    expect(created.status).toBe(200);
    const job = created.json.job as { id: string; pages: number[] };
    const base = `/api/documents/${id}/parse/${job.id}`;
    expect((await teacher.raw("PUT", `${base}/file`, PDF, { "content-type": "application/pdf" })).status).toBe(200);
    expect((await teacher.req("GET", base)).json).toEqual({ state: "running" });
    expect((await teacher.req("GET", base)).json).toEqual({ state: "ready" });
    const md = await (await teacher.raw("GET", `${base}/result`)).text();
    expect(md).toBe(MD);
    const pages = md.split(/^KJPAGE \d+$/m).slice(1).map((text, i) => ({ no: job.pages[i]!, text: text.trim() }));
    const saved = await teacher.req("POST", `${base}/pages`, { pages });
    expect(saved.json.pages.map((p: { parser: string }) => p.parser)).toEqual([MINERU_SELFHOST_PARSER, MINERU_SELFHOST_PARSER]);
    expect(seen.filter((s) => s.method === "POST").map((s) => s.url)).toEqual([`${BASE}/v1/tasks?filename=pages.pdf&ocr_mode=ocr&output_formats=markdown`]);

    expect((await admin.req("GET", "/api/admin/parsing")).json.today).toBe(2);
    const audit = await e.DB.prepare("SELECT target FROM audit_log WHERE action = 'admin.parser_settings' AND actor_id = 'usr_sa' ORDER BY id").all<{ target: string }>();
    expect(audit.results.map((r) => r.target)).toEqual(["mode_selfhost", "selfhost"]);
  });

  it("a wrong key fails the connection test with a readable reason, and the admin can still switch it off", async () => {
    school("the-real-key");
    const check = (await admin.req("POST", "/api/admin/parsing/test")).json;
    expect(check.ok).toBe(false);
    expect(check.message).toContain("API Key");
    expect((await admin.req("PUT", "/api/admin/parsing", { externalChoice: "off" })).status).toBe(200);
    expect((await admin.req("GET", "/api/admin/parsing")).json.external).toEqual({ state: "off" });
  });
});
