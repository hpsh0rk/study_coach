import type { Outline, Slide } from "@kj/schema";
import { lessonApi } from "../../lessonApi.ts";
import { compileHandoutDocx } from "./docx.ts";
import { compileHandoutHtml } from "./html.ts";
import { buildHandoutDoc, type HandoutCopy, type HandoutDoc, type HandoutLessonMeta } from "./model.ts";

export * from "./model.ts";
export { compileHandoutHtml, renderRunsHtml } from "./html.ts";
export { compileHandoutDocx } from "./docx.ts";
export { buildZip, crc32, readZip, type ZipInputEntry } from "./zip.ts";

interface DeckResponse {
  lesson: HandoutLessonMeta;
  outline: Outline;
  slides: Slide[];
}

export function handoutFilename(title: string, copy: HandoutCopy, ext: "html" | "docx"): string {
  const base = title.replace(/[\\/:*?"<>|.]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 50) || "lesson";
  const suffix = copy === "student" ? "学生版" : "教师答案版";
  return `${base}·配套讲义（${suffix}）.${ext}`;
}

function triggerDownload(blob: Blob, filename: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function fetchHandoutDoc(lessonId: string, copy: HandoutCopy): Promise<HandoutDoc> {
  const deck = (await lessonApi.deck(lessonId)) as unknown as DeckResponse;
  return buildHandoutDoc({
    lesson: deck.lesson,
    outline: deck.outline,
    slides: deck.slides,
    copy,
  });
}

export async function downloadHandoutHtml(lessonId: string, copy: HandoutCopy): Promise<{ html: string; filename: string }> {
  const doc = await fetchHandoutDoc(lessonId, copy);
  const html = compileHandoutHtml(doc);
  const filename = handoutFilename(doc.header.title, copy, "html");
  triggerDownload(new Blob([html], { type: "text/html;charset=utf-8" }), filename);
  return { html, filename };
}

export async function downloadHandoutDocx(lessonId: string, copy: HandoutCopy): Promise<{ data: Uint8Array; filename: string }> {
  const doc = await fetchHandoutDoc(lessonId, copy);
  const data = compileHandoutDocx(doc);
  const filename = handoutFilename(doc.header.title, copy, "docx");
  triggerDownload(
    new Blob([data as BlobPart], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    filename,
  );
  return { data, filename };
}
