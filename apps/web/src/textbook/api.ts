import type { ChapterNode, PageKind, PageRange, PageText } from "@kj/schema";
import type { PageFlag } from "@kj/pdf-structure";
import { api } from "../api.ts";

export interface DocumentRow {
  id: string;
  filename: string;
  title: string;
  pageCount: number;
  pagesReceived: number;
  hasBookmarks: boolean;
  createdAt: number;
  fileSha256?: string | null;
}

/** The external parser ("外部解析服务") when an admin has turned it on. */
export interface ExternalParserInfo {
  parser: string;
  maxPagesPerJob: number;
  maxBytes: number;
  format: "markdown" | "zip";
}

export interface CreateTextbook {
  filename: string;
  title: string;
  sizeBytes: number;
  pageCount: number;
  chapters: ChapterNode[];
  sha256?: string;
}

export interface TextbookPage {
  no: number;
  text: string;
  label: string | null;
  parser: string;
}

export interface PastedPage {
  no: number;
  words: number;
  chars: number;
  flags: PageFlag[];
  parser: string;
}

export type TextbookLookup =
  | { status: "none"; pageBatch: number }
  | { status: "ready"; document: DocumentRow; pageBatch: number }
  | { status: "incomplete"; document: DocumentRow; missing: PageRange[]; pageBatch: number }
  | { status: "archived"; document: DocumentRow; pageBatch: number };

export const documentApi = {
  list: () => api<{ documents: DocumentRow[] }>("/api/documents"),
  lookup: (sha256: string) => api<TextbookLookup>("/api/documents/lookup", { body: { sha256 } }),
  create: (body: CreateTextbook) => api<{ id: string; pageBatch: number }>("/api/documents", { body: { ...body } }),
  putPages: (id: string, pages: PageText[]) => api<{ received: number; pageCount: number; complete: boolean }>(`/api/documents/${id}/pages`, { body: { pages } }),
  get: (id: string) =>
    api<{
      document: DocumentRow;
      chapters: ChapterNode[];
      pageLabels: Record<number, string>;
      pageWords: number[];
      pageChars: number[];
      pageParsers: Record<number, string>;
      pageFlags: Record<number, PageFlag[]>;
      pageKinds: Record<number, PageKind>;
      externalParser: ExternalParserInfo | null;
    }>(`/api/documents/${id}`),
  page: (id: string, no: number) => api<TextbookPage>(`/api/documents/${id}/pages/${no}`),
  paste: (id: string, start: number, end: number, text: string) => api<{ pages: PastedPage[] }>(`/api/documents/${id}/pages/paste`, { body: { start, end, text } }),
  parse: (id: string, pages: number[], reason: "auto" | "refine", ocr: boolean) =>
    api<{ reused: PastedPage[]; job: { id: string; pages: number[] } | null }>(`/api/documents/${id}/parse`, { body: { pages, reason, ocr } }),
  parseUpload: (id: string, job: string, pdf: Uint8Array) =>
    api(`/api/documents/${id}/parse/${job}/file`, { method: "PUT", body: new Blob([pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" }) }),
  parsePoll: (id: string, job: string) => api<{ state: "running" | "ready" | "done" | "failed"; error?: string }>(`/api/documents/${id}/parse/${job}`),
  parseResult: async (id: string, job: string) => {
    const res = await fetch(`/api/documents/${id}/parse/${job}/result`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.arrayBuffer();
  },
  parseSave: (id: string, job: string, pages: { no: number; text: string }[]) => api<{ pages: PastedPage[] }>(`/api/documents/${id}/parse/${job}/pages`, { body: { pages } }),
  archive: (id: string) => api<{ ok: true; lessons: number }>(`/api/documents/${id}`, { method: "DELETE" }),
  restore: (id: string) => api(`/api/documents/${id}/restore`, { body: {} }),
};
