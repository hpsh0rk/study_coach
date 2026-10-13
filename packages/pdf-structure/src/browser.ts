import { getDocument, GlobalWorkerOptions, OPS, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { countWords, suspiciousSpans, type PageProbe, type ParsedPdf, type TocEntry } from "@kj/schema";
import { badCharRatio, classifyPage, mathScore } from "./index.ts";

export { GlobalWorkerOptions };

/** Where the web app serves pdfjs-dist's `cmaps/` and `standard_fonts/` (copied at build time). */
export const PDFJS_ASSETS = "/pdfjs/";

/**
 * Predefined CMaps decode CID fonts that are not embedded (common in Chinese publisher PDFs,
 * e.g. Adobe-GB1 with UniGB-UTF16-H); without them pdf.js extracts no text from those pages.
 */
export function pdfjsAssetOptions(base = PDFJS_ASSETS) {
  return { cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/` };
}

interface RawOutline {
  title: string;
  dest: string | unknown[] | null;
  items: RawOutline[];
}

async function destPage(pdf: PDFDocumentProxy, dest: RawOutline["dest"]): Promise<number | null> {
  try {
    const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const ref = explicit[0];
    if (typeof ref === "number") return ref + 1;
    return (await pdf.getPageIndex(ref as never)) + 1;
  } catch {
    return null;
  }
}

async function readOutline(pdf: PDFDocumentProxy, items: RawOutline[], depth: number): Promise<TocEntry[]> {
  const out: TocEntry[] = [];
  for (const item of items) {
    const page = await destPage(pdf, item.dest);
    const children = depth < 3 && item.items?.length ? await readOutline(pdf, item.items, depth + 1) : [];
    const title = item.title.replace(/\s+/g, " ").trim();
    if (page && title) out.push({ title, page, children });
    else out.push(...children);
  }
  return out;
}

/** Text smaller than this (PDF units ≈ pt) cannot be read on paper; it only reaches the model. */
const MIN_FONT = 2;
const isWhite = (hex: unknown) => typeof hex === "string" && /^#?[ef][0-9a-f][ef][0-9a-f][ef][0-9a-f]$/i.test(hex);

type OperatorList = Awaited<ReturnType<PDFPageProxy["getOperatorList"]>>;
type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const mul = (m: Matrix, n: number[]): Matrix => [
  m[0] * n[0]! + m[2] * n[1]!,
  m[1] * n[0]! + m[3] * n[1]!,
  m[0] * n[2]! + m[2] * n[3]!,
  m[1] * n[2]! + m[3] * n[3]!,
  m[0] * n[4]! + m[2] * n[5]! + m[4],
  m[1] * n[4]! + m[3] * n[5]! + m[5],
];

/** Strings drawn in white on a page (only looked for on pages whose text already looks like an injected instruction). */
function whiteStrings({ fnArray, argsArray }: OperatorList): string[] {
  const stack: unknown[] = [];
  let fill: unknown = "#000000";
  const out: string[] = [];
  fnArray.forEach((fn, i) => {
    const args = argsArray[i] as unknown[] | null;
    if (fn === OPS.save) stack.push(fill);
    else if (fn === OPS.restore) fill = stack.pop() ?? "#000000";
    else if (fn === OPS.setFillRGBColor) fill = args?.[0];
    else if ((fn === OPS.showText || fn === OPS.showSpacedText) && isWhite(fill)) {
      const glyphs = (args?.[0] ?? []) as ({ unicode?: string } | number | null)[];
      const str = glyphs.map((g) => (g && typeof g === "object" ? (g.unicode ?? "") : "")).join("").trim();
      if (str.length >= 3) out.push(str);
    }
  });
  return out;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface Line {
  y: number;
  size: number;
  x0: number;
  x1: number;
  cells: number;
}

const FILLS = new Set<number>([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const IMAGES = new Set<number>([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup]);

function boxOf(minMax: ArrayLike<number>, m: Matrix): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [minMax[0]!, minMax[1]!],
    [minMax[2]!, minMax[1]!],
    [minMax[0]!, minMax[3]!],
    [minMax[2]!, minMax[3]!],
  ] as const) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Segments and whether any is a curve, from pdf.js's packed path (moveTo 0, lineTo 1, curveTo 2, quadraticCurveTo 3, closePath 4). */
function pathShape(data: unknown): { segments: number; curved: boolean } {
  const path = Array.isArray(data) ? data[0] : null;
  if (!path || typeof (path as ArrayLike<number>).length !== "number") return { segments: 0, curved: false };
  const a = path as ArrayLike<number>;
  const step = [3, 3, 7, 5, 1];
  let segments = 0;
  let curved = false;
  for (let i = 0; i < a.length; ) {
    const op = a[i]!;
    if (op === 2 || op === 3) curved = true;
    segments++;
    i += step[op] ?? a.length;
  }
  return { segments, curved };
}

/** Text items grouped into lines (same baseline within half a font size). */
function linesOf(items: TextItem[]): Line[] {
  const lines: Line[] = [];
  const sorted = items.filter((it) => it.str.trim()).sort((a, b) => b.transform[5]! - a.transform[5]! || a.transform[4]! - b.transform[4]!);
  for (const it of sorted) {
    const size = Math.max(1, Math.hypot(it.transform[2]!, it.transform[3]!));
    const x0 = it.transform[4]!;
    const x1 = x0 + Math.max(it.width, size * 0.5);
    const y = it.transform[5]!;
    const line = lines.find((l) => Math.abs(l.y - y) < Math.max(l.size, size) * 0.5);
    if (!line) lines.push({ y, size, x0, x1, cells: 1 });
    else {
      if (x0 - line.x1 > 2 * size) line.cells++;
      line.x0 = Math.min(line.x0, x0);
      line.x1 = Math.max(line.x1, x1);
      line.size = Math.max(line.size, size);
    }
  }
  return lines;
}

/** Glyphs closer than this many font sizes form one cluster (one formula or number). */
const CLUSTER_GAP = 1.5;

function clusters(boxes: Box[], gap: number): number {
  const xs = [...boxes].sort((a, b) => a.x0 - b.x0);
  let n = 0;
  let end = -Infinity;
  for (const b of xs) {
    if (b.x0 - end > gap) n++;
    end = Math.max(end, b.x1);
  }
  return n;
}

/**
 * Cheap per-page signals for classifyPage, from the text items and one pass over the operator list:
 * image coverage, vector glyphs (formulas drawn as outlines lose their text), and table rules.
 */
export function probePage(view: number[], items: TextItem[], text: string, ops: OperatorList | null): PageProbe {
  const lines = linesOf(items);
  const probe: PageProbe = {
    chars: text.length,
    words: countWords(text),
    imageArea: 0,
    badCharRatio: badCharRatio(text),
    glyphs: 0,
    glyphRows: 0,
    holes: 0,
    mathScore: mathScore(text),
    rules: 0,
    rects: 0,
    gridRows: lines.filter((l) => l.cells >= 3).length,
  };
  if (!ops) return probe;
  const pageArea = Math.max(1, (view[2]! - view[0]!) * (view[3]! - view[1]!));
  const stack: Matrix[] = [];
  let ctm = IDENTITY;
  let images = 0;
  const glyphs: Box[] = [];
  ops.fnArray.forEach((fn, i) => {
    const args = ops.argsArray[i] as unknown[] | null;
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? IDENTITY;
    else if (fn === OPS.transform && args) ctm = mul(ctm, args as number[]);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args?.[0])) ctm = mul(ctm, args[0] as number[]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? IDENTITY;
    else if (IMAGES.has(fn)) images += Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
    else if (fn === OPS.constructPath && args?.[2]) {
      const box = boxOf(args[2] as ArrayLike<number>, ctm);
      const w = box.x1 - box.x0;
      const h = box.y1 - box.y0;
      const { segments, curved } = pathShape(args[1]);
      if (FILLS.has(args[0] as number) && curved && w > 0.5 && h > 0.5 && w < 30 && h < 30) glyphs.push(box);
      else if (!curved && Math.min(w, h) < 2 && Math.max(w, h) >= 20) probe.rules++;
      else if (!curved && segments <= 6 && w >= 3 && h >= 3) probe.rects++;
    }
  });
  probe.imageArea = Math.min(1, images / pageArea);
  probe.glyphs = glyphs.length;
  const free: Box[] = [];
  const onLine = new Map<Line, Box[]>();
  for (const g of glyphs) {
    const cy = (g.y0 + g.y1) / 2;
    const line = lines.find((l) => cy >= l.y - l.size * 0.4 && cy <= l.y + l.size * 1.1 && g.x1 >= l.x0 - 4 * l.size && g.x0 <= l.x1 + 4 * l.size);
    if (line) onLine.set(line, [...(onLine.get(line) ?? []), g]);
    else free.push(g);
  }
  for (const [line, boxes] of onLine) probe.holes += clusters(boxes, CLUSTER_GAP * line.size);
  const rows: Box[][] = [];
  for (const g of free.sort((a, b) => b.y0 - a.y0)) {
    const row = rows.find((r) => Math.abs((r[0]!.y0 + r[0]!.y1) / 2 - (g.y0 + g.y1) / 2) < 6);
    if (row) row.push(g);
    else rows.push([g]);
  }
  probe.glyphRows = rows.filter((r) => r.length >= 3).length;
  return probe;
}

export interface ParseOptions {
  onProgress?: (done: number, total: number) => void;
  /** Base URL (or, under Node, directory) of the pdf.js CMaps and standard fonts. */
  assets?: string;
}

/** Parses a PDF in the browser: bookmarks + per-page text layer (minus text no reader can see) and each page's kind, from the same pass. */
export async function parsePdf(data: ArrayBuffer, fallbackTitle: string, opts: ParseOptions = {}): Promise<ParsedPdf> {
  const task = getDocument({ data: new Uint8Array(data), ...pdfjsAssetOptions(opts.assets) });
  const pdf = await task.promise;
  try {
    const meta = await pdf.getMetadata().catch(() => null);
    const infoTitle = (meta?.info as { Title?: string } | undefined)?.Title?.trim();
    const outline = ((await pdf.getOutline()) ?? []) as unknown as RawOutline[];
    const toc = await readOutline(pdf, outline, 1);
    const labels = ((await pdf.getPageLabels().catch(() => null)) ?? []) as string[];
    const pages: ParsedPdf["pages"] = [];
    for (let no = 1; no <= pdf.numPages; no++) {
      const page = await pdf.getPage(no);
      const [content, ops] = await Promise.all([page.getTextContent(), page.getOperatorList().catch(() => null)]);
      const items: TextItem[] = [];
      let text = "";
      for (const item of content.items) {
        if (!("str" in item) || (item.str.trim() && Math.hypot(item.transform[2]!, item.transform[3]!) < MIN_FONT)) continue;
        items.push(item);
        text += item.str;
        text += item.hasEOL ? "\n" : " ";
      }
      if (ops && suspiciousSpans(text).some((s) => s.kind === "instruction")) {
        for (const hidden of whiteStrings(ops)) text = text.split(hidden).join(" ");
      }
      text = text.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, 40_000);
      const kind = classifyPage(probePage(page.view, items, text, ops));
      const label = labels[no - 1]?.trim().slice(0, 20);
      pages.push({ no, text, kind, ...(label && label !== String(no) ? { label } : {}) });
      page.cleanup();
      opts.onProgress?.(no, pdf.numPages);
    }
    return { title: (infoTitle || fallbackTitle).slice(0, 300), pageCount: pdf.numPages, toc, pages };
  } finally {
    await task.destroy();
  }
}
