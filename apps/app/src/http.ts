import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

const FIELD_HINTS_ZH: Record<string, string> = {
  pageCount: "PDF 页数超出范围（单本最多 2500 页，大文件可按章节或页码区间局部导入）",
  sizeBytes: "文件大小超出限制（最大 200 MB）",
  "params.focus": "教学指令字数超出上限（最多 1500 字）",
  focus: "教学指令字数超出上限（最多 1500 字）",
  ranges: "页码范围格式有误（结束页需大于等于起始页）",
  pages: "页面数据格式或页码范围有误",
  chapters: "目录章节格式或页码范围有误",
  title: "标题不能为空或超出长度限制",
  image: "请上传或粘贴 PNG、JPEG 或 WebP 格式的图片",
  sources: "多源备课材料格式有误",
};

function summarizeIssues(issues: { path: string; message: string }[]): string {
  const hints: string[] = [];
  for (const issue of issues) {
    const tail = issue.path.split(".").pop() ?? "";
    const zh = FIELD_HINTS_ZH[issue.path] ?? FIELD_HINTS_ZH[tail];
    if (zh && !hints.includes(zh)) hints.push(zh);
  }
  const raw = issues
    .slice(0, 3)
    .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
    .join("; ");
  return hints.length ? `${hints.join("；")} · ${raw}` : `请求参数有误 · ${raw || "Invalid request"}`;
}

/** An empty body parses as undefined, so schemas with a default accept body-less POSTs. */
export async function parseJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    const raw = await c.req.text();
    body = raw.trim() ? JSON.parse(raw) : undefined;
  } catch {
    throw new HttpError(400, "BAD_JSON", "Request body must be JSON · 请求内容不是合法 JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw new HttpError(400, "VALIDATION", summarizeIssues(detail), detail);
  }
  return parsed.data;
}
