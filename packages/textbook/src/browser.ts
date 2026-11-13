import { getDocument, GlobalWorkerOptions, OPS, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { countWords, suspiciousSpans, type PageProbe, type ParsedPdf, type PdfInspection, type TocEntry } from "@kj/schema";
import { badCharRatio, classifyPage, filterTocForPages, mathScore, MAX_TREE_DEPTH, shiftToc } from "./index.ts";

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
    const children = depth < MAX_TREE_DEPTH && item.items?.length ? await readOutline(pdf, item.items, depth + 1) : [];
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

/**
 * Renders pages of one PDF to JPEG data URLs for a vision model: about 1600 px on the long side at quality 0.8
 * (200–400 KB a page). The document is loaded once for all pages; `close` frees it.
 */
export function pageRenderer(file: Blob, opts: { assets?: string; maxSide?: number; quality?: number } = {}) {
  let loading: ReturnType<typeof getDocument> | null = null;
  const doc = async () => (loading ??= getDocument({ data: new Uint8Array(await file.arrayBuffer()).slice(), ...pdfjsAssetOptions(opts.assets) })).promise;
  return {
    async render(no: number): Promise<string> {
      const page = await (await doc()).getPage(no);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (opts.maxSide ?? 1600) / Math.max(base.width, base.height) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, viewport, background: "#ffffff" }).promise;
      page.cleanup();
      return canvas.toDataURL("image/jpeg", opts.quality ?? 0.8);
    },
    async close(): Promise<void> {
      await loading?.destroy();
      loading = null;
    },
  };
}

export interface NormalizedRect {
  /** 0..1 from left edge of page. */
  x: number;
  /** 0..1 from top edge of page. */
  y: number;
  /** 0..1 width fraction. */
  w: number;
  /** 0..1 height fraction. */
  h: number;
}

export interface DetectedPageFigure {
  label: string;
  caption: string;
  normBox: NormalizedRect;
}

export interface ExtractedPdfFigure {
  pageNo: number;
  label: string;
  caption: string;
  image: string;
  width: number;
  height: number;
}

interface TextLineWithText extends Line {
  text: string;
  y0: number;
  y1: number;
}

const CAPTION_ANCHOR_RE = /^((?:Figure|Fig\.?)\s*\d+(?:[.-]\d+)*[a-z]?|(?:附图|图)\s*\d+(?:[.-]\d+)*[a-z]?)(?:[\s:：.—–-]+(.*))?$/i;
const MAX_DETECTED_PER_PAGE = 4;
const DEFAULT_MAX_EXTRACT_PAGES = 45;
const DEFAULT_MAX_EXTRACTED_FIGURES = 36;

function unionBox(a: Box, b: Box): Box {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

function boxesTouchOrNear(a: Box, b: Box, padX: number, padY: number): boolean {
  return a.x0 - padX <= b.x1 && a.x1 + padX >= b.x0 && a.y0 - padY <= b.y1 && a.y1 + padY >= b.y0;
}

function textLinesWithStrings(items: TextItem[]): TextLineWithText[] {
  const lines: TextLineWithText[] = [];
  const sorted = items
    .filter((it) => it.str.trim() && Math.hypot(it.transform[2]!, it.transform[3]!) >= MIN_FONT)
    .sort((a, b) => b.transform[5]! - a.transform[5]! || a.transform[4]! - b.transform[4]!);
  for (const it of sorted) {
    const size = Math.max(1, Math.hypot(it.transform[2]!, it.transform[3]!));
    const x0 = it.transform[4]!;
    const x1 = x0 + Math.max(it.width, size * 0.5);
    const y = it.transform[5]!;
    const y0 = y - size * 0.25;
    const y1 = y + size * 0.95;
    const line = lines.find((l) => Math.abs(l.y - y) < Math.max(l.size, size) * 0.55);
    if (!line) {
      lines.push({ y, y0, y1, size, x0, x1, cells: 1, text: it.str.trim() });
    } else {
      const gap = x0 - line.x1;
      if (gap > 2 * size) line.cells++;
      line.text = `${line.text}${gap > size * 0.2 ? " " : ""}${it.str.trim()}`;
      line.x0 = Math.min(line.x0, x0);
      line.x1 = Math.max(line.x1, x1);
      line.y0 = Math.min(line.y0, y0);
      line.y1 = Math.max(line.y1, y1);
      line.size = Math.max(line.size, size);
    }
  }
  return lines;
}

/**
 * Detects textbook figures on one PDF page in normalized top-left `[0..1]` coordinates:
 * - Collects non-decorative `OPS.paintImageXObject` CTM boxes (filtering tiny header/footer icons and full-page backgrounds);
 * - Pairs adjacent `Figure X.Y` / `Fig. X.Y` / `图 X` captions (and detects pure-vector diagrams anchored by captions);
 * - Expands each figure's bounding box around nearby vector paths (arrows, field lines, circuit lines) and short diagram text labels (`"N"`, `"S"`, `"Force"`).
 */
export function detectPageFigures(view: number[], items: TextItem[], ops: OperatorList | null): DetectedPageFigure[] {
  if (!ops) return [];
  const vx0 = view[0] ?? 0;
  const vy0 = view[1] ?? 0;
  const vx1 = view[2] ?? 600;
  const vy1 = view[3] ?? 800;
  const pageW = Math.max(1, vx1 - vx0);
  const pageH = Math.max(1, vy1 - vy0);
  const pageArea = pageW * pageH;

  const stack: Matrix[] = [];
  let ctm = IDENTITY;
  const imageBoxes: Box[] = [];
  const vectorBoxes: Box[] = [];

  ops.fnArray.forEach((fn, i) => {
    const args = ops.argsArray[i] as unknown[] | null;
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? IDENTITY;
    else if (fn === OPS.transform && args) ctm = mul(ctm, args as number[]);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args?.[0])) ctm = mul(ctm, args[0] as number[]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? IDENTITY;
    else if (IMAGES.has(fn)) {
      const b = boxOf([0, 0, 1, 1], ctm);
      const w = b.x1 - b.x0;
      const h = b.y1 - b.y0;
      const area = w * h;
      const inHeaderOrFooter = b.y0 > vy1 - pageH * 0.085 || b.y1 < vy0 + pageH * 0.065;
      // Filter tiny decorative icons (< 42pt side or < 2600 pt^2) and full-page scan/background washes (> 82% of page)
      if (w >= 42 && h >= 36 && area >= 2600 && area <= pageArea * 0.82 && !(inHeaderOrFooter && h < 55)) {
        imageBoxes.push(b);
      }
    }     else if (fn === OPS.constructPath && args?.[2]) {
      const b = boxOf(args[2] as ArrayLike<number>, ctm);
      const w = b.x1 - b.x0;
      const h = b.y1 - b.y0;
      const maxDim = Math.max(w, h);
      const area = w * h;
      const isPageRule = w > pageW * 0.82 && h < 4;
      if (maxDim >= 6 && area <= pageArea * 0.7 && !isPageRule && b.y0 <= vy1 - pageH * 0.06 && b.y1 >= vy0 + pageH * 0.05) {
        vectorBoxes.push(b);
      }
    } else if (fn === OPS.rectangle && Array.isArray(args) && args.length >= 4) {
      const rx = Number(args[0]);
      const ry = Number(args[1]);
      const rw = Number(args[2]);
      const rh = Number(args[3]);
      if (Number.isFinite(rx) && Number.isFinite(ry) && Number.isFinite(rw) && Number.isFinite(rh)) {
        const b = boxOf([rx, ry, rx + rw, ry + rh], ctm);
        const w = b.x1 - b.x0;
        const h = b.y1 - b.y0;
        if (Math.max(w, h) >= 6 && w * h <= pageArea * 0.7 && !(w > pageW * 0.82 && h < 4)) {
          vectorBoxes.push(b);
        }
      }
    }
  });

  // Merge touching/overlapping raster image tiles (publishers often slice one diagram photo into strips)
  const mergedRegions: Box[] = imageBoxes.map((b) => ({ ...b }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < mergedRegions.length; i++) {
      for (let j = i + 1; j < mergedRegions.length; j++) {
        if (boxesTouchOrNear(mergedRegions[i]!, mergedRegions[j]!, 14, 14)) {
          mergedRegions[i] = unionBox(mergedRegions[i]!, mergedRegions[j]!);
          mergedRegions.splice(j, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }

  const lines = textLinesWithStrings(items);
  const captions = lines.flatMap((line) => {
    const m = CAPTION_ANCHOR_RE.exec(line.text.trim());
    if (!m) return [];
    const rawLabel = m[1]!.replace(/\s+/g, " ").trim();
    const rest = (m[2] ?? "").replace(/\s+/g, " ").trim();
    return [{ line, label: rawLabel, caption: rest || rawLabel }];
  });

  // Short diagram callout labels ("N", "S", "Force", "Current", "2.5 A", etc.) vs body prose lines
  const shortLabels = lines.filter((line) => {
    const trimmed = line.text.trim();
    if (!trimmed || CAPTION_ANCHOR_RE.test(trimmed)) return false;
    const inMargin = line.y0 > vy1 - pageH * 0.075 || line.y1 < vy0 + pageH * 0.06;
    if (inMargin) return false;
    return trimmed.length <= 22 && (line.x1 - line.x0) < pageW * 0.42;
  });

  const proseLines = lines.filter((line) => {
    const trimmed = line.text.trim();
    if (!trimmed || CAPTION_ANCHOR_RE.test(trimmed)) return false;
    return trimmed.length > 35 || (line.x1 - line.x0) >= pageW * 0.52;
  });

  interface Candidate {
    box: Box;
    label: string;
    caption: string;
    captionLine?: TextLineWithText;
  }

  const candidates: Candidate[] = mergedRegions.map((box) => ({ box: { ...box }, label: "", caption: "" }));

  // Pair each caption anchor to its nearest diagram above (preferred) or below, or synthesize a vector cluster above it!
  for (const cap of captions) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let idx = 0; idx < candidates.length; idx++) {
      const c = candidates[idx]!;
      if (c.captionLine) continue;
      const horizOverlap = Math.min(c.box.x1, cap.line.x1 + 80) - Math.max(c.box.x0, cap.line.x0 - 80);
      if (horizOverlap < -40) continue;
      // PDF y grows upwards: diagram directly ABOVE caption has c.box.y0 >= cap.line.y1 - 12
      const gapAbove = c.box.y0 - cap.line.y1;
      const gapBelow = cap.line.y0 - c.box.y1;
      if (gapAbove >= -18 && gapAbove <= pageH * 0.28 && gapAbove < bestDist) {
        bestDist = gapAbove;
        bestIdx = idx;
      } else if (gapBelow >= -12 && gapBelow <= pageH * 0.14 && gapBelow + 40 < bestDist) {
        bestDist = gapBelow + 40;
        bestIdx = idx;
      }
    }

    if (bestIdx >= 0) {
      candidates[bestIdx]!.label = cap.label;
      candidates[bestIdx]!.caption = cap.caption;
      candidates[bestIdx]!.captionLine = cap.line;
      continue;
    }

    // Pure-vector diagram above a `Figure X.Y` caption (no raster XObject): find vector primitives between caption and nearest prose paragraph above!
    const ceilingProseY = proseLines
      .filter((p) => p.y0 > cap.line.y1 + 12)
      .reduce((minY, p) => Math.min(minY, p.y0), vy1 - pageH * 0.06);
    const searchTop = Math.min(ceilingProseY - 4, cap.line.y1 + pageH * 0.42);
    const vecInBand = vectorBoxes.filter(
      (v) => v.y0 >= cap.line.y1 - 4 && v.y1 <= searchTop + 6 && v.x1 >= vx0 + 16 && v.x0 <= vx1 - 16,
    );
    if (vecInBand.length >= 2) {
      let vUnion = { ...vecInBand[0]! };
      for (const v of vecInBand.slice(1)) vUnion = unionBox(vUnion, v);
      if (vUnion.x1 - vUnion.x0 >= 36 && vUnion.y1 - vUnion.y0 >= 28) {
        candidates.push({
          box: vUnion,
          label: cap.label,
          caption: cap.caption,
          captionLine: cap.line,
        });
      }
    }
  }

  // Expand each candidate box to absorb connected/adjacent vector arrows and short callout labels ("N", "S", "Force")
  // while stopping cleanly before surrounding body prose lines and captions!
  const out: DetectedPageFigure[] = [];
  const sortedCandidates = candidates
    .sort((a, b) => b.box.y1 - a.box.y1 || a.box.x0 - b.box.x0)
    .slice(0, MAX_DETECTED_PER_PAGE);

  for (const cand of sortedCandidates) {
    let box = { ...cand.box };
    const ceilingY = proseLines
      .filter((p) => p.y0 >= cand.box.y1 - 2)
      .reduce((minY, p) => Math.min(minY, p.y0 - 3), vy1 - 6);
    const captionTopY = cand.captionLine && cand.captionLine.y1 <= cand.box.y0 + 16 ? cand.captionLine.y1 + 2 : -Infinity;
    const floorProseY = proseLines
      .filter((p) => p.y1 <= cand.box.y0 + 2)
      .reduce((maxY, p) => Math.max(maxY, p.y1 + 3), vy0 + 6);
    const floorY = Math.max(floorProseY, captionTopY);

    for (let pass = 0; pass < 3; pass++) {
      for (const v of vectorBoxes) {
        if (v.y1 > ceilingY + 4 || v.y0 < floorY - 4) continue;
        if (boxesTouchOrNear(box, v, 36, 26)) {
          box = unionBox(box, v);
        }
      }
      for (const lbl of shortLabels) {
        const lb: Box = { x0: lbl.x0, y0: lbl.y0, x1: lbl.x1, y1: lbl.y1 };
        if (lb.y1 > ceilingY + 4 || lb.y0 < floorY - 4) continue;
        if (boxesTouchOrNear(box, lb, 58, 30)) {
          box = unionBox(box, lb);
        }
      }
    }

    // Add breathing padding (10pt) clamped to page and prose boundaries:
    const pad = 10;
    const x0 = Math.max(vx0, box.x0 - pad);
    const x1 = Math.min(vx1, box.x1 + pad);
    const y0 = Math.max(vy0, Math.max(floorY, box.y0 - pad));
    const y1 = Math.min(vx1 ? vy1 : 800, Math.min(ceilingY, box.y1 + pad));
    if (x1 - x0 < 40 || y1 - y0 < 32) continue;

    // Convert PDF bottom-up coordinates to normalized top-left [0..1] viewport coordinates:
    const nx = Math.max(0, Math.min(1, (x0 - vx0) / pageW));
    const ny = Math.max(0, Math.min(1, (vy1 - y1) / pageH));
    const nw = Math.max(0.05, Math.min(1 - nx, (x1 - x0) / pageW));
    const nh = Math.max(0.05, Math.min(1 - ny, (y1 - y0) / pageH));

    out.push({
      label: cand.label.slice(0, 80),
      caption: cand.caption.slice(0, 200),
      normBox: { x: nx, y: ny, w: nw, h: nh },
    });
  }

  return out;
}

function encodeCanvasImage(canvas: HTMLCanvasElement, quality = 0.86): string {
  const webp = canvas.toDataURL("image/webp", quality);
  if (webp.startsWith("data:image/webp")) return webp;
  return canvas.toDataURL("image/png");
}

/** Crops a normalized `[0..1]` rectangle from a rendered page canvas, scaling down proportionally so `maxSide <= 1200`. */
export function cropNormalizedRegion(
  sourceCanvas: HTMLCanvasElement,
  norm: NormalizedRect,
  opts: { maxSide?: number; quality?: number; createCanvas?: (w: number, h: number) => HTMLCanvasElement } = {},
): { image: string; width: number; height: number } {
  const maxSide = opts.maxSide ?? 1200;
  const makeCanvas =
    opts.createCanvas ??
    ((w: number, h: number) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      return c;
    });
  const sw = Math.max(1, sourceCanvas.width);
  const sh = Math.max(1, sourceCanvas.height);
  const sx = Math.max(0, Math.min(sw - 1, Math.round(norm.x * sw)));
  const sy = Math.max(0, Math.min(sh - 1, Math.round(norm.y * sh)));
  const cw = Math.max(1, Math.min(sw - sx, Math.round(norm.w * sw)));
  const ch = Math.max(1, Math.min(sh - sy, Math.round(norm.h * sh)));

  const downscale = Math.min(1, maxSide / Math.max(cw, ch));
  const outW = Math.max(1, Math.round(cw * downscale));
  const outH = Math.max(1, Math.round(ch * downscale));

  const outCanvas = makeCanvas(outW, outH);
  outCanvas.width = outW;
  outCanvas.height = outH;
  const ctx = outCanvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(sourceCanvas, sx, sy, cw, ch, 0, 0, outW, outH);
  }
  return {
    image: encodeCanvasImage(outCanvas, opts.quality ?? 0.86),
    width: outW,
    height: outH,
  };
}

export interface ExtractFiguresOptions {
  assets?: string;
  pageNumbers?: number[];
  pageOffset?: number;
  /** Maximum output pixel dimension per cropped figure (default 1200). */
  maxSide?: number;
  /** Maximum pages scanned for composite figure rendering in one pass so ingestion stays fast (default 45). */
  maxPages?: number;
  /** Maximum figures extracted in one pass (default 36). */
  maxFigures?: number;
  quality?: number;
  createCanvas?: (w: number, h: number) => HTMLCanvasElement;
  renderPageToCanvas?: (page: PDFPageProxy, viewport: ReturnType<PDFPageProxy["getViewport"]>, canvas: HTMLCanvasElement) => Promise<void>;
}

/**
 * Extracts composite `2×` rendered textbook figures (preserving raster base + PDF vector arrows + text labels)
 * across selected pages of a PDF. Pages with zero detected figures never allocate or render a canvas!
 */
export async function extractPdfFigures(data: ArrayBuffer, opts: ExtractFiguresOptions = {}): Promise<ExtractedPdfFigure[]> {
  const shift = Math.max(0, Math.trunc((opts.pageOffset ?? 1) - 1));
  const maxSide = opts.maxSide ?? 1200;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_EXTRACT_PAGES;
  const maxFigures = opts.maxFigures ?? DEFAULT_MAX_EXTRACTED_FIGURES;
  const makeCanvas =
    opts.createCanvas ??
    ((w: number, h: number) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      return c;
    });

  const task = getDocument({ data: new Uint8Array(data).slice(), ...pdfjsAssetOptions(opts.assets) });
  const pdf = await task.promise;
  try {
    const targetPhysPages = opts.pageNumbers
      ? [
          ...new Set(
            opts.pageNumbers
              .map((n) => Math.trunc(n))
              .map((n) => (shift > 0 && n > pdf.numPages ? n - shift : n))
              .filter((phys) => phys >= 1 && phys <= pdf.numPages),
          ),
        ].sort((a, b) => a - b)
      : Array.from({ length: pdf.numPages }, (_, i) => i + 1);

    const boundedPages = targetPhysPages.slice(0, maxPages);
    const results: ExtractedPdfFigure[] = [];

    for (const physNo of boundedPages) {
      if (results.length >= maxFigures) break;
      const pageNo = physNo + shift;
      const page = await pdf.getPage(physNo);
      try {
        const [content, ops] = await Promise.all([page.getTextContent(), page.getOperatorList().catch(() => null)]);
        const items = content.items.filter((it): it is TextItem => "str" in it);
        const detected = detectPageFigures(page.view, items, ops);
        if (!detected.length) continue;

        // Render full composite page at 2x scale once, then crop each detected figure region!
        const viewport = page.getViewport({ scale: 2 });
        const pageCanvas = makeCanvas(Math.round(viewport.width), Math.round(viewport.height));
        pageCanvas.width = Math.round(viewport.width);
        pageCanvas.height = Math.round(viewport.height);
        if (opts.renderPageToCanvas) {
          await opts.renderPageToCanvas(page, viewport, pageCanvas);
        } else {
          await page.render({ canvas: pageCanvas, viewport, background: "#ffffff" }).promise;
        }

        for (let k = 0; k < detected.length && results.length < maxFigures; k++) {
          const det = detected[k]!;
          const cropped = cropNormalizedRegion(pageCanvas, det.normBox, {
            maxSide,
            quality: opts.quality,
            createCanvas: makeCanvas,
          });
          const fallbackLabel = det.label || `p.${pageNo} Fig ${k + 1}`;
          results.push({
            pageNo,
            label: fallbackLabel,
            caption: det.caption || fallbackLabel,
            image: cropped.image,
            width: cropped.width,
            height: cropped.height,
          });
        }
      } finally {
        page.cleanup();
      }
    }
    return results;
  } finally {
    await task.destroy();
  }
}

/** Renders one page of a PDF Blob at `2×` scale into a Canvas for interactive drag-cropping in the browser. */
export async function renderPdfPageCanvas(
  file: Blob,
  pageNo: number,
  opts: { assets?: string; scale?: number; pageOffset?: number } = {},
): Promise<HTMLCanvasElement> {
  const shift = Math.max(0, Math.trunc((opts.pageOffset ?? 1) - 1));
  const task = getDocument({ data: new Uint8Array(await file.arrayBuffer()).slice(), ...pdfjsAssetOptions(opts.assets) });
  const pdf = await task.promise;
  try {
    const physNo = shift > 0 && pageNo > pdf.numPages ? pageNo - shift : pageNo;
    const clamped = Math.max(1, Math.min(pdf.numPages, Math.trunc(physNo)));
    const page = await pdf.getPage(clamped);
    try {
      const viewport = page.getViewport({ scale: opts.scale ?? 2 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, viewport, background: "#ffffff" }).promise;
      return canvas;
    } finally {
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
}

export interface ParseOptions {
  onProgress?: (done: number, total: number) => void;
  /** Base URL (or, under Node, directory) of the pdf.js CMaps and standard fonts. */
  assets?: string;
  /** Optional 1-based page numbers to extract while preserving true page numbers `no` and matching TOC subtree. */
  pageNumbers?: number[];
  /** Optional 1-based starting page number for pre-sliced PDFs (e.g. 693 maps physical 1..34 to 693..726). */
  pageOffset?: number;
}

export type InspectOptions = Pick<ParseOptions, "assets" | "pageOffset">;

function normalizeCallArgs<T extends object>(fallbackOrOpts?: string | T, maybeOpts?: T): { fallbackTitle: string; opts: T } {
  if (typeof fallbackOrOpts === "object" && fallbackOrOpts !== null) {
    return { fallbackTitle: "Untitled", opts: fallbackOrOpts };
  }
  return { fallbackTitle: fallbackOrOpts ?? "Untitled", opts: (maybeOpts ?? {}) as T };
}

/** Fast header/TOC/label preflight (< 150 ms on 1,000+ page textbooks): never extracts page text. */
export async function inspectPdf(data: ArrayBuffer, fallbackOrOpts?: string | InspectOptions, maybeOpts?: InspectOptions): Promise<PdfInspection> {
  const { fallbackTitle, opts } = normalizeCallArgs(fallbackOrOpts, maybeOpts);
  const shift = Math.max(0, Math.trunc((opts.pageOffset ?? 1) - 1));
  const task = getDocument({ data: new Uint8Array(data).slice(), ...pdfjsAssetOptions(opts.assets) });
  const pdf = await task.promise;
  try {
    const [meta, outlineRaw, rawLabels] = await Promise.all([
      pdf.getMetadata().catch(() => null),
      pdf.getOutline().catch(() => null),
      pdf.getPageLabels().catch(() => null),
    ]);
    const infoTitle = (meta?.info as { Title?: string } | undefined)?.Title?.trim();
    const rawToc = await readOutline(pdf, (outlineRaw ?? []) as unknown as RawOutline[], 1);
    const toc = shiftToc(rawToc, shift);
    const labelsList = (rawLabels ?? []) as string[];
    const pageLabels: Record<string, string> = {};
    for (let i = 0; i < labelsList.length; i++) {
      const no = i + 1 + shift;
      const label = labelsList[i]?.trim().slice(0, 20);
      if (label && label !== String(no)) pageLabels[String(no)] = label;
    }
    return {
      title: (infoTitle || fallbackTitle).slice(0, 300),
      pageCount: pdf.numPages + shift,
      toc,
      pageLabels,
    };
  } finally {
    await task.destroy();
  }
}

/** Parses a PDF in the browser: bookmarks + per-page text layer (minus text no reader can see) and each page's kind, from the same pass. */
export async function parsePdf(data: ArrayBuffer, fallbackOrOpts?: string | ParseOptions, maybeOpts?: ParseOptions): Promise<ParsedPdf> {
  const { fallbackTitle, opts } = normalizeCallArgs(fallbackOrOpts, maybeOpts);
  const shift = Math.max(0, Math.trunc((opts.pageOffset ?? 1) - 1));
  const task = getDocument({ data: new Uint8Array(data).slice(), ...pdfjsAssetOptions(opts.assets) });
  const pdf = await task.promise;
  try {
    const meta = await pdf.getMetadata().catch(() => null);
    const infoTitle = (meta?.info as { Title?: string } | undefined)?.Title?.trim();
    const outline = ((await pdf.getOutline()) ?? []) as unknown as RawOutline[];
    const fullToc = shiftToc(await readOutline(pdf, outline, 1), shift);
    const labels = ((await pdf.getPageLabels().catch(() => null)) ?? []) as string[];
    const pageCount = pdf.numPages + shift;

    const targetPhysPages = opts.pageNumbers
      ? [
          ...new Set(
            opts.pageNumbers
              .map((n) => Math.trunc(n))
              .map((n) => (shift > 0 && n > pdf.numPages ? n - shift : n))
              .filter((phys) => phys >= 1 && phys <= pdf.numPages),
          ),
        ].sort((a, b) => a - b)
      : Array.from({ length: pdf.numPages }, (_, i) => i + 1);

    const pages: ParsedPdf["pages"] = [];
    for (let idx = 0; idx < targetPhysPages.length; idx++) {
      const physNo = targetPhysPages[idx]!;
      const no = physNo + shift;
      const page = await pdf.getPage(physNo);
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
      const label = labels[physNo - 1]?.trim().slice(0, 20);
      pages.push({ no, text, kind, ...(label && label !== String(no) ? { label } : {}) });
      page.cleanup();
      opts.onProgress?.(idx + 1, targetPhysPages.length);
    }

    const toc = opts.pageNumbers ? filterTocForPages(fullToc, pageCount, new Set(pages.map((p) => p.no))) : fullToc;
    return { title: (infoTitle || fallbackTitle).slice(0, 300), pageCount, toc, pages };
  } finally {
    await task.destroy();
  }
}
