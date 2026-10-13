import type { PDFDocument } from "pdf-lib";
import { separatorText, splitSeparated } from "@kj/textbook";
import type { PageKind } from "@kj/schema";
import { ApiError } from "../api.ts";
import type { ExternalParserInfo, PastedPage } from "./api.ts";

/**
 * The PDF of a book uploaded in this tab, by document id: re-reading pages needs the file, and the server
 * never has it. Lost on reload; the chapters step then asks the teacher to pick the file again.
 */
const files = new Map<string, Blob>();
export const rememberFile = (documentId: string, file: Blob) => void files.set(documentId, file);
export const rememberedFile = (documentId: string) => files.get(documentId);

/** OCR helps scans and broken fonts; it would only blur pages whose problem is formulas drawn as outlines. */
const OCR_KINDS: readonly PageKind[] = ["scanned", "garbled"];

export interface ExternalDeps {
  create(pages: number[], ocr: boolean): Promise<{ reused: PastedPage[]; job: { id: string; pages: number[] } | null }>;
  upload(job: string, pdf: Uint8Array): Promise<void>;
  poll(job: string): Promise<{ state: "running" | "ready" | "done" | "failed"; error?: string }>;
  result(job: string): Promise<ArrayBuffer>;
  save(job: string, pages: { no: number; text: string }[]): Promise<PastedPage[]>;
  /** A sub-PDF of these pages (1-based), each behind a separator page. */
  cut(pages: number[]): Promise<Uint8Array>;
  sleep(ms: number): Promise<void>;
}

export interface ExternalOutcome {
  saved: PastedPage[];
  /** Pages sent but not read back (failed job, separator missing): the teacher can still paste them. */
  missed: number[];
  /** Why the run stopped early (switch turned off, quota, parser busy), in the server's words. */
  stopped: string | null;
  /** The last error that did not stop the run (a job the parser could not take or read), so the teacher sees why pages were missed. */
  failure?: string | null;
}

const POLL_MS = 2_000;
const POLL_LIMIT = 150;

/** The parser's Markdown → text per page of the job, null where the separator did not come back. */
export function readResult(data: ArrayBuffer, count: number): (string | null)[] {
  return splitSeparated(new TextDecoder().decode(data), count);
}

/** Cuts pages out of the book with pdf-lib (loaded on first use; the book is parsed once per cutter). */
export function pdfCutter(file: Blob): (pages: number[]) => Promise<Uint8Array> {
  let book: Promise<PDFDocument> | null = null;
  return async (pages) => {
    const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
    book ??= file.arrayBuffer().then((b) => PDFDocument.load(b, { ignoreEncryption: true, updateMetadata: false }));
    const src = await book;
    const out = await PDFDocument.create();
    const font = await out.embedFont(StandardFonts.HelveticaBold);
    const copied = await out.copyPages(src, pages.map((no) => no - 1));
    copied.forEach((p, i) => {
      const { width, height } = p.getSize();
      out.addPage([width, height]).drawText(separatorText(i + 1), { x: 60, y: height / 2, size: 28, font, color: rgb(0, 0, 0) });
      out.addPage(p);
    });
    return out.save();
  };
}

const STOPS = new Set([402, 403, 429, 503]);

/**
 * Sends pages to the external parser in small sub-PDFs and stores what comes back, one job at a time.
 * A sub-PDF over the size limit is halved; a refusal that will not change soon (off, quota, budget, busy) stops the run.
 */
export async function parseExternally(
  pages: { no: number; kind: PageKind | undefined }[],
  info: Pick<ExternalParserInfo, "maxPagesPerJob" | "maxBytes">,
  deps: ExternalDeps,
  onProgress: (done: number, total: number) => void = () => undefined,
): Promise<ExternalOutcome> {
  const queue: { nos: number[]; ocr: boolean }[] = [];
  for (const ocr of [true, false]) {
    const group = pages.filter((p) => (!!p.kind && OCR_KINDS.includes(p.kind)) === ocr).map((p) => p.no);
    for (let i = 0; i < group.length; i += info.maxPagesPerJob) queue.push({ nos: group.slice(i, i + info.maxPagesPerJob), ocr });
  }
  const out: ExternalOutcome = { saved: [], missed: [], stopped: null, failure: null };
  let done = 0;
  onProgress(0, pages.length);
  while (queue.length) {
    const chunk = queue.shift()!;
    try {
      let pdf = await deps.cut(chunk.nos);
      if (pdf.byteLength > info.maxBytes) {
        if (chunk.nos.length === 1) out.missed.push(...chunk.nos);
        else {
          const half = Math.ceil(chunk.nos.length / 2);
          queue.unshift({ nos: chunk.nos.slice(0, half), ocr: chunk.ocr }, { nos: chunk.nos.slice(half), ocr: chunk.ocr });
          continue;
        }
      } else {
        const { reused, job } = await deps.create(chunk.nos, chunk.ocr);
        out.saved.push(...reused);
        if (job) {
          if (job.pages.length !== chunk.nos.length) pdf = await deps.cut(job.pages);
          await deps.upload(job.id, pdf);
          let state = (await deps.poll(job.id)).state;
          for (let n = 0; state === "running" && n < POLL_LIMIT; n++) {
            await deps.sleep(POLL_MS);
            state = (await deps.poll(job.id)).state;
          }
          if (state !== "ready") out.missed.push(...job.pages);
          else {
            const texts = readResult(await deps.result(job.id), job.pages.length);
            const got = job.pages.flatMap((no, i) => (texts[i] === null ? [] : [{ no, text: texts[i]! }]));
            out.saved.push(...(await deps.save(job.id, got)));
            out.missed.push(...job.pages.filter((_, i) => texts[i] === null));
          }
        }
      }
    } catch (err) {
      out.missed.push(...chunk.nos);
      out.failure = (err as Error).message;
      if (err instanceof ApiError && STOPS.has(err.status)) {
        out.stopped = err.message;
        out.missed.push(...queue.flatMap((c) => c.nos));
        break;
      }
    }
    done += chunk.nos.length;
    onProgress(done, pages.length);
  }
  return out;
}
