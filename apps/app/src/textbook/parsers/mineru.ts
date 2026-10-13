import { MINERU_AGENT_PARSER, MINERU_PARSER, separatorText } from "@kj/textbook";
import { HttpError } from "../../http.ts";
import recorded from "./mineru-recorded.json";

/**
 * An external parser as the Worker sees it. The browser cuts the sub-PDF and reads the result; the Worker
 * only talks to the parser (its URLs send no CORS headers, and its token must stay on the server):
 * submit → stream the upload → poll → stream the result back.
 */
export interface ExternalParser {
  /** parser@version, stored in pages.parser and used as the cache key with (file sha256, page). */
  id: string;
  /** Content pages per sub-PDF; each is preceded by a separator page. */
  maxPagesPerJob: number;
  maxBytes: number;
  costMicroYuanPerPage: number;
  /** `markdown`: the result is the Markdown file. `zip`: a zip whose `full.md` is the Markdown. */
  format: "markdown" | "zip";
  submit(opts: { ocr: boolean }): Promise<{ taskId: string; uploadUrl: string }>;
  upload(uploadUrl: string, body: ReadableStream<Uint8Array>, length: number): Promise<void>;
  poll(taskId: string): Promise<{ state: "running" | "done" | "failed"; resultUrl?: string; error?: string }>;
  result(resultUrl: string, pageCount: number): Promise<Response>;
}

type Fetch = typeof fetch;
export type MineruMode = "agent" | "token" | "stub";

const AGENT_API = "https://mineru.net/api/v1/agent";
const TOKEN_API = "https://mineru.net/api/v4";
const FILE_NAME = "pages.pdf";

/** Upload and result URLs come from MinerU's responses; the Worker only follows them to MinerU's own hosts. */
export function isMineruHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "mineru.net" || u.hostname.endsWith(".mineru.net") || u.hostname.endsWith(".openxlab.org.cn"));
  } catch {
    return false;
  }
}

const busy = () => new HttpError(503, "PARSER_BUSY", "外部解析服务正忙，请稍后再试 · The external parser is busy; try again later");
const failed = (msg: string) => new HttpError(502, "PARSER_FAILED", `外部解析服务出错：${msg} · External parser error`);

async function call<T>(f: Fetch, url: string, init: RequestInit = {}): Promise<T> {
  const res = await f(url, init);
  if (res.status === 429) throw busy();
  if (!res.ok) throw failed(`HTTP ${res.status}`);
  const body = (await res.json()) as { code: number | string; msg?: string; data?: T };
  if (String(body.code) !== "0" || !body.data) throw failed(body.msg ?? String(body.code));
  return body.data;
}

function followed(url: string | undefined): string {
  if (!url || !isMineruHost(url)) throw failed("unexpected URL");
  return url;
}

async function upload(f: Fetch, uploadUrl: string, body: ReadableStream<Uint8Array>, length: number): Promise<void> {
  // The signed PUT must not carry a Content-Type; a fixed-length stream keeps Content-Length without buffering.
  const sized = new FixedLengthStream(length);
  void body.pipeTo(sized.writable).catch(() => undefined);
  const res = await f(followed(uploadUrl), { method: "PUT", body: sized.readable });
  if (!res.ok) throw failed(`upload HTTP ${res.status}`);
}

async function result(f: Fetch, resultUrl: string): Promise<Response> {
  const res = await f(followed(resultUrl));
  if (!res.ok || !res.body) throw failed(`result HTTP ${res.status}`);
  return res;
}

const STATES: Record<string, "running" | "done" | "failed"> = { done: "done", failed: "failed" };

/** Token-free agent API: one file, ≤ 20 pages (10 content pages after separators), ≤ 10 MB, Markdown result. */
export function agentParser(f: Fetch = fetch): ExternalParser {
  return {
    id: MINERU_AGENT_PARSER,
    maxPagesPerJob: 10,
    maxBytes: 10 * 1024 * 1024,
    costMicroYuanPerPage: 0,
    format: "markdown",
    async submit({ ocr }) {
      const data = await call<{ task_id: string; file_url: string }>(f, `${AGENT_API}/parse/file`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_name: FILE_NAME, language: "ch", enable_formula: true, enable_table: true, is_ocr: ocr }),
      });
      return { taskId: data.task_id, uploadUrl: followed(data.file_url) };
    },
    upload: (url, body, length) => upload(f, url, body, length),
    async poll(taskId) {
      const data = await call<{ state: string; markdown_url?: string; err_msg?: string }>(f, `${AGENT_API}/parse/${encodeURIComponent(taskId)}`);
      const state = STATES[data.state] ?? "running";
      return state === "done" ? { state, resultUrl: followed(data.markdown_url) } : state === "failed" ? { state, error: data.err_msg ?? "failed" } : { state };
    },
    result: (url) => result(f, url),
  };
}

/** Precise API with a MinerU token: `vlm` model, zip result (`full.md` inside). Kept to 20 content pages per job for the Worker's CPU budget when saving. */
export function tokenParser(token: string, f: Fetch = fetch): ExternalParser {
  const auth = { authorization: `Bearer ${token}` };
  return {
    id: MINERU_PARSER,
    maxPagesPerJob: 20,
    maxBytes: 90 * 1024 * 1024,
    costMicroYuanPerPage: 0,
    format: "zip",
    async submit({ ocr }) {
      const data = await call<{ batch_id: string; file_urls: string[] }>(f, `${TOKEN_API}/file-urls/batch`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ files: [{ name: FILE_NAME, is_ocr: ocr }], model_version: "vlm", language: "ch", enable_formula: true, enable_table: true }),
      });
      return { taskId: data.batch_id, uploadUrl: followed(data.file_urls[0]) };
    },
    upload: (url, body, length) => upload(f, url, body, length),
    async poll(taskId) {
      const data = await call<{ extract_result: { state: string; full_zip_url?: string; err_msg?: string }[] | { state: string; full_zip_url?: string; err_msg?: string } }>(
        f,
        `${TOKEN_API}/extract-results/batch/${encodeURIComponent(taskId)}`,
        { headers: auth },
      );
      const row = Array.isArray(data.extract_result) ? data.extract_result[0] : data.extract_result;
      const state = STATES[row?.state ?? ""] ?? "running";
      return state === "done" ? { state, resultUrl: followed(row?.full_zip_url) } : state === "failed" ? { state, error: row?.err_msg ?? "failed" } : { state };
    },
    result: (url) => result(f, url),
  };
}

/**
 * Tests and E2E: the agent API replayed from a recorded exchange (mineru-recorded.json: the kinematics fixture's
 * page 2). Every page of a job gets that page's Markdown. Nothing leaves the Worker.
 */
export function stubParser(): ExternalParser {
  const real = agentParser();
  const page = recorded.markdown.split(/^KJPAGE 1$/m)[1] ?? "";
  return {
    ...real,
    async submit() {
      return { taskId: `stub-${crypto.randomUUID()}`, uploadUrl: "https://oss-mineru.openxlab.org.cn/stub" };
    },
    async upload(_url, body) {
      await body.pipeTo(new WritableStream());
    },
    async poll() {
      return { state: "done", resultUrl: "https://cdn-mineru.openxlab.org.cn/stub/full.md" };
    },
    async result(_url, pageCount) {
      const md = Array.from({ length: pageCount }, (_, i) => `${separatorText(i + 1)}\n${page}`).join("\n");
      return new Response(md, { headers: { "content-type": "text/markdown; charset=utf-8" } });
    },
  };
}
