import { beforeAll, describe, expect, it } from "vitest";
import { MINERU_AGENT_PARSER, MINERU_PARSER } from "@kj/textbook";
import recorded from "../src/textbook/parsers/mineru-recorded.json";
import { agentParser, isMineruHost, tokenParser } from "../src/textbook/parsers/mineru.ts";
import { chinaDay, PARSE_LIMITS, parseAllowance } from "../src/textbook/parsers/settings.ts";
import { e, loggedIn, seedUser, type Client } from "./client.ts";

const TEXT = "Waves carry energy from one place to another without moving matter. The wave speed equals frequency times wavelength.";
const LOSSY = "3.1 Equations of motion For an object that starts with velocity u the final velocity and the displacement are given below.";
const PDF = new TextEncoder().encode("%PDF-1.7\n% a sub-PDF stands in here; the stub never reads it\n%%EOF\n");

const book = (sha256: string) => ({
  filename: "kinematics.pdf",
  title: "Kinematics",
  sizeBytes: 4000,
  pageCount: 4,
  chapters: [{ id: "c0", parentId: null, level: 1, ord: 0, title: "3 Motion", pageStart: 1, pageEnd: 4, words: 80 }],
  sha256,
});
const kindsPages = {
  pages: [
    { no: 1, text: TEXT, kind: "text" },
    { no: 2, text: LOSSY, kind: "formula-lost" },
    { no: 3, text: TEXT, kind: "table" },
    { no: 4, text: LOSSY, kind: "formula-lost" },
  ],
};

let admin: Client;
let t7: Client;
let t8: Client;

async function newBook(c: Client, sha: string): Promise<string> {
  const id = (await c.req("POST", "/api/documents", book(sha))).json.id as string;
  await c.req("POST", `/api/documents/${id}/pages`, kindsPages);
  return id;
}

/** Create → upload → poll → result → save, as the browser does it. */
async function runJob(c: Client, docId: string, pages: number[], reason: "auto" | "refine" = "auto") {
  const created = await c.req("POST", `/api/documents/${docId}/parse`, { pages, reason });
  expect(created.status).toBe(200);
  const job = created.json.job as { id: string; pages: number[] };
  const base = `/api/documents/${docId}/parse/${job.id}`;
  expect((await c.raw("PUT", `${base}/file`, PDF, { "content-type": "application/pdf" })).status).toBe(200);
  expect((await c.req("GET", base)).json).toEqual({ state: "ready" });
  const result = await c.raw("GET", `${base}/result`);
  expect(result.headers.get("content-type")).toContain("text/markdown");
  const md = await result.text();
  const saved = await c.req("POST", `${base}/pages`, { pages: job.pages.map((no, i) => ({ no, text: md.split(/^KJPAGE \d+$/m)[i + 1]!.trim() })) });
  return { job, md, saved };
}

beforeAll(async () => {
  await seedUser("usr_pa", "parseadmin", "Admin12345", { role: "admin", mustChange: false });
  await seedUser("usr_t7", "teacher7", "Teach12345", { mustChange: false });
  await seedUser("usr_t8", "teacher8", "Teach12345", { mustChange: false });
  admin = await loggedIn("parseadmin", "Admin12345");
  t7 = await loggedIn("teacher7", "Teach12345");
  t8 = await loggedIn("teacher8", "Teach12345");
});

describe("external parser switch (外部解析服务)", () => {
  it("follows the configuration by default (the agent API needs no key, so it is on); admins choose auto / on / off, teachers cannot", async () => {
    const id = await newBook(t7, "1".repeat(64));
    expect((await t7.req("GET", `/api/documents/${id}`)).json.externalParser).toMatchObject({ parser: MINERU_AGENT_PARSER });
    expect((await admin.req("GET", "/api/admin/parsing")).json).toMatchObject({ externalChoice: "auto", external: { state: "on" }, mineruMode: "agent", stub: true, limits: PARSE_LIMITS });
    expect((await t7.req("PUT", "/api/admin/parsing", { externalChoice: "off" })).status).toBe(403);

    expect((await admin.req("PUT", "/api/admin/parsing", { externalChoice: "off" })).status).toBe(200);
    expect((await t7.req("GET", `/api/documents/${id}`)).json.externalParser).toBeNull();
    const refused = await t7.req("POST", `/api/documents/${id}/parse`, { pages: [2], reason: "auto" });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe("PARSER_OFF");
    expect((await admin.req("GET", "/api/admin/parsing")).json).toMatchObject({ externalChoice: "off", external: { state: "off" } });
  });

  it("when on: must-fix pages go through the stubbed MinerU and come back as text by page", async () => {
    expect((await admin.req("PUT", "/api/admin/parsing", { externalChoice: "on" })).status).toBe(200);
    const id = await newBook(t7, "2".repeat(64));
    expect((await t7.req("GET", `/api/documents/${id}`)).json.externalParser).toEqual({ parser: MINERU_AGENT_PARSER, maxPagesPerJob: 10, maxBytes: 10 * 1024 * 1024, format: "markdown" });

    // Readable pages are not sent; refine-kind pages only when the teacher asks.
    expect((await t7.req("POST", `/api/documents/${id}/parse`, { pages: [1], reason: "auto" })).json.error).toMatchObject({ code: "PAGES_NOT_ELIGIBLE", detail: { pages: [1] } });
    expect((await t7.req("POST", `/api/documents/${id}/parse`, { pages: [3], reason: "auto" })).status).toBe(409);

    const { md, saved } = await runJob(t8, await newBook(t8, "3".repeat(64)), [2, 4]);
    expect(md).toContain("\\mathtt { v } = \\mathtt { u }");
    expect(saved.json.pages).toEqual([expect.objectContaining({ no: 2, parser: MINERU_AGENT_PARSER }), expect.objectContaining({ no: 4, parser: MINERU_AGENT_PARSER })]);
  });

  it("stores the parser's text; the page is then fixed: no paste, no second job", async () => {
    const id = await newBook(t7, "4".repeat(64));
    const { job } = await runJob(t7, id, [2]);
    const doc = (await t7.req("GET", `/api/documents/${id}`)).json;
    expect(doc.pageParsers).toEqual({ 2: MINERU_AGENT_PARSER });
    expect(doc.pageKinds).toEqual({ 2: "formula-lost", 3: "table", 4: "formula-lost" });
    expect((await t7.req("GET", `/api/documents/${id}/pages/2`)).json.text).toContain("\\mathsf { s } = \\mathrm { u t }");
    expect((await t7.req("POST", `/api/documents/${id}/pages/paste`, { start: 2, end: 2, text: "again" })).status).toBe(409);
    expect((await t7.req("POST", `/api/documents/${id}/parse`, { pages: [2], reason: "auto" })).status).toBe(409);
    // A finished job cannot be replayed, and nobody else can touch it.
    expect((await t7.req("POST", `/api/documents/${id}/parse/${job.id}/pages`, { pages: [{ no: 2, text: "x" }] })).status).toBe(409);
    expect((await t8.req("GET", `/api/documents/${id}/parse/${job.id}`)).status).toBe(404);
  });

  it("only the job's pages are written; refine pages go when asked", async () => {
    const id = await newBook(t7, "5".repeat(64));
    const job = (await t7.req("POST", `/api/documents/${id}/parse`, { pages: [3], reason: "refine" })).json.job;
    await t7.raw("PUT", `/api/documents/${id}/parse/${job.id}/file`, PDF);
    await t7.req("GET", `/api/documents/${id}/parse/${job.id}`);
    expect((await t7.req("POST", `/api/documents/${id}/parse/${job.id}/pages`, { pages: [{ no: 1, text: "not in the job" }] })).status).toBe(400);
    expect((await t7.req("POST", `/api/documents/${id}/parse/${job.id}/pages`, { pages: [{ no: 3, text: "t | v\n1 | 2" }] })).json.pages).toEqual([expect.objectContaining({ no: 3, parser: MINERU_AGENT_PARSER })]);
    expect((await t7.req("GET", `/api/documents/${id}/pages/1`)).json.parser).toBe("pdfjs/1");
  });

  it("reuses pages another copy of the same file already got (same organisation), without sending them", async () => {
    const sha = "6".repeat(64);
    await runJob(t7, await newBook(t7, sha), [2]);
    const other = await newBook(t8, sha);
    const res = await t8.req("POST", `/api/documents/${other}/parse`, { pages: [2], reason: "auto" });
    expect(res.json.job).toBeNull();
    expect(res.json.reused).toEqual([expect.objectContaining({ no: 2, parser: MINERU_AGENT_PARSER })]);
    expect((await t8.req("GET", `/api/documents/${other}/pages/2`)).json.text).toContain("\\mathtt { v }");
    const sent = await e.DB.prepare("SELECT COUNT(*) AS n FROM parse_usage WHERE document_id = ?").bind(other).first<{ n: number }>();
    expect(sent!.n).toBe(0);
  });

  it("guardrails: 300 automatic pages per book, 300 per teacher per day, 900 site-wide per day", async () => {
    const id = await newBook(t8, "7".repeat(64));
    const insert = (user: string, doc: string, reason: string, pages: number, day = chinaDay()) =>
      e.DB.prepare("INSERT INTO parse_usage (id, org_id, user_id, document_id, parser, reason, pages, page_count, state, task_id, upload_url, day, created_at) VALUES (?, 'org_default', ?, ?, 'mineru-agent/1', ?, '[]', ?, 'done', 't', 'u', ?, 0)")
        .bind(`pjob_${crypto.randomUUID()}`, user, doc, reason, pages, day)
        .run();

    await insert("usr_t8", id, "auto", 300, "2026-01-01");
    const book = await t8.req("POST", `/api/documents/${id}/parse`, { pages: [2], reason: "auto" });
    expect(book.status).toBe(429);
    expect(book.json.error).toMatchObject({ code: "PARSE_QUOTA", detail: { scope: "book", remaining: 0 } });
    expect((await t8.req("POST", `/api/documents/${id}/parse`, { pages: [2], reason: "refine" })).status).toBe(200);

    const fresh = await newBook(t8, "8".repeat(64));
    const today = await e.DB.prepare("SELECT COALESCE(SUM(page_count), 0) AS n FROM parse_usage WHERE user_id = 'usr_t8' AND day = ?").bind(chinaDay()).first<{ n: number }>();
    await insert("usr_t8", fresh, "refine", PARSE_LIMITS.userDayPages - today!.n - 1);
    expect((await t8.req("POST", `/api/documents/${fresh}/parse`, { pages: [2, 4], reason: "auto" })).json.error).toMatchObject({ code: "PARSE_QUOTA", detail: { scope: "user", remaining: 1 } });

    await insert("usr_pa", fresh, "refine", PARSE_LIMITS.siteDayPages);
    expect((await t7.req("POST", `/api/documents/${await newBook(t7, "9".repeat(64))}/parse`, { pages: [2], reason: "auto" })).json.error).toMatchObject({ code: "PARSE_QUOTA", detail: { scope: "site" } });
    await e.DB.prepare("DELETE FROM parse_usage WHERE task_id = 't'").run();
  });

  it("money: paid parsing is off by default, then bounded by the monthly budget and the per-book cap (402); the site-wide day counts MinerU only", () => {
    const used = { bookAutoPages: 0, bookCostMicroYuan: 4_500_000, userDayPages: 0, siteDayPages: 900, orgMonthCostMicroYuan: 2_000_000 };
    const off = { paidEnabled: false, monthlyBudgetMicroYuan: 0 };
    const on = { paidEnabled: true, monthlyBudgetMicroYuan: 3_000_000 };
    expect(parseAllowance(used, { pages: 5, reason: "auto", costMicroYuan: 0, mineru: false }, off)).toBeNull();
    expect(parseAllowance(used, { pages: 5, reason: "auto", costMicroYuan: 0, mineru: true }, off)).toMatchObject({ status: 429, scope: "site" });
    expect(parseAllowance(used, { pages: 1, reason: "auto", costMicroYuan: 900, mineru: false }, off)).toEqual({ status: 402, code: "PARSE_BUDGET", scope: "off", remaining: 0 });
    expect(parseAllowance(used, { pages: 1, reason: "auto", costMicroYuan: 900, mineru: false }, on)).toBeNull();
    expect(parseAllowance(used, { pages: 5, reason: "refine", costMicroYuan: 1_200_000, mineru: false }, on)).toEqual({ status: 402, code: "PARSE_BUDGET", scope: "month", remaining: 1_000_000 });
    expect(parseAllowance(used, { pages: 5, reason: "refine", costMicroYuan: 600_000, mineru: false }, on)).toEqual({ status: 402, code: "PARSE_BUDGET", scope: "book", remaining: 500_000 });
  });

  it("turning it off stops new jobs and jobs already started", async () => {
    const id = await newBook(t7, "a".repeat(64));
    const job = (await t7.req("POST", `/api/documents/${id}/parse`, { pages: [2], reason: "auto" })).json.job;
    await admin.req("PUT", "/api/admin/parsing", { externalChoice: "off" });
    expect((await t7.raw("PUT", `/api/documents/${id}/parse/${job.id}/file`, PDF)).status).toBe(403);
    expect((await t7.req("POST", `/api/documents/${id}/parse`, { pages: [4], reason: "auto" })).status).toBe(403);
    expect((await t7.req("GET", `/api/documents/${id}`)).json.externalParser).toBeNull();
    const audit = await e.DB.prepare("SELECT target FROM audit_log WHERE action = 'admin.parser_settings' ORDER BY id").all<{ target: string }>();
    expect(audit.results.map((r) => r.target)).toEqual(["external_off", "external_on", "external_off"]);
  });
});

describe("MinerU adapters (recorded exchange, no network)", () => {
  /** Replays responses in order and records what was asked. */
  function replay(responses: Response[]) {
    const asked: { url: string; init: RequestInit | undefined }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      asked.push({ url, init });
      return responses.shift() ?? new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    return { f, asked };
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("agent API: submit → upload → poll → Markdown, as recorded", async () => {
    const { f, asked } = replay([json(recorded.submit), new Response(null, { status: 200 }), json(recorded.polls[0]), json(recorded.polls[1]), new Response(recorded.markdown)]);
    const p = agentParser(f);
    const task = await p.submit({ ocr: false });
    expect(asked[0]!.url).toBe("https://mineru.net/api/v1/agent/parse/file");
    expect(JSON.parse(asked[0]!.init!.body as string)).toEqual(recorded.request.body);
    expect(task).toEqual({ taskId: recorded.submit.data.task_id, uploadUrl: recorded.submit.data.file_url });
    await p.upload(task.uploadUrl, new Blob([PDF]).stream(), PDF.byteLength);
    expect(asked[1]!.init!.method).toBe("PUT");
    expect(new Headers(asked[1]!.init!.headers).get("content-type")).toBeNull();
    expect(await p.poll(task.taskId)).toEqual({ state: "running" });
    const done = await p.poll(task.taskId);
    expect(done).toEqual({ state: "done", resultUrl: recorded.polls[1]!.data.markdown_url });
    expect(await (await p.result(done.resultUrl!, 1)).text()).toContain("KJPAGE 1");
  });

  it("refuses URLs outside MinerU, and reports rate limits as busy", async () => {
    expect(isMineruHost("https://cdn-mineru.openxlab.org.cn/pdf/x/full.md")).toBe(true);
    // The agent and token APIs hand out signed upload URLs on MinerU's own OSS bucket (seen live 2026-10-13).
    expect(isMineruHost("https://mineru.oss-cn-shanghai.aliyuncs.com/api-upload/extract/x.pdf?Signature=s")).toBe(true);
    expect(isMineruHost("https://evil.example/full.md")).toBe(false);
    expect(isMineruHost("https://other-bucket.oss-cn-shanghai.aliyuncs.com/x")).toBe(false);
    expect(isMineruHost("https://mineru.oss-cn-shanghai.aliyuncs.com.evil.example/x")).toBe(false);
    expect(isMineruHost("http://mineru.net/x")).toBe(false);
    const bad = replay([json({ code: 0, data: { task_id: "t", file_url: "https://evil.example/upload" } })]);
    await expect(agentParser(bad.f).submit({ ocr: false })).rejects.toMatchObject({ code: "PARSER_FAILED" });
    const limited = replay([new Response("", { status: 429 })]);
    await expect(agentParser(limited.f).submit({ ocr: true })).rejects.toMatchObject({ code: "PARSER_BUSY", status: 503 });
  });

  it("token API: batch upload URL with the token, zip result", async () => {
    const { f, asked } = replay([
      json({ code: 0, data: { batch_id: "b1", file_urls: ["https://other-bucket.oss-cn-shanghai.aliyuncs.com/x"] } }),
      json({ code: 0, data: { batch_id: "b1", file_urls: ["https://mineru.oss-cn-shanghai.aliyuncs.com/x"] } }),
      json({ code: 0, data: { extract_result: [{ state: "done", full_zip_url: "https://cdn-mineru.openxlab.org.cn/pdf/b1.zip" }] } }),
    ]);
    const p = tokenParser("tok_secret", f);
    expect(p.id).toBe(MINERU_PARSER);
    await expect(p.submit({ ocr: false })).rejects.toMatchObject({ code: "PARSER_FAILED" });
    const task = await p.submit({ ocr: true });
    expect(new Headers(asked[1]!.init!.headers).get("authorization")).toBe("Bearer tok_secret");
    expect(JSON.parse(asked[1]!.init!.body as string)).toMatchObject({ files: [{ name: "pages.pdf", is_ocr: true }], model_version: "vlm" });
    expect(await p.poll(task.taskId)).toEqual({ state: "done", resultUrl: "https://cdn-mineru.openxlab.org.cn/pdf/b1.zip" });
    expect(asked[2]!.url).toBe("https://mineru.net/api/v4/extract-results/batch/b1");
  });
});
