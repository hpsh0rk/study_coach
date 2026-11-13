import type { LessonParams, LessonSource, PageRange, PdfLessonSource, SyllabusLessonSource, ThemeId } from "@kj/schema";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

const VALIDATION_FIELD_ZH: Record<string, string> = {
  pageCount: "PDF 页数超出限制（单本最多 2500 页，大文件可按章节或页码区间局部导入）",
  sizeBytes: "文件体积超出限制（最大 200 MB）",
  "params.focus": "教学指令超出 1500 字上限",
  focus: "教学指令超出 1500 字上限",
  ranges: "页码范围格式有误（结束页须大于等于起始页）",
  pages: "页面数据或页码超出文档范围",
  chapters: "目录章节页码范围有误",
  title: "标题不能为空或过长",
  image: "请上传或粘贴 PNG、JPEG 或 WebP 格式图片",
  sources: "多源备课材料配置有误",
};

interface ValidationIssueItem {
  path?: unknown;
  message?: unknown;
}

export function formatApiError(code: string, message: string, detail?: unknown): string {
  if (code !== "VALIDATION" || !Array.isArray(detail) || detail.length === 0) return message;
  const issues = detail as ValidationIssueItem[];
  const hints: string[] = [];
  const rawParts: string[] = [];
  for (const item of issues.slice(0, 4)) {
    const pathStr = Array.isArray(item.path) ? item.path.join(".") : typeof item.path === "string" ? item.path : "";
    const msgStr = typeof item.message === "string" ? item.message : "";
    const tail = pathStr.split(".").pop() ?? "";
    const zh = VALIDATION_FIELD_ZH[pathStr] ?? VALIDATION_FIELD_ZH[tail];
    if (zh && !hints.includes(zh)) hints.push(zh);
    if (pathStr || msgStr) rawParts.push(pathStr ? `${pathStr}: ${msgStr}` : msgStr);
  }
  if (message && message !== "Invalid request" && /[\u3400-\u9fff]/.test(message)) return message;
  const detailSummary = rawParts.join("; ");
  if (hints.length) return `${hints.join("；")}${detailSummary ? ` (${detailSummary})` : ""}`;
  return detailSummary ? `请求参数校验未通过：${detailSummary}` : message;
}

/** Cached PDF sources per lessonId and primary documentId so SourcePage & PlayPages resolve multi-PDF tabs seamlessly. */
const sourcesByLesson = new Map<string, LessonSource[]>();
const sourcesByPrimaryDoc = new Map<string, PdfLessonSource[]>();

export function rememberLessonSources(lessonId: string, primaryDocId: string, sources: LessonSource[] | undefined): void {
  const list = sources ?? [];
  sourcesByLesson.set(lessonId, list);
  const pdfs = list.filter((s): s is PdfLessonSource => s.kind === "pdf");
  if (pdfs.length > 0) sourcesByPrimaryDoc.set(primaryDocId, pdfs);
}

export function activeLessonPdfSources(documentId?: string | null): PdfLessonSource[] {
  if (typeof window !== "undefined") {
    const m = /^\/(?:lessons|play|presenter)\/([^/?#]+)/.exec(window.location.pathname);
    if (m?.[1]) {
      const hit = sourcesByLesson.get(m[1])?.filter((s): s is PdfLessonSource => s.kind === "pdf");
      if (hit?.length) return hit;
    }
  }
  if (documentId) {
    const byPrimary = sourcesByPrimaryDoc.get(documentId);
    if (byPrimary?.length) return byPrimary;
    for (const list of sourcesByLesson.values()) {
      const pdfs = list.filter((s): s is PdfLessonSource => s.kind === "pdf");
      if (pdfs.some((p) => p.documentId === documentId)) return pdfs;
    }
  }
  return [];
}

export function lessonSourcesOf(view: { lesson: { id: string; documentId: string; sources?: LessonSource[]; scope?: { sources?: LessonSource[] } } }): LessonSource[] {
  return view.lesson.sources ?? view.lesson.scope?.sources ?? sourcesByLesson.get(view.lesson.id) ?? [];
}

function maybeCacheLessonPayload(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const lesson = (data as { lesson?: { id?: unknown; documentId?: unknown; sources?: unknown } }).lesson;
  if (lesson && typeof lesson.id === "string" && typeof lesson.documentId === "string" && Array.isArray(lesson.sources)) {
    rememberLessonSources(lesson.id, lesson.documentId, lesson.sources as LessonSource[]);
  }
}

type Json = Record<string, unknown> | unknown[];

export async function api<T = unknown>(path: string, init: { method?: string; body?: Json | Blob | File; headers?: Record<string, string> } = {}): Promise<T> {
  const isBinary = init.body instanceof Blob;
  const res = await fetch(path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    credentials: "same-origin",
    headers: {
      "x-kj-csrf": "1",
      ...(init.body && !isBinary ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : isBinary ? (init.body as Blob) : JSON.stringify(init.body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; detail?: unknown } }).error;
    const code = err?.code ?? "HTTP";
    const rawMsg = err?.message ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, code, formatApiError(code, rawMsg, err?.detail), err?.detail);
  }
  maybeCacheLessonPayload(data);
  return data as T;
}

export const multisourceLessonApi = {
  create: <T>(body: {
    documentId: string;
    chapterIds: string[];
    ranges: PageRange[];
    sources?: LessonSource[];
    params?: LessonParams;
    title?: string;
  }) => api<T>("/api/lessons", { body }),
  patch: <T>(
    id: string,
    body: Partial<{
      title: string;
      params: LessonParams;
      theme: ThemeId;
      chapterIds: string[];
      ranges: PageRange[];
      sources: LessonSource[];
    }>,
  ) => api<T>(`/api/lessons/${id}`, { method: "PATCH", body }),
  transcribeSyllabusImage: (lessonId: string | null, image: string, title?: string) =>
    api<{ source: SyllabusLessonSource; model: string }>(
      lessonId ? `/api/lessons/${lessonId}/syllabus-image` : "/api/lessons/syllabus-image",
      { body: { image, ...(title ? { title } : {}) } },
    ),
};

export interface Me {
  id: string;
  username: string;
  displayName: string | null;
  role: "admin" | "teacher";
  mustChangePassword: boolean;
}
