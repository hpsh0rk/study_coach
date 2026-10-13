import { buildChapterTree } from "@kj/pdf-structure";
import type { ParsedPdf } from "@kj/schema";
import type { CreateTextbook } from "./api.ts";

export const MAX_MB = 200;

export type IngestProgress = { kind: "parsing" | "uploading"; done: number; total: number };

/** What ingest needs from the outside world: the parser and the textbook API (injected so tests can fake them). */
export interface IngestDeps {
  parse: (data: ArrayBuffer, fallbackTitle: string, onProgress: (done: number, total: number) => void) => Promise<ParsedPdf>;
  create: (body: CreateTextbook) => Promise<{ id: string; pageBatch: number }>;
  putPages: (id: string, pages: ParsedPdf["pages"]) => Promise<unknown>;
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

/**
 * A PDF into a textbook: parsed in the browser (only text leaves the machine), chapter tree from its
 * bookmarks, then pages uploaded in the batch size the server asks for. Returns the textbook id.
 */
export async function ingestPdf(file: PdfFile, deps: IngestDeps, onProgress: (p: IngestProgress) => void = () => undefined): Promise<string> {
  onProgress({ kind: "parsing", done: 0, total: 1 });
  const parsed = await deps.parse(await file.arrayBuffer(), file.name.replace(/\.pdf$/i, ""), (done, total) => onProgress({ kind: "parsing", done, total }));
  const chapters = buildChapterTree(parsed.toc, parsed.pageCount, parsed.pages);
  const { id, pageBatch } = await deps.create({ filename: file.name, title: parsed.title, sizeBytes: file.size, pageCount: parsed.pageCount, chapters });
  for (let i = 0; i < parsed.pages.length; i += pageBatch) {
    onProgress({ kind: "uploading", done: i, total: parsed.pages.length });
    await deps.putPages(id, parsed.pages.slice(i, i + pageBatch));
  }
  return id;
}
