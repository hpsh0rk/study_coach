import { MINERU_AGENT_PARSER, MINERU_PARSER, MINERU_SELFHOST_PARSER, separatorText } from "@kj/textbook";
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
  /** Returns the task id when the upload itself creates the task (self-hosted servers); the job then polls that id. */
  upload(uploadUrl: string, body: ReadableStream<Uint8Array>, length: number): Promise<string | void>;
  poll(taskId: string): Promise<{ state: "running" | "done" | "failed"; resultUrl?: string; error?: string }>;
  result(resultUrl: string, pageCount: number): Promise<Response>;
}

type Fetch = typeof fetch;
export type MineruMode = "agent" | "token" | "selfhost" | "stub";

const AGENT_API = "https://mineru.net/api/v1/agent";
const TOKEN_API = "https://mineru.net/api/v4";
const FILE_NAME = "pages.pdf";

/**
 * Upload and result URLs come from MinerU's responses; the Worker only follows them to MinerU's own hosts.
 * Signed upload URLs point at MinerU's Aliyun OSS bucket (`mineru.oss-cn-shanghai.aliyuncs.com`); results at openxlab.
 */
export function isMineruHost(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname;
    return (
      u.protocol === "https:" &&
      (host === "mineru.net" || host.endsWith(".mineru.net") || host.endsWith(".openxlab.org.cn") || /^mineru\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(host))
    );
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
 * A self-hosted MinerU server (the school's own `mineru-kit api-server` / `mineru-api`). Two generations speak
 * different paths, found once per job from the public health endpoint:
 * - `v1` (MinerU ≥ 4): `POST /v1/tasks` with the raw PDF → `GET /v1/tasks/{id}` → `GET /v1/tasks/{id}/result`
 *   (JSON, `files[0].content.markdown`).
 * - `v3` (MinerU 3.x): `POST /tasks` multipart → `GET /tasks/{id}` → `GET /tasks/{id}/result` (JSON, `results.<name>.md_content`).
 * The optional key goes as `Authorization: Bearer` to the configured origin only. Upload creates the task, so
 * submit only records the API generation and OCR choice (in uploadUrl) and upload returns the task id.
 */
export type SelfhostApi = "v1" | "v3";

const unreachable = (why: string) =>
  new HttpError(503, "PARSER_UNREACHABLE", `连不上学校自部署的 MinerU（${why}），请联系管理员检查后台填写的地址 · Cannot reach the self-hosted MinerU`);
const rejected = () => new HttpError(503, "PARSER_AUTH", "自部署的 MinerU 拒绝了请求：后台填写的 API Key 不对或没填，请联系管理员 · The self-hosted MinerU rejected the API key");

/** Base URL as entered: trailing slashes and a trailing /v1 dropped (requests add their own paths). */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function selfhostParser(baseUrl: string, apiKey: string | null, f: Fetch = fetch): ExternalParser & { detect(): Promise<{ api: SelfhostApi; version: string | null }> } {
  const base = normalizeBaseUrl(baseUrl);
  const auth: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await f(`${base}${path}`, { ...init, headers: { ...auth, ...(init.headers as Record<string, string> | undefined) } });
    } catch {
      throw unreachable("网络不通");
    }
    if (res.status === 401 || res.status === 403) throw rejected();
    if (res.status === 429 || res.status === 503) throw busy();
    return res;
  }
  async function json<T>(path: string, init?: RequestInit, okStatuses = [200, 202]): Promise<T> {
    const res = await send(path, init);
    if (!okStatuses.includes(res.status)) throw failed(`HTTP ${res.status}`);
    try {
      return (await res.json()) as T;
    } catch {
      throw failed("not JSON");
    }
  }
  const split = (taskId: string): [SelfhostApi, string] => {
    const [api, id] = [taskId.slice(0, 2), taskId.slice(3)];
    if ((api !== "v1" && api !== "v3") || !id) throw failed("bad task id");
    return [api, encodeURIComponent(id)];
  };
  async function detect(): Promise<{ api: SelfhostApi; version: string | null }> {
    const v1 = await send("/v1/health");
    if (v1.ok) return { api: "v1", version: ((await v1.json().catch(() => ({}))) as { version?: string }).version ?? null };
    const v3 = await send("/health");
    if (v3.ok) return { api: "v3", version: ((await v3.json().catch(() => ({}))) as { version?: string }).version ?? null };
    throw unreachable(`健康检查 HTTP ${v1.status}`);
  }

  return {
    id: MINERU_SELFHOST_PARSER,
    maxPagesPerJob: 20,
    maxBytes: 90 * 1024 * 1024,
    costMicroYuanPerPage: 0,
    format: "markdown",
    detect,
    async submit({ ocr }) {
      const { api } = await detect();
      return { taskId: "", uploadUrl: `${api};${ocr ? "ocr" : "auto"}` };
    },
    async upload(uploadUrl, body, length) {
      const [api, mode] = uploadUrl.split(";") as [SelfhostApi, "ocr" | "auto"];
      let created: { task_id?: unknown };
      if (api === "v1") {
        const sized = new FixedLengthStream(length);
        void body.pipeTo(sized.writable).catch(() => undefined);
        const query = new URLSearchParams({ filename: FILE_NAME, ocr_mode: mode, output_formats: "markdown" });
        created = await json(`/v1/tasks?${query}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: sized.readable });
      } else {
        const boundary = `kj${crypto.randomUUID().replace(/-/g, "")}`;
        const field = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
        const enc = new TextEncoder();
        const head = enc.encode(
          field("lang_list", "ch") +
            field("parse_method", mode) +
            field("formula_enable", "true") +
            field("table_enable", "true") +
            field("return_md", "true") +
            `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${FILE_NAME}"\r\nContent-Type: application/pdf\r\n\r\n`,
        );
        const tail = enc.encode(`\r\n--${boundary}--\r\n`);
        const sized = new FixedLengthStream(head.byteLength + length + tail.byteLength);
        void (async () => {
          const w = sized.writable.getWriter();
          await w.write(head);
          const r = body.getReader();
          for (let c = await r.read(); !c.done; c = await r.read()) await w.write(c.value);
          await w.write(tail);
          await w.close();
        })().catch(() => undefined);
        created = await json("/tasks", { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body: sized.readable });
      }
      if (typeof created.task_id !== "string" || !created.task_id) throw failed("no task_id");
      return `${api}:${created.task_id}`;
    },
    async poll(taskId) {
      const [api, id] = split(taskId);
      if (api === "v1") {
        const t = await json<{ status?: string; files?: { status?: string; error?: { message?: string } | null }[] }>(`/v1/tasks/${id}`, undefined, [200]);
        if (t.status === "queued" || t.status === "running") return { state: "running" };
        const file = t.files?.[0];
        if ((t.status === "completed" || t.status === "partial") && file?.status === "completed") return { state: "done", resultUrl: taskId };
        return { state: "failed", error: file?.error?.message ?? t.status ?? "failed" };
      }
      const t = await json<{ status?: string; error?: string | null }>(`/tasks/${id}`, undefined, [200]);
      if (t.status === "completed") return { state: "done", resultUrl: taskId };
      if (t.status === "failed") return { state: "failed", error: t.error ?? "failed" };
      return { state: "running" };
    },
    async result(resultUrl) {
      const [api, id] = split(resultUrl);
      let md: unknown;
      if (api === "v1") {
        const r = await json<{ files?: { content?: { markdown?: unknown } }[] }>(`/v1/tasks/${id}/result`, undefined, [200]);
        md = r.files?.[0]?.content?.markdown;
      } else {
        const r = await json<{ results?: Record<string, { md_content?: unknown }> }>(`/tasks/${id}/result`, undefined, [200]);
        md = Object.values(r.results ?? {})[0]?.md_content;
      }
      if (typeof md !== "string") throw failed("no markdown in result");
      return new Response(md, { headers: { "content-type": "text/markdown; charset=utf-8" } });
    },
  };
}

export interface ConnectionCheck {
  ok: boolean;
  message: string;
}

/**
 * The admin's "测试连接": one cheap request that proves the server answers and accepts the key, without
 * sending a page. Online APIs are asked for a task that does not exist; a self-hosted server for its health
 * and then (with the key) for a task that does not exist.
 */
export async function checkConnection(mode: MineruMode, parser: ExternalParser, token: string | null, f: Fetch = fetch): Promise<ConnectionCheck> {
  try {
    if (mode === "stub") return { ok: true, message: "测试环境：用录制好的 MinerU 返回结果，不会真正连接 · Stubbed" };
    if (mode === "selfhost") {
      const sh = parser as ReturnType<typeof selfhostParser>;
      const { api, version } = await sh.detect();
      await sh.poll(`${api}:kj-connection-test`).catch((err: unknown) => {
        if (err instanceof HttpError && err.code === "PARSER_AUTH") throw err;
      });
      return { ok: true, message: `已连上自部署 MinerU${version ? ` ${version}` : ""}（${api === "v1" ? "/v1 接口，MinerU 4+" : "旧版 /tasks 接口，MinerU 3.x"}）· Connected` };
    }
    if (mode === "agent") {
      const res = await f(`${AGENT_API}/parse/kj-connection-test`);
      if (res.status >= 500) return { ok: false, message: `MinerU 免费接口暂时不可用（HTTP ${res.status}）· Unavailable` };
      return { ok: true, message: "能连上 MinerU 免费轻量接口（不需要 Token）· Reachable" };
    }
    const res = await f(`${TOKEN_API}/extract-results/batch/kj-connection-test`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json().catch(() => ({}))) as { code?: number | string; msg?: string };
    if (res.status === 401 || res.status === 403 || ["A0202", "A0211"].includes(String(body.code))) {
      return { ok: false, message: `MinerU 不认这个 Token（${body.msg ?? `HTTP ${res.status}`}），请重新填写 · Token rejected` };
    }
    if (res.status >= 500) return { ok: false, message: `MinerU 精准接口暂时不可用（HTTP ${res.status}）· Unavailable` };
    return { ok: true, message: "Token 有效，能连上 MinerU 精准接口 · Token accepted" };
  } catch (err) {
    return { ok: false, message: err instanceof HttpError ? err.message : `连接失败：${(err as Error).message}` };
  }
}

/** The URL as the admin page shows it after saving: scheme, the start of the host and the port. */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.length > 6 ? `${u.hostname.slice(0, 4)}…` : u.hostname;
    return `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "…";
  }
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
      return { taskId: `stub-${crypto.randomUUID()}`, uploadUrl: "https://mineru.oss-cn-shanghai.aliyuncs.com/stub" };
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
