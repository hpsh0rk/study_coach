import { getDocument, GlobalWorkerOptions, OPS, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import { suspiciousSpans, type ParsedPdf, type TocEntry } from "@kj/schema";

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

/**
 * Strings drawn in white on a page. Walking the operator list costs about as much as rendering, so
 * it only runs on pages whose text already looks like an injected instruction.
 */
async function whiteStrings(page: PDFPageProxy): Promise<string[]> {
  const { fnArray, argsArray } = await page.getOperatorList();
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

export interface ParseOptions {
  onProgress?: (done: number, total: number) => void;
  /** Base URL (or, under Node, directory) of the pdf.js CMaps and standard fonts. */
  assets?: string;
}

/** Parses a born-digital PDF in the browser: bookmarks + per-page text layer, minus text no reader can see. */
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
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item) || (item.str.trim() && Math.hypot(item.transform[2]!, item.transform[3]!) < MIN_FONT)) continue;
        text += item.str;
        text += item.hasEOL ? "\n" : " ";
      }
      if (suspiciousSpans(text).some((s) => s.kind === "instruction")) {
        for (const hidden of await whiteStrings(page).catch(() => [])) text = text.split(hidden).join(" ");
      }
      const label = labels[no - 1]?.trim().slice(0, 20);
      pages.push({ no, text: text.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, 40_000), ...(label && label !== String(no) ? { label } : {}) });
      page.cleanup();
      opts.onProgress?.(no, pdf.numPages);
    }
    return { title: (infoTitle || fallbackTitle).slice(0, 300), pageCount: pdf.numPages, toc, pages };
  } finally {
    await task.destroy();
  }
}
