import { buildChapterTree, pagesInRanges } from "@kj/textbook";
import type { PageRange, ParsedPdf, TocEntry } from "@kj/schema";
import type { CreateTextbook, DocumentRow, TextbookLookup, UploadMediaItem } from "./api.ts";

export const MAX_MB = 200;
export const FIGURE_UPLOAD_BATCH = 8;
export const MAX_INGEST_FIGURE_PAGES = 45;

export type IngestProgress = { kind: "checking" } | { kind: "parsing" | "uploading"; done: number; total: number };

/** How the file was handled: `new` parsed and uploaded; `ready` already here (nothing parsed or uploaded); `resumed` an interrupted or incremental upload finished; `restored` a deleted copy brought back. */
export type IngestOutcome = "new" | "ready" | "resumed" | "restored";

export interface IngestParseOpts {
  pageNumbers?: number[];
  pageOffset?: number;
}

export interface IngestOptions {
  /** Optional subset of 1-based pages to parse & upload while keeping true page numbers `no`. */
  pageNumbers?: number[];
  /** Optional 1-based starting page number for pre-sliced PDFs (e.g. 693 maps physical 1..34 to 693..726). */
  pageOffset?: number;
  /** Optional full TOC from `inspectPdf` so partial uploads still store the book's full bookmark tree. */
  fullToc?: TocEntry[];
}

/** What ingest needs from the outside world: hashing, the parser, the textbook API and one question to the teacher (injected so tests can fake them). */
export interface IngestDeps {
  hash: (data: ArrayBuffer) => Promise<string>;
  lookup: (sha256: string) => Promise<TextbookLookup>;
  parse: (data: ArrayBuffer, fallbackTitle: string, onProgress: (done: number, total: number) => void, opts?: IngestParseOpts) => Promise<ParsedPdf>;
  create: (body: CreateTextbook) => Promise<{ id: string; pageBatch: number }>;
  putPages: (id: string, pages: ParsedPdf["pages"]) => Promise<unknown>;
  restore: (id: string) => Promise<unknown>;
  /** The file was uploaded and later deleted: true restores that copy, false uploads it again as a new one. */
  confirmRestore: (doc: DocumentRow) => boolean | Promise<boolean>;
  /** Optional browser 2× composite figure detector/cropper run on parsed pages (capped cleanly per lesson/upload). */
  extractFigures?: (data: ArrayBuffer, opts?: IngestParseOpts) => Promise<(UploadMediaItem & { width?: number; height?: number })[]>;
  /** Optional batch uploader storing extracted figures in D1 `media_assets`. */
  putFigures?: (documentId: string, items: UploadMediaItem[]) => Promise<unknown>;
}

export interface PdfFile {
  name: string;
  size: number;
  type: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

/** A message for files that are not PDFs or are too large, else null. */
export function fileProblem(file: Pick<PdfFile, "name" | "size" | "type">): string | null {
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return "请选择 PDF 文件 · Please choose a PDF file";
  if (file.size > MAX_MB * 1024 * 1024) return `文件超过 ${MAX_MB} MB · File is larger than ${MAX_MB} MB`;
  return null;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function saltedHash(data: ArrayBuffer, pageOffset: number, hashFn: (buf: ArrayBuffer) => Promise<string>): Promise<string> {
  if (pageOffset <= 1) return hashFn(data);
  const suffix = new TextEncoder().encode(`:pageOffset=${pageOffset}`);
  const combined = new Uint8Array(data.byteLength + suffix.byteLength);
  combined.set(new Uint8Array(data), 0);
  combined.set(suffix, data.byteLength);
  return hashFn(combined.buffer);
}

/**
 * A PDF into a textbook, parsed and uploaded at most once per teacher: the file's sha256 is checked
 * first, so a book already here is used as is and an interrupted or partial upload sends only its missing pages.
 * Supports partial `pageNumbers` (preserving true 1-based `no`) and `pageOffset` for pre-sliced PDFs.
 */
export async function ingestPdf(
  file: PdfFile,
  deps: IngestDeps,
  onProgress: (p: IngestProgress) => void = () => undefined,
  options?: IngestOptions,
): Promise<{ id: string; outcome: IngestOutcome }> {
  onProgress({ kind: "checking" });
  const data = await file.arrayBuffer();
  const pageOffset = options?.pageOffset && options.pageOffset > 1 ? Math.trunc(options.pageOffset) : undefined;
  const sha256 = await saltedHash(data, pageOffset ?? 1, deps.hash);
  let found = await deps.lookup(sha256);
  let restored = false;
  if (found.status === "archived" && (await deps.confirmRestore(found.document))) {
    await deps.restore(found.document.id);
    restored = true;
    found = await deps.lookup(sha256);
  }
  if (found.status === "ready") return { id: found.document.id, outcome: restored ? "restored" : "ready" };

  if (found.status === "incomplete") {
    const missingSet = new Set(pagesInRanges(found.missing));
    const wantedMissing = options?.pageNumbers ? options.pageNumbers.filter((n) => missingSet.has(n)) : undefined;
    if (wantedMissing && wantedMissing.length === 0) {
      return { id: found.document.id, outcome: restored ? "restored" : "ready" };
    }
    onProgress({ kind: "parsing", done: 0, total: 1 });
    const parseOpts: IngestParseOpts | undefined =
      wantedMissing || pageOffset ? { ...(wantedMissing ? { pageNumbers: wantedMissing } : {}), ...(pageOffset ? { pageOffset } : {}) } : undefined;
    const parsed = await deps.parse(
      data,
      file.name.replace(/\.pdf$/i, ""),
      (done, total) => onProgress({ kind: "parsing", done, total }),
      parseOpts,
    );
    const toUpload = wantedMissing ? parsed.pages : onlyPages(parsed.pages, found.missing);
    await upload(found.document.id, toUpload, found.pageBatch, deps, onProgress);
    await uploadExtractedFigures(found.document.id, data, toUpload.map((p) => p.no), pageOffset, deps);
    return { id: found.document.id, outcome: restored ? "restored" : "resumed" };
  }

  onProgress({ kind: "parsing", done: 0, total: 1 });
  const parseOpts: IngestParseOpts | undefined =
    options?.pageNumbers || pageOffset
      ? { ...(options?.pageNumbers ? { pageNumbers: options.pageNumbers } : {}), ...(pageOffset ? { pageOffset } : {}) }
      : undefined;
  const parsed = await deps.parse(
    data,
    file.name.replace(/\.pdf$/i, ""),
    (done, total) => onProgress({ kind: "parsing", done, total }),
    parseOpts,
  );
  const chapters = buildChapterTree(options?.fullToc ?? parsed.toc, parsed.pageCount, parsed.pages);
  const { id, pageBatch } = await deps.create({
    filename: file.name,
    title: parsed.title,
    sizeBytes: file.size,
    pageCount: parsed.pageCount,
    chapters,
    sha256,
  });
  await upload(id, parsed.pages, pageBatch, deps, onProgress);
  const figTargetPages = options?.pageNumbers ?? (parsed.pages.length <= MAX_INGEST_FIGURE_PAGES ? parsed.pages.map((p) => p.no) : undefined);
  if (figTargetPages?.length) {
    await uploadExtractedFigures(id, data, figTargetPages, pageOffset, deps);
  }
  return { id, outcome: "new" };
}

async function uploadExtractedFigures(
  documentId: string,
  data: ArrayBuffer,
  pageNumbers: number[],
  pageOffset: number | undefined,
  deps: IngestDeps,
): Promise<void> {
  if (!deps.extractFigures || !deps.putFigures || pageNumbers.length === 0) return;
  try {
    const bounded = pageNumbers.slice(0, MAX_INGEST_FIGURE_PAGES);
    const figures = await deps.extractFigures(data, {
      pageNumbers: bounded,
      ...(pageOffset ? { pageOffset } : {}),
    });
    for (let i = 0; i < figures.length; i += FIGURE_UPLOAD_BATCH) {
      await deps.putFigures(
        documentId,
        figures.slice(i, i + FIGURE_UPLOAD_BATCH).map(({ pageNo, label, caption, image }) => ({
          ...(pageNo !== undefined ? { pageNo } : {}),
          ...(label ? { label } : {}),
          ...(caption ? { caption } : {}),
          image,
        })),
      );
    }
  } catch {
    // Figure extraction/upload is a best-effort enrichment; never fail core text ingestion if a browser lacks WebP/Canvas support.
  }
}

function onlyPages(pages: ParsedPdf["pages"], ranges: PageRange[]): ParsedPdf["pages"] {
  const wanted = new Set(pagesInRanges(ranges));
  return pages.filter((p) => wanted.has(p.no));
}

async function upload(id: string, pages: ParsedPdf["pages"], pageBatch: number, deps: IngestDeps, onProgress: (p: IngestProgress) => void) {
  for (let i = 0; i < pages.length; i += pageBatch) {
    onProgress({ kind: "uploading", done: i, total: pages.length });
    await deps.putPages(id, pages.slice(i, i + pageBatch));
  }
}
