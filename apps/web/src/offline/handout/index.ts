import type { Outline, Slide } from "@kj/schema";
import { lessonApi } from "../../lessonApi.ts";
import { compileHandoutDocx } from "./docx.ts";
import { compileHandoutHtml } from "./html.ts";
import { buildHandoutDoc, type HandoutCopy, type HandoutDoc, type HandoutLessonMeta, type HandoutMediaItem } from "./model.ts";

export * from "./model.ts";
export { compileHandoutHtml, renderRunsHtml } from "./html.ts";
export { compileHandoutDocx } from "./docx.ts";
export { buildZip, crc32, readZip, type ZipInputEntry } from "./zip.ts";

interface DeckResponse {
  lesson: HandoutLessonMeta;
  outline: Outline;
  slides: Slide[];
}

function collectHandoutFigureIds(slides: Slide[]): string[] {
  const ids = new Set<string>();
  for (const s of slides) {
    if (s.content.layout === "statement" && s.content.visual.kind === "figure") ids.add(s.content.visual.assetId);
    if (s.content.layout === "chart" && s.content.chart.kind === "figure") ids.add(s.content.chart.assetId);
  }
  return [...ids];
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function parsePngHeaderDims(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width > 0 && height > 0) return { width, height };
  }
  return null;
}

async function fetchHandoutMedia(slides: Slide[]): Promise<Record<string, HandoutMediaItem>> {
  const ids = collectHandoutFigureIds(slides);
  if (!ids.length) return {};
  const entries = await Promise.all(
    ids.map(async (id): Promise<[string, HandoutMediaItem] | null> => {
      try {
        const res = await fetch(`/api/media/${encodeURIComponent(id)}`, { credentials: "same-origin" });
        if (!res.ok) return null;
        const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
        const buf = await res.arrayBuffer();
        const rawBytes = new Uint8Array(buf);
        if (mime === "image/png") {
          const dims = parsePngHeaderDims(rawBytes) ?? { width: 640, height: 400 };
          return [
            id,
            {
              dataUrl: `data:image/png;base64,${arrayBufferToBase64(buf)}`,
              pngBytes: rawBytes,
              width: dims.width,
              height: dims.height,
            },
          ];
        }
        // Convert WebP / JPEG to PNG via browser Canvas so WordprocessingML `.docx` embeds universal PNG bytes + exact dimensions!
        const blobUrl = URL.createObjectURL(new Blob([buf], { type: mime }));
        try {
          const img = new Image();
          img.src = blobUrl;
          await img.decode();
          const width = Math.max(1, img.naturalWidth || img.width);
          const height = Math.max(1, img.naturalHeight || img.height);
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d")!;
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
          const pngDataUrl = canvas.toDataURL("image/png");
          const pngB64 = pngDataUrl.split(",")[1] ?? "";
          const bin = atob(pngB64);
          const pngBytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) pngBytes[i] = bin.charCodeAt(i);
          return [id, { dataUrl: pngDataUrl, pngBytes, width, height }];
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      } catch {
        return null;
      }
    }),
  );
  return Object.fromEntries(entries.filter((e): e is [string, HandoutMediaItem] => e !== null));
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
  const media = await fetchHandoutMedia(deck.slides);
  return buildHandoutDoc({
    lesson: deck.lesson,
    outline: deck.outline,
    slides: deck.slides,
    copy,
    ...(Object.keys(media).length > 0 ? { media } : {}),
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
