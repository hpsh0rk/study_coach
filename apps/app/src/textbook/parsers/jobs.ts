import { and, eq, inArray, ne } from "drizzle-orm";
import { isMustFix, MINERU_SELFHOST_PARSER, PDFJS_PARSER, pageFacts, REFINE_KINDS, type PageFacts } from "@kj/textbook";
import { newId } from "@kj/schema";
import { db } from "../../db/index.ts";
import type { Env, SessionUser } from "../../env.ts";
import { HttpError } from "../../http.ts";
import type { TextbookRow } from "../index.ts";
import { documents, pages, parseUsage } from "../tables.ts";
import type { ExternalParser } from "./mineru.ts";
import { chinaDay, externalParserFor, externalState, parseAllowance, parserSettingsOf, parseUsed, refusalMessage, type ExternalState, type ParserSettings } from "./settings.ts";

export type ParseReason = "auto" | "refine";
export type JobRow = typeof parseUsage.$inferSelect;

/** What the browser needs to cut and send a sub-PDF, or null while "外部解析服务" is off. */
export interface ExternalParserInfo {
  parser: string;
  maxPagesPerJob: number;
  maxBytes: number;
  format: "markdown" | "zip";
}

const info = (p: ExternalParser): ExternalParserInfo => ({ parser: p.id, maxPagesPerJob: p.maxPagesPerJob, maxBytes: p.maxBytes, format: p.format });

export async function externalParserInfo(env: Env, orgId: string): Promise<ExternalParserInfo | null> {
  try {
    const parser = await externalParserFor(env, await parserSettingsOf(env, orgId));
    return parser && info(parser);
  } catch {
    return null;
  }
}

/** Why there is no external parser, in words a teacher can act on (ask the admin). */
export function externalOffMessage(state: Exclude<ExternalState, { state: "on" }>): string {
  if (state.state === "off") return "管理员关闭了外部解析服务 · External parsing is off";
  return state.missing === "url"
    ? "外部解析未配置：请联系管理员在后台“外部解析服务”里填写自部署 MinerU 的地址 · External parser not configured"
    : "外部解析未配置：请联系管理员在后台“外部解析服务”里填写 MinerU Token · External parser not configured";
}

/** For the chapters step: why the external parser cannot take pages right now, or null when it can. Holds no secret. */
export function externalNote(env: Env, settings: ParserSettings): string | null {
  const state = externalState(env, settings);
  return state.state === "on" ? null : externalOffMessage(state);
}

async function parserOf(env: Env, user: SessionUser): Promise<ExternalParser> {
  const settings = await parserSettingsOf(env, user.orgId);
  const parser = await externalParserFor(env, settings);
  if (parser) return parser;
  const state = externalState(env, settings);
  throw new HttpError(403, state.state === "off" ? "PARSER_OFF" : "PARSER_NOT_CONFIGURED", externalOffMessage(state as Exclude<ExternalState, { state: "on" }>));
}

/** Must-fix pages still holding pdf.js text go without asking; refine-kind pages only when the teacher asks. */
export function eligible(reason: ParseReason, p: { kind: string | null; parser: string }): boolean {
  if (p.parser !== PDFJS_PARSER) return false;
  const kind = p.kind as Parameters<typeof isMustFix>[0];
  return isMustFix(kind) || (reason === "refine" && !!kind && REFINE_KINDS.includes(kind));
}

export type Saved = { no: number; parser: string } & PageFacts;

/** Pages another copy of the same file (same organisation) already got from this parser: copied, not sent again. */
export async function reuseParsed(env: Env, doc: TextbookRow, parser: string, nos: number[]): Promise<Saved[]> {
  if (!doc.fileSha256 || !nos.length) return [];
  const d = db(env);
  const found = await d
    .selectDistinct({ no: pages.no, text: pages.text })
    .from(pages)
    .innerJoin(documents, eq(documents.id, pages.documentId))
    .where(and(eq(documents.orgId, doc.orgId), eq(documents.fileSha256, doc.fileSha256), ne(documents.id, doc.id), eq(pages.parser, parser), inArray(pages.no, nos)));
  const byNo = new Map(found.map((r) => [r.no, r.text]));
  const saved = [...byNo].map(([no, text]) => ({ no, ...pageFacts(text), parser }));
  if (saved.length) await writeParsed(env, doc.id, saved.map((s) => ({ ...s, text: byNo.get(s.no)! })));
  return saved;
}

export async function writeParsed(env: Env, documentId: string, rows: (Saved & { text: string })[]): Promise<void> {
  const d = db(env);
  await d.batch(
    rows.map(({ no, ...row }) => d.update(pages).set(row).where(and(eq(pages.documentId, documentId), eq(pages.no, no), eq(pages.parser, PDFJS_PARSER)))) as [any, ...any[]],
  );
}

/**
 * Starts re-reading `nos` with the external parser: pages a copy of the same file already has are copied,
 * the rest become one job (a sub-PDF the browser uploads next) if the guardrails allow it.
 */
export async function createParseJob(
  env: Env,
  user: SessionUser,
  doc: TextbookRow,
  req: { pages: number[]; reason: ParseReason; ocr: boolean },
): Promise<{ reused: Saved[]; job: { id: string; pages: number[] } | null; parser: ExternalParserInfo }> {
  const parser = await parserOf(env, user);
  const nos = [...new Set(req.pages)].sort((a, b) => a - b);
  if (nos.length > parser.maxPagesPerJob) throw new HttpError(400, "TOO_MANY_PAGES", `一次最多 ${parser.maxPagesPerJob} 页 · At most ${parser.maxPagesPerJob} pages per job`);
  const rows = await db(env)
    .select({ no: pages.no, kind: pages.kind, parser: pages.parser })
    .from(pages)
    .where(and(eq(pages.documentId, doc.id), inArray(pages.no, nos)));
  const ok = new Set(rows.filter((r) => eligible(req.reason, r)).map((r) => r.no));
  const refused = nos.filter((no) => !ok.has(no));
  if (refused.length) throw new HttpError(409, "PAGES_NOT_ELIGIBLE", "这些页不需要重新读 · These pages do not need re-reading", { pages: refused });

  const reused = await reuseParsed(env, doc, parser.id, nos);
  const send = nos.filter((no) => !reused.some((r) => r.no === no));
  if (!send.length) return { reused, job: null, parser: info(parser) };

  const cost = send.length * parser.costMicroYuanPerPage;
  const refusal = parseAllowance(await parseUsed(env, user, doc.id), { pages: send.length, reason: req.reason, costMicroYuan: cost, mineru: parser.id !== MINERU_SELFHOST_PARSER }, await parserSettingsOf(env, user.orgId));
  if (refusal) throw new HttpError(refusal.status, refusal.code, refusalMessage(refusal, "外部解析"), { scope: refusal.scope, remaining: refusal.remaining });

  const task = await parser.submit({ ocr: req.ocr });
  const id = newId("pjob");
  await db(env)
    .insert(parseUsage)
    .values({
      id,
      orgId: user.orgId,
      userId: user.id,
      documentId: doc.id,
      parser: parser.id,
      reason: req.reason,
      pages: send,
      pageCount: send.length,
      costMicroYuan: cost,
      taskId: task.taskId,
      uploadUrl: task.uploadUrl,
      day: chinaDay(),
    });
  return { reused, job: { id, pages: send }, parser: info(parser) };
}

async function jobOf(env: Env, user: SessionUser, doc: TextbookRow, id: string, states: JobRow["state"][]): Promise<JobRow> {
  const job = (await db(env).select().from(parseUsage).where(and(eq(parseUsage.id, id), eq(parseUsage.documentId, doc.id), eq(parseUsage.userId, user.id))).limit(1))[0];
  if (!job) throw new HttpError(404, "NOT_FOUND", "Job not found");
  if (!states.includes(job.state)) throw new HttpError(409, "JOB_STATE", `Job is ${job.state}`);
  return job;
}

async function setJob(env: Env, id: string, patch: Partial<JobRow>): Promise<void> {
  await db(env).update(parseUsage).set(patch).where(eq(parseUsage.id, id));
}

/** Streams the browser's sub-PDF to the parser's signed upload URL. */
export async function uploadJobFile(env: Env, user: SessionUser, doc: TextbookRow, id: string, body: ReadableStream<Uint8Array> | null, length: number): Promise<void> {
  const job = await jobOf(env, user, doc, id, ["submitted"]);
  const parser = await parserOf(env, user);
  if (!body || !Number.isFinite(length) || length < 5) throw new HttpError(400, "VALIDATION", "Missing PDF body");
  if (length > parser.maxBytes) throw new HttpError(413, "TOO_LARGE", `这几页切出来超过 ${Math.round(parser.maxBytes / 1048576)} MB，请少选几页 · Sub-PDF too large`);
  let taskId: string | void;
  try {
    taskId = await parser.upload(job.uploadUrl, body, length);
  } catch (err) {
    await setJob(env, id, { state: "failed", error: "upload" });
    throw err;
  }
  await setJob(env, id, { state: "uploaded", ...(taskId ? { taskId } : {}) });
}

export async function pollJob(env: Env, user: SessionUser, doc: TextbookRow, id: string): Promise<{ state: "running" | "ready" | "done" | "failed"; error?: string }> {
  const job = await jobOf(env, user, doc, id, ["uploaded", "parsed", "done", "failed"]);
  if (job.state === "parsed") return { state: "ready" };
  if (job.state === "done") return { state: "done" };
  if (job.state === "failed") return { state: "failed", error: job.error ?? "failed" };
  const parser = await parserOf(env, user);
  const res = await parser.poll(job.taskId);
  if (res.state === "running") return { state: "running" };
  if (res.state === "failed") {
    await setJob(env, id, { state: "failed", error: (res.error ?? "failed").slice(0, 300) });
    return { state: "failed", error: res.error ?? "failed" };
  }
  await setJob(env, id, { state: "parsed", resultUrl: res.resultUrl ?? null });
  return { state: "ready" };
}

/** The parser's result (Markdown or zip), streamed through: its CDN sends no CORS headers. */
export async function jobResult(env: Env, user: SessionUser, doc: TextbookRow, id: string): Promise<Response> {
  const job = await jobOf(env, user, doc, id, ["parsed"]);
  const parser = await parserOf(env, user);
  const upstream = await parser.result(job.resultUrl ?? "", job.pageCount);
  return new Response(upstream.body, {
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream", "cache-control": "private, no-store" },
  });
}

/**
 * The text the browser mapped back from the result, by page. Only the job's pages are written, and only
 * where they still hold pdf.js text (a paste in the meantime wins). Pages missing from the result stay as they were.
 */
export async function saveJobPages(env: Env, user: SessionUser, doc: TextbookRow, id: string, got: { no: number; text: string }[]): Promise<Saved[]> {
  const job = await jobOf(env, user, doc, id, ["parsed"]);
  const outside = got.filter((p) => !job.pages.includes(p.no)).map((p) => p.no);
  if (outside.length) throw new HttpError(400, "VALIDATION", "Pages outside the job", { pages: outside });
  const rows = got.map((p) => ({ no: p.no, text: p.text, ...pageFacts(p.text), parser: job.parser }));
  if (rows.length) await writeParsed(env, doc.id, rows);
  await setJob(env, id, { state: "done" });
  return rows.map(({ no, words, chars, flags, parser }) => ({ no, words, chars, flags, parser }));
}
