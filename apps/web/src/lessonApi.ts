import type { Violation, Timing } from "@kj/pedagogy";
import type { ChapterNode, LessonParams, LessonScope, Outline, PageRange, Slide, ThemeId } from "@kj/schema";
import { api } from "./api.ts";

export interface DocumentRow {
  id: string;
  filename: string;
  title: string;
  pageCount: number;
  pagesReceived: number;
  hasBookmarks: boolean;
  createdAt: number;
}

export interface VersionView {
  id: string;
  version: number;
  outline: Outline;
  /** Lesson settings and scope snapshotted when the version was created. */
  params: LessonParams;
  scope: LessonScope;
  confirmedAt: number | null;
  ackOverBudget: boolean;
  timing: Timing;
  warnings: Violation[];
}

export interface LessonView {
  lesson: { id: string; title: string; documentId: string; theme: ThemeId; params: LessonParams; scope: LessonScope; scopeWords: number; createdAt: number; updatedAt: number };
  version: VersionView | null;
  confirmedVersionId: string | null;
  slides: Slide[];
  pageLabels: Record<number, string>;
  shared: boolean;
}

export interface LessonListItem {
  id: string;
  title: string;
  updatedAt: number;
  params: LessonParams;
  status: "scoped" | "outline" | "confirmed" | "slides";
  slides: number;
  planned: number;
}

export const lessonApi = {
  list: () => api<{ lessons: LessonListItem[] }>("/api/lessons"),
  get: (id: string) => api<LessonView>(`/api/lessons/${id}`),
  create: (documentId: string, chapterIds: string[], ranges: PageRange[]) => api<LessonView>("/api/lessons", { body: { documentId, chapterIds, ranges } }),
  patch: (id: string, body: Partial<{ title: string; params: LessonParams; theme: ThemeId; chapterIds: string[]; ranges: PageRange[] }>) =>
    api<LessonView>(`/api/lessons/${id}`, { method: "PATCH", body }),
  draft: (id: string) => api<{ version: VersionView }>(`/api/lessons/${id}/outline`, { method: "POST" }),
  save: (id: string, vid: string, outline: Outline) => api<{ version: VersionView }>(`/api/lessons/${id}/outline-versions/${vid}`, { method: "PUT", body: { outline } }),
  confirm: (id: string, vid: string, ackOverBudget = false) => api<{ version: VersionView; slides: Slide[] }>(`/api/lessons/${id}/outline-versions/${vid}/confirm`, { body: { ackOverBudget } }),
  revise: (id: string, vid: string) => api<{ version: VersionView }>(`/api/lessons/${id}/outline-versions/${vid}/revise`, { method: "POST" }),
  generate: (id: string, vid: string, specId: string, regenerate = false) =>
    api<{ slide: Slide; reused: boolean }>(`/api/lessons/${id}/outline-versions/${vid}/slides/${specId}/generate`, { body: { regenerate } }),
  editSlide: (id: string, slideId: string, body: { content?: unknown; notes?: string }) => api<{ slide: Slide }>(`/api/lessons/${id}/slides/${slideId}`, { method: "PATCH", body }),
  undoSlide: (id: string, slideId: string) => api<{ slide: Slide }>(`/api/lessons/${id}/slides/${slideId}/undo`, { method: "POST" }),
  deck: (id: string) => api<Record<string, unknown>>(`/api/lessons/${id}/deck`),
  share: (id: string) => api<{ token: string; path: string }>(`/api/lessons/${id}/share`, { method: "POST" }),
  unshare: (id: string) => api(`/api/lessons/${id}/share`, { method: "DELETE" }),
};

export const documentApi = {
  list: () => api<{ documents: DocumentRow[] }>("/api/documents"),
  get: (id: string) => api<{ document: DocumentRow; chapters: ChapterNode[]; pageLabels: Record<number, string>; pageWords: number[] }>(`/api/documents/${id}`),
  page: (id: string, no: number) => api<{ no: number; text: string; label: string | null }>(`/api/documents/${id}/pages/${no}`),
};
