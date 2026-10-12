import { countWords, type ChapterNode, type PageRange, type PageText, type TocEntry } from "@kj/schema";

export const MAX_TREE_DEPTH = 3;
/** Average characters per page below which a PDF is treated as scanned (no text layer). */
export const MIN_CHARS_PER_PAGE = 40;

interface FlatEntry {
  title: string;
  page: number;
  level: number;
  parentIndex: number | null;
}

function flatten(entries: TocEntry[], level: number, parentIndex: number | null, out: FlatEntry[]): void {
  for (const e of entries) {
    const index = out.length;
    out.push({ title: e.title.replace(/\s+/g, " ").trim(), page: e.page, level, parentIndex });
    if (level < MAX_TREE_DEPTH) flatten(e.children, level + 1, index, out);
  }
}

/**
 * Chapter tree from PDF bookmarks. A node ends where the next node at the same or a
 * shallower level starts (minus one page), never before its own start page.
 * Returns [] when the PDF has no bookmarks; the UI then falls back to page ranges.
 */
export function buildChapterTree(toc: TocEntry[], pageCount: number, pages: PageText[] = [], makeId: (ord: number) => string = (ord) => `c${ord}`): ChapterNode[] {
  const flat: FlatEntry[] = [];
  flatten(toc, 1, null, flat);
  const words = new Map(pages.map((p) => [p.no, countWords(p.text)]));
  const ids = flat.map((_, i) => makeId(i));
  return flat.map((e, i) => {
    const start = Math.min(Math.max(1, e.page), pageCount);
    let end = pageCount;
    for (let j = i + 1; j < flat.length; j++) {
      if (flat[j]!.level <= e.level) {
        end = flat[j]!.page - 1;
        break;
      }
    }
    end = Math.min(Math.max(start, end), pageCount);
    let w = 0;
    for (let p = start; p <= end; p++) w += words.get(p) ?? 0;
    return {
      id: ids[i]!,
      parentId: e.parentIndex === null ? null : ids[e.parentIndex]!,
      level: e.level,
      ord: i,
      title: e.title,
      pageStart: start,
      pageEnd: end,
      words: w,
    };
  });
}

/** Sorted, clamped, merged ranges (adjacent or overlapping ranges are joined). */
export function normalizeRanges(ranges: PageRange[], pageCount: number): PageRange[] {
  const clamped = ranges
    .map((r) => ({ start: Math.max(1, Math.min(r.start, pageCount)), end: Math.max(1, Math.min(r.end, pageCount)) }))
    .map((r) => (r.end < r.start ? { start: r.end, end: r.start } : r))
    .sort((a, b) => a.start - b.start);
  const out: PageRange[] = [];
  for (const r of clamped) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export function rangesForChapters(tree: ChapterNode[], chapterIds: string[], pageCount: number): PageRange[] {
  const wanted = new Set(chapterIds);
  return normalizeRanges(
    tree.filter((c) => wanted.has(c.id)).map((c) => ({ start: c.pageStart, end: c.pageEnd })),
    pageCount,
  );
}

export function pagesInRanges(ranges: PageRange[]): number[] {
  const out: number[] = [];
  for (const r of ranges) for (let p = r.start; p <= r.end; p++) out.push(p);
  return out;
}

export function countPages(ranges: PageRange[]): number {
  return ranges.reduce((n, r) => n + r.end - r.start + 1, 0);
}

/**
 * Source text for the model, each page prefixed with "[p.N]" so outputs can cite pages.
 * When over budget every page is trimmed proportionally rather than dropping later pages.
 */
export function textForRanges(pages: PageText[], ranges: PageRange[], maxChars = 24_000): string {
  const wanted = new Set(pagesInRanges(ranges));
  const selected = pages.filter((p) => wanted.has(p.no)).sort((a, b) => a.no - b.no);
  const clean = selected.map((p) => ({ no: p.no, text: p.text.replace(/\s+/g, " ").trim() }));
  const total = clean.reduce((n, p) => n + p.text.length, 0);
  const ratio = total > maxChars ? maxChars / total : 1;
  return clean
    .map((p) => {
      const limit = Math.max(80, Math.floor(p.text.length * ratio));
      const t = p.text.length > limit ? `${p.text.slice(0, limit)}…` : p.text;
      return `[p.${p.no}] ${t}`;
    })
    .join("\n");
}

export function detectTextLayer(pages: PageText[], pageCount: number): boolean {
  if (pageCount === 0) return false;
  const chars = pages.reduce((n, p) => n + p.text.replace(/\s+/g, "").length, 0);
  return chars / pageCount >= MIN_CHARS_PER_PAGE;
}

/** Children lookup for rendering the tree. */
export function childrenOf(tree: ChapterNode[], parentId: string | null): ChapterNode[] {
  return tree.filter((c) => c.parentId === parentId).sort((a, b) => a.ord - b.ord);
}

/** All descendant ids (inclusive), used when ticking a parent selects its sections. */
export function subtreeIds(tree: ChapterNode[], id: string): string[] {
  const out = [id];
  for (const c of tree) if (c.parentId === id) out.push(...subtreeIds(tree, c.id));
  return out;
}
