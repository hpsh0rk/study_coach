import { extractText, getDocumentProxy } from "unpdf";
import type { ParsedDocument } from "@kj/schema";
import type { InlinePdfParser, PdfProbe } from "./types.ts";

type PdfDoc = Awaited<ReturnType<typeof getDocumentProxy>>;
interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: OutlineNode[];
}

async function resolvePage(pdf: PdfDoc, dest: OutlineNode["dest"]): Promise<number | null> {
  try {
    const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
    const ref = Array.isArray(explicit) ? explicit[0] : null;
    if (ref == null) return null;
    if (typeof ref === "number") return ref + 1;
    return (await pdf.getPageIndex(ref as Parameters<PdfDoc["getPageIndex"]>[0])) + 1;
  } catch {
    return null;
  }
}

async function readOutline(pdf: PdfDoc): Promise<NonNullable<ParsedDocument["toc"]>> {
  const outline = ((await pdf.getOutline()) ?? []) as OutlineNode[];
  const toc: NonNullable<ParsedDocument["toc"]> = [];
  const walk = async (nodes: OutlineNode[], level: number) => {
    for (const n of nodes) {
      const page = await resolvePage(pdf, n.dest);
      if (page) toc.push({ title: n.title.trim(), level, page });
      if (n.items?.length) await walk(n.items, level + 1);
    }
  };
  await walk(outline, 1);
  return toc;
}

/**
 * Lightweight in-Worker parser (pdf.js via unpdf): bookmarks + text layer, no OCR, no figures.
 * Good enough for born-digital textbooks with bookmarks (M1a-1); heavy parsing goes to the container.
 */
export const pdfLiteParser: InlinePdfParser = {
  id: "pdf-lite",
  mode: "inline",
  version: "1",
  async parse(bytes) {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    try {
      const toc = await readOutline(pdf);
      const { totalPages, text } = await extractText(pdf, { mergePages: false });
      const first = await pdf.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      const pages = Array.from({ length: totalPages }, (_, i) => ({ no: i + 1, width: vp.width, height: vp.height }));
      const blocks = (text as string[]).map((t, i) => ({
        id: `blk_p${i + 1}`,
        page: i + 1,
        bbox: [0, 0, vp.width, vp.height] as [number, number, number, number],
        type: "text" as const,
        text: t.replace(/\s+\n/g, "\n").trim(),
        confidence: t.trim() ? 0.9 : 0,
      }));
      return {
        parser: { id: "pdf-lite", version: this.version },
        pageCount: totalPages,
        pages,
        ...(toc.length ? { toc } : {}),
        blocks,
      };
    } finally {
      await (pdf as unknown as { cleanup?: () => Promise<void> }).cleanup?.();
    }
  },
};

export function probeParsed(doc: ParsedDocument): PdfProbe {
  const withText = doc.blocks.filter((b) => (b.text ?? "").length > 20).length;
  return { pageCount: doc.pageCount, hasOutline: !!doc.toc?.length, textLayerRatio: doc.pageCount ? withText / doc.pageCount : 0 };
}
