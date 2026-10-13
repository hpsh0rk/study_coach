import { countWords, suspiciousSpans, type ChapterNode, type PageKind, type PageProbe, type PageRange, type PageText, type SuspiciousSpan, type TocEntry } from "@kj/schema";

export const MAX_TREE_DEPTH = 3;
/** Pages with fewer words carry no usable text (scanned images, figure-only pages, blank pages). */
export const MIN_PAGE_WORDS = 5;

export const isEmptyPage = (words: number) => words < MIN_PAGE_WORDS;

/** Where a page's text came from: `pdfjs/<version>` (the browser's text layer) or `paste` (typed in by the teacher for a scanned page). */
export const PDFJS_PARSER = "pdfjs/1";
export const PASTE_PARSER = "paste";

export type PageFlag = SuspiciousSpan["kind"];

/** What is stored about a page next to its text, computed by the server (never trusted from the browser). */
export interface PageFacts {
  words: number;
  chars: number;
  flags: PageFlag[];
}

export function pageFacts(text: string): PageFacts {
  return { words: countWords(text), chars: text.length, flags: [...new Set(suspiciousSpans(text).map((s) => s.kind))].sort() };
}

/** The text layer misses or mangles content on these pages: worth sending to a better parser automatically. */
export const MUST_FIX_KINDS: readonly PageKind[] = ["scanned", "garbled", "formula-lost"];
/** Readable as is; a better parser keeps structure. Only on the teacher's request ("精修本章"), never automatically. */
export const REFINE_KINDS: readonly PageKind[] = ["formula-text", "table"];
export const isMustFix = (kind: PageKind | null | undefined) => !!kind && MUST_FIX_KINDS.includes(kind);

/**
 * A page whose text a teacher may paste: no usable text, a must-fix page still holding the pdf.js text, or one
 * a vision model read (it may have misread digits; the teacher's text wins).
 */
export function needsText(p: { words: number; kind?: PageKind | null; parser?: string }): boolean {
  const parser = p.parser ?? PDFJS_PARSER;
  return isEmptyPage(p.words) || (isMustFix(p.kind) && (parser === PDFJS_PARSER || isVisionParser(parser)));
}

const MATH_CHARS = /[∑∏∫∮√∛∞∂∆∇±∓×÷·≤≥≈≠≡∝∈∉⊂⊃⊆∪∩∀∃→←↔⇒⇔⊥∥°′″αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼₀₁₂₃₄₅₆₇₈₉₊₋]/g;

/** Math symbols, Greek letters, super/subscripts and equals signs: a page of typeset formulas scores 40+. */
export function mathScore(text: string): number {
  return (text.match(MATH_CHARS)?.length ?? 0) + (text.match(/=/g)?.length ?? 0);
}

/** Share of non-space characters that are U+FFFD, private-use or control characters (fonts without a usable ToUnicode map). */
export function badCharRatio(text: string): number {
  const visible = text.replace(/\s/g, "").length;
  if (!visible) return 0;
  // eslint-disable-next-line no-control-regex
  return (text.match(/[\uFFFD\uE000-\uF8FF\u0000-\u0008\u000E-\u001F]/g)?.length ?? 0) / visible;
}

/** Thresholds from the parsing research (docs/research/pdf-parsing.md §7), checked in this order. */
export function classifyPage(p: PageProbe): PageKind {
  if ((p.chars < 30 && p.imageArea > 0.3) || (p.imageArea > 0.5 && p.chars < 400)) return "scanned";
  if (isEmptyPage(p.words)) return "blank";
  if (p.badCharRatio > 0.05) return "garbled";
  if (p.glyphRows >= 2 || (p.holes >= 2 && p.glyphs >= 5)) return "formula-lost";
  if (p.mathScore >= 40) return "formula-text";
  if (p.rules >= 20 || (p.rects >= 15 && p.gridRows >= 3)) return "table";
  return "text";
}

/** A parser that can take pages over from pdf.js, as the router sees it (enabled ones only, in preference order). */
export interface ParserChoice {
  id: string;
  kinds: readonly PageKind[];
}

/** The parser id for pages no enabled parser takes: the teacher pastes their text. */
export const MANUAL_PARSER = "manual";

/**
 * Which parser re-reads which page. Only pages of `kinds` are routed (must-fix ones automatically,
 * refine kinds when the teacher asks); each goes to the first parser that handles its kind, until
 * `limit` pages are assigned. The rest go to `manual`. Pure: the caller decides which parsers are enabled.
 */
export function routePages(pages: { no: number; kind: PageKind }[], parsers: readonly ParserChoice[], opts: { kinds: readonly PageKind[]; limit: number }): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  let assigned = 0;
  for (const p of pages) {
    if (!opts.kinds.includes(p.kind)) continue;
    const parser = assigned < opts.limit ? parsers.find((x) => x.kinds.includes(p.kind)) : undefined;
    const id = parser?.id ?? MANUAL_PARSER;
    if (parser) assigned++;
    (out[id] ??= []).push(p.no);
  }
  return out;
}

/** External parsers. The id carries the version: a page read by one is reused (same file, same page) only by the same id. */
export const MINERU_AGENT_PARSER = "mineru-agent/1";
export const MINERU_PARSER = "mineru/1";
export const isExternalParser = (parser: string | null | undefined) => !!parser && parser !== PDFJS_PARSER && parser !== PASTE_PARSER && !isVisionParser(parser);

/** A vision model's transcription of the page image (`vlm:<model>/1`): may misread digits, so the teacher is asked to check it. */
export const visionParserId = (model: string) => `vlm:${model}/1`;
export const isVisionParser = (parser: string | null | undefined) => !!parser && parser.startsWith("vlm:");

/** Vision models wrap their answer in a Markdown fence now and then; the page text is what is inside. */
export function cleanVisionText(text: string): string {
  const fenced = /^\s*```(?:markdown|md|latex|text)?[ \t]*\n([\s\S]*?)\n```\s*$/i.exec(text);
  return cleanParsedMarkdown(fenced ? fenced[1]! : text);
}

/**
 * A sub-PDF sent to an external parser has a page reading `KJPAGE n` before its n-th page. The result
 * comes back as one Markdown file without page boundaries; the separators map it back by page index.
 * (Text stamped into the page margin is dropped as a running header, so separators are whole pages.)
 */
export const separatorText = (i: number) => `KJPAGE ${i}`;

/** The Markdown of each of `count` pages, or null where its separator did not come back. */
export function splitSeparated(markdown: string, count: number): (string | null)[] {
  const out: (string | null)[] = new Array<string | null>(count).fill(null);
  const marks = [...markdown.matchAll(/^[ \t]*(?:#+[ \t]*)?KJPAGE[ \t]+(\d+)[ \t]*$/gm)];
  marks.forEach((m, k) => {
    const i = Number(m[1]) - 1;
    if (i < 0 || i >= count || out[i] !== null) return;
    const end = k + 1 < marks.length ? marks[k + 1]!.index : markdown.length;
    out[i] = cleanParsedMarkdown(markdown.slice(m.index + m[0].length, end));
  });
  return out;
}

/** Parser Markdown as page text: images and comments dropped, HTML tables as `a | b` rows; headings and LaTeX kept. */
export function cleanParsedMarkdown(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, " | ")
    .replace(/<tr[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 40_000);
}

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

/** Pages 1..pageCount not in `present`, as ranges (what an interrupted upload still has to send). */
export function missingRanges(present: number[], pageCount: number): PageRange[] {
  const have = new Set(present);
  const out: PageRange[] = [];
  for (let no = 1; no <= pageCount; no++) {
    if (have.has(no)) continue;
    const last = out[out.length - 1];
    if (last && last.end === no - 1) last.end = no;
    else out.push({ start: no, end: no });
  }
  return out;
}

export function countPages(ranges: PageRange[]): number {
  return ranges.reduce((n, r) => n + r.end - r.start + 1, 0);
}

export interface SourceText {
  /** Pages prefixed with "[p.N]" (N = page index) so outputs can cite pages. */
  text: string;
  included: number[];
  /** Selected pages left out because the character budget ran out. */
  omitted: number[];
}

const sourceLine = (p: Pick<PageText, "no" | "text">) => `[p.${p.no}] ${p.text.replace(/\s+/g, " ").trim()}`;

/**
 * Which pages fit a character budget, from each page's text length alone (no text needed, so the
 * server can predict the cut from `LENGTH(text)`). Pages are kept whole, in order, until the budget
 * runs out; everything after is omitted. A first page longer than the budget is still included (cut).
 */
export function sourceCut(pages: { no: number; chars: number }[], maxChars: number): { included: number[]; omitted: number[] } {
  const included: number[] = [];
  const omitted: number[] = [];
  let used = 0;
  for (const p of [...pages].sort((a, b) => a.no - b.no)) {
    const line = `[p.${p.no}] `.length + p.chars;
    if (omitted.length || (used + line > maxChars && included.length)) {
      omitted.push(p.no);
      continue;
    }
    included.push(p.no);
    used += line + 1;
  }
  return { included, omitted };
}

/**
 * Source text for the model. Pages are kept whole, in order, until the budget runs out; the
 * remaining pages are reported as omitted instead of trimming every page (examples and
 * summaries sit at the end of a page).
 */
export function sourceForRanges(pages: PageText[], ranges: PageRange[], maxChars: number): SourceText {
  const wanted = new Set(pagesInRanges(ranges));
  const lines = new Map(pages.filter((p) => wanted.has(p.no)).map((p) => [p.no, sourceLine(p)]));
  const cut = sourceCut([...lines].map(([no, line]) => ({ no, chars: line.length - `[p.${no}] `.length })), maxChars);
  return { text: cut.included.map((no) => lines.get(no)!.slice(0, maxChars)).join("\n"), ...cut };
}

/** Normalizes pasted or extracted page text the way the browser parser does (single spaces, single newlines). */
export function normalizePageText(text: string): string {
  return text.replace(/[ \t\u00a0]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/**
 * Splits text a teacher pasted for several pages into `n` consecutive chunks of similar length,
 * cutting after a sentence end or line break where possible, so each page gets its share for citations.
 */
export function distributeText(text: string, n: number): string[] {
  const t = normalizePageText(text);
  if (n <= 1) return [t];
  const out: string[] = [];
  let rest = t;
  const nearest = (s: string, re: RegExp, target: number) => {
    let best = -1;
    for (const m of s.matchAll(re)) {
      const at = m.index + m[0].length;
      if (at > 0 && at < s.length && (best < 0 || Math.abs(at - target) < Math.abs(best - target))) best = at;
    }
    return best;
  };
  for (let left = n; left > 1 && rest; left--) {
    const target = Math.ceil(rest.length / left);
    let at = nearest(rest, /[。！？.!?]+|\n/g, target);
    if (at < 0) at = nearest(rest, /\s+/g, target);
    if (at < 0 && target < 200) break;
    if (at < 0) at = target;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  out.push(rest);
  while (out.length < n) out.push("");
  return out;
}

/** Printed label of a page (falls back to the page index). */
export function labelOf(pages: Pick<PageText, "no" | "label">[] | Map<number, string>, no: number): string {
  const label = pages instanceof Map ? pages.get(no) : pages.find((p) => p.no === no)?.label;
  return label ?? String(no);
}

/** "12–15, 20" in printed labels for a sorted list of page indexes. */
export function formatPages(nos: number[], labels: Map<number, string> = new Map()): string {
  const out: string[] = [];
  for (let i = 0; i < nos.length; i++) {
    let j = i;
    while (j + 1 < nos.length && nos[j + 1] === nos[j]! + 1) j++;
    const a = labelOf(labels, nos[i]!);
    out.push(j > i ? `${a}–${labelOf(labels, nos[j]!)}` : a);
    i = j;
  }
  return out.join(", ");
}

/** Page index for a typed page reference: a printed label when the PDF has labels, else the index. */
export function pageForLabel(labels: Map<number, string>, token: string, pageCount: number): number | null {
  const t = token.trim();
  for (const [no, label] of labels) if (label.toLowerCase() === t.toLowerCase()) return no;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= pageCount ? n : null;
}

/** Children lookup for rendering the tree. */
export function childrenOf(tree: ChapterNode[], parentId: string | null): ChapterNode[] {
  return tree.filter((c) => c.parentId === parentId).sort((a, b) => a.ord - b.ord);
}

/** Selected chapters with no selected child, in reading order: the planner's sections and the owners of pages in a unit split. */
export function leafSections(tree: ChapterNode[], chapterIds: string[]): ChapterNode[] {
  const ids = new Set(chapterIds);
  return tree.filter((c) => ids.has(c.id) && !tree.some((k) => k.parentId === c.id && ids.has(k.id)));
}

/** Consecutive selected pages owned by one chapter (or by none), with their word counts. */
export interface ChapterRun {
  title: string;
  chapterId?: string;
  pages: { no: number; words: number }[];
}

/**
 * The selection cut into runs of pages owned by the same leaf chapter. A parent's intro pages (before its
 * first selected child) belong to the parent; pages outside every selected chapter are titled by their range.
 */
export function chapterRunsOf(tree: ChapterNode[], scope: { chapterIds: string[]; ranges: PageRange[] }, words: Map<number, number>): ChapterRun[] {
  const leaves = leafSections(tree, scope.chapterIds);
  const selected = tree.filter((c) => scope.chapterIds.includes(c.id)).sort((a, b) => b.level - a.level);
  const covers = (c: ChapterNode, no: number) => c.pageStart <= no && no <= c.pageEnd;
  const ownerOf = (no: number) => leaves.find((c) => covers(c, no)) ?? selected.find((c) => covers(c, no));
  const out: ChapterRun[] = [];
  for (const no of pagesInRanges(scope.ranges)) {
    const owner = ownerOf(no);
    const last = out[out.length - 1];
    const page = { no, words: words.get(no) ?? 0 };
    if (last && last.chapterId === owner?.id && last.pages[last.pages.length - 1]!.no === no - 1) last.pages.push(page);
    else out.push({ title: owner?.title ?? "", ...(owner ? { chapterId: owner.id } : {}), pages: [page] });
  }
  for (const r of out) {
    const [first, last] = [r.pages[0]!.no, r.pages[r.pages.length - 1]!.no];
    if (!r.title) r.title = first === last ? `p. ${first}` : `pp. ${first}–${last}`;
  }
  return out;
}

/** All descendant ids (inclusive), used when ticking a parent selects its sections. */
export function subtreeIds(tree: ChapterNode[], id: string): string[] {
  const out = [id];
  for (const c of tree) if (c.parentId === id) out.push(...subtreeIds(tree, c.id));
  return out;
}
