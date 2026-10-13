import { buildChapterTree, pagesInRanges } from "@kj/textbook";
import type { PageRange, ParsedPdf } from "@kj/schema";
import type { CreateTextbook, DocumentRow, TextbookLookup } from "./api.ts";

export const MAX_MB = 200;

export type IngestProgress = { kind: "checking" } | { kind: "parsing" | "uploading"; done: number; total: number };

/** How the file was handled: `new` parsed and uploaded; `ready` already here (nothing parsed or uploaded); `resumed` an interrupted upload finished; `restored` a deleted copy brought back. */
export type IngestOutcome = "new" | "ready" | "resumed" | "restored";

/** What ingest needs from the outside world: hashing, the parser, the textbook API and one question to the teacher (injected so tests can fake them). */
export interface IngestDeps {
  hash: (data: ArrayBuffer) => Promise<string>;
  lookup: (sha256: string) => Promise<TextbookLookup>;
  parse: (data: ArrayBuffer, fallbackTitle: string, onProgress: (done: number, total: number) => void) => Promise<ParsedPdf>;
  create: (body: CreateTextbook) => Promise<{ id: string; pageBatch: number }>;
  putPages: (id: string, pages: ParsedPdf["pages"]) => Promise<unknown>;
  restore: (id: string) => Promise<unknown>;
  /** The file was uploaded and later deleted: true restores that copy, false uploads it again as a new one. */
  confirmRestore: (doc: DocumentRow) => boolean | Promise<boolean>;
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

/**
 * A PDF into a textbook, parsed and uploaded at most once per teacher: the file's sha256 is checked
 * first, so a book already here is used as is and an interrupted upload sends only its missing pages.
 * Otherwise it is parsed in the browser (only text leaves the machine), its chapter tree built from the
 * bookmarks, and pages uploaded in the batch size the server asks for.
 */
export async function ingestPdf(file: PdfFile, deps: IngestDeps, onProgress: (p: IngestProgress) => void = () => undefined): Promise<{ id: string; outcome: IngestOutcome }> {
  onProgress({ kind: "checking" });
  const data = await file.arrayBuffer();
  const sha256 = await deps.hash(data);
  let found = await deps.lookup(sha256);
  let restored = false;
  if (found.status === "archived" && (await deps.confirmRestore(found.document))) {
    await deps.restore(found.document.id);
    restored = true;
    found = await deps.lookup(sha256);
  }
  if (found.status === "ready") return { id: found.document.id, outcome: restored ? "restored" : "ready" };

  // Parsing hands the buffer to the pdf.js worker, so it comes after hashing.
  onProgress({ kind: "parsing", done: 0, total: 1 });
  const parsed = await deps.parse(data, file.name.replace(/\.pdf$/i, ""), (done, total) => onProgress({ kind: "parsing", done, total }));
  if (found.status === "incomplete") {
    await upload(found.document.id, onlyPages(parsed.pages, found.missing), found.pageBatch, deps, onProgress);
    return { id: found.document.id, outcome: restored ? "restored" : "resumed" };
  }
  const chapters = buildChapterTree(parsed.toc, parsed.pageCount, parsed.pages);
  const { id, pageBatch } = await deps.create({ filename: file.name, title: parsed.title, sizeBytes: file.size, pageCount: parsed.pageCount, chapters, sha256 });
  await upload(id, parsed.pages, pageBatch, deps, onProgress);
  return { id, outcome: "new" };
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
