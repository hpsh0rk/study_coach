import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import type { ParsedPdf, TocEntry } from "@kj/schema";

export { GlobalWorkerOptions };

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

/** Parses a born-digital PDF in the browser: bookmarks + per-page text layer. */
export async function parsePdf(data: ArrayBuffer, fallbackTitle: string, onProgress?: (done: number, total: number) => void): Promise<ParsedPdf> {
  const task = getDocument({ data: new Uint8Array(data) });
  const pdf = await task.promise;
  try {
    const meta = await pdf.getMetadata().catch(() => null);
    const infoTitle = (meta?.info as { Title?: string } | undefined)?.Title?.trim();
    const outline = ((await pdf.getOutline()) ?? []) as unknown as RawOutline[];
    const toc = await readOutline(pdf, outline, 1);
    const pages: ParsedPdf["pages"] = [];
    for (let no = 1; no <= pdf.numPages; no++) {
      const page = await pdf.getPage(no);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str;
        text += item.hasEOL ? "\n" : " ";
      }
      pages.push({ no, text: text.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, 40_000) });
      page.cleanup();
      onProgress?.(no, pdf.numPages);
    }
    return { title: (infoTitle || fallbackTitle).slice(0, 300), pageCount: pdf.numPages, toc, pages };
  } finally {
    await task.destroy();
  }
}
