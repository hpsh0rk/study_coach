import type { Violation, Timing } from "@kj/pedagogy";
import type { ChapterNode, LessonParams, LessonScope, Outline, PageRange, Slide, ThemeId, UnitRef } from "@kj/schema";
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
  /** Bumped by every save; saves and confirms send the rev they started from. */
  rev: number;
  confirmedAt: number | null;
  ackOverBudget: boolean;
  timing: Timing;
  warnings: Violation[];
}

export interface ShareView {
  path: string;
  versionId: string;
  version: number;
  /** Pages students do not see until the teacher shares again (flagged after the last review). */
  held: number[];
}

export interface LessonView {
  lesson: {
    id: string;
    title: string;
    documentId: string;
    theme: ThemeId;
    params: LessonParams;
    scope: LessonScope;
    scopeWords: number;
    /** Selected pages without readable text (scans). */
    emptyPages: number[];
    /** Selected pages beyond the outline's source budget. */
    unreadPages: number[];
    createdAt: number;
    updatedAt: number;
  };
  /** Newer unconfirmed outline, if any. */
  draft: VersionView | null;
  /** Newest confirmed outline: step 5 presents and shares this one and its slides. */
  confirmed: VersionView | null;
  slides: Slide[];
  pageLabels: Record<number, string>;
  share: ShareView | null;
  drafting: { startedAt: number } | null;
}

export interface FlaggedSlide {
  page: number;
  title: string;
  issues: string[];
}

export interface LessonListItem {
  id: string;
  title: string;
  updatedAt: number;
  params: LessonParams;
  /** Set when the lesson was planned as part of a unit (整单元规划). */
  unit: UnitRef | null;
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
  save: (id: string, vid: string, outline: Outline, rev: number) => api<{ version: VersionView }>(`/api/lessons/${id}/outline-versions/${vid}`, { method: "PUT", body: { outline, rev } }),
  confirm: (id: string, vid: string, rev: number, ackOverBudget = false) =>
    api<{ version: VersionView; slides: Slide[] }>(`/api/lessons/${id}/outline-versions/${vid}/confirm`, { body: { ackOverBudget, rev } }),
  revise: (id: string, vid: string) => api<{ version: VersionView }>(`/api/lessons/${id}/outline-versions/${vid}/revise`, { method: "POST" }),
  generate: (id: string, vid: string, specId: string, regenerate = false) =>
    api<{ slide: Slide; reused: boolean }>(`/api/lessons/${id}/outline-versions/${vid}/slides/${specId}/generate`, { body: { regenerate } }),
  editSlide: (id: string, slideId: string, body: { content?: unknown; notes?: string }) => api<{ slide: Slide }>(`/api/lessons/${id}/slides/${slideId}`, { method: "PATCH", body }),
  undoSlide: (id: string, slideId: string) => api<{ slide: Slide }>(`/api/lessons/${id}/slides/${slideId}/undo`, { method: "POST" }),
  duplicate: (id: string, title?: string) => api<LessonView>(`/api/lessons/${id}/duplicate`, { body: title ? { title } : {} }),
  planUnit: (body: { documentId: string; chapterIds: string[]; ranges: PageRange[]; count?: number; lessonId?: string; params?: LessonParams; title?: string }) =>
    api<{ unit: { id: string; title: string; count: number }; lessons: { id: string; title: string; ranges: PageRange[]; estimatedMinutes: number }[] }>("/api/lessons/unit", { body }),
  deck: (id: string, audience: "teacher" | "student" = "teacher") => api<Record<string, unknown>>(`/api/lessons/${id}/deck${audience === "student" ? "?audience=student" : ""}`),
  share: (id: string, body: { versionId?: string; ack?: boolean } = {}) => api<ShareView>(`/api/lessons/${id}/share`, { body }),
  unshare: (id: string) => api(`/api/lessons/${id}/share`, { method: "DELETE" }),
};

export const documentApi = {
  list: () => api<{ documents: DocumentRow[] }>("/api/documents"),
  get: (id: string) =>
    api<{ document: DocumentRow; chapters: ChapterNode[]; pageLabels: Record<number, string>; pageWords: number[]; pageChars: number[] }>(`/api/documents/${id}`),
  page: (id: string, no: number) => api<{ no: number; text: string; label: string | null }>(`/api/documents/${id}/pages/${no}`),
  paste: (id: string, start: number, end: number, text: string) =>
    api<{ pages: { no: number; words: number; chars: number }[] }>(`/api/documents/${id}/pages/paste`, { body: { start, end, text } }),
};
