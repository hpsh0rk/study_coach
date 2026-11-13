/**
 * The textbook module's read interface: the only way lesson, generation and share code reaches a
 * textbook's pages, chapters and labels. It knows nothing about lessons.
 */
import { and, asc, between, count, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { chapterRunsOf, countPages, isEmptyPage, MIN_PAGE_WORDS, missingRanges, MUST_FIX_KINDS, PDFJS_PARSER, type PageFlag, normalizeRanges, pagesInRanges, rangesForChapters, sourceCut, topSections, type ChapterRun } from "@kj/textbook";
import { decodeSourcePage, encodeSourcePage, shortSourceTitle, SOURCE_STRIDE, type ChapterNode, type LessonScope, type PageKind, type PageRange, type PageText, type PdfLessonSource } from "@kj/schema";
import { db } from "../db/index.ts";
import type { Env, SessionUser } from "../env.ts";
import { HttpError } from "../http.ts";
import { chapters, documents, pages } from "./tables.ts";

export type TextbookRow = typeof documents.$inferSelect;

/**
 * Deleted (archived) textbooks are not found unless `archived` is set: reads of its pages for
 * lessons already made from it, editing those lessons' scope, and restore.
 */
export async function ownedTextbook(env: Env, user: SessionUser, id: string, opts: { archived?: boolean } = {}): Promise<TextbookRow> {
  const row = (await db(env).select().from(documents).where(and(eq(documents.id, id), eq(documents.orgId, user.orgId), eq(documents.ownerId, user.id))).limit(1))[0];
  if (!row || row.purgedAt !== null || (row.archivedAt !== null && !opts.archived)) throw new HttpError(404, "NOT_FOUND", "Document not found · 找不到该文档");
  return row;
}

/** The teacher's textbooks (complete or still uploading), newest first, without deleted ones. */
export async function textbookList(env: Env, user: SessionUser): Promise<TextbookRow[]> {
  return db(env)
    .select()
    .from(documents)
    .where(and(eq(documents.orgId, user.orgId), eq(documents.ownerId, user.id), isNull(documents.archivedAt)))
    .orderBy(desc(documents.createdAt))
    .limit(100);
}

export interface LibraryRow {
  id: string;
  title: string;
  filename: string;
  pageCount: number;
  pagesReceived: number;
  /** Pages still without usable text: almost empty (not blank by design), or a must-fix kind still holding the pdf.js text. */
  flaggedPages: number;
  createdAt: number;
  archivedAt: number | null;
}

/** 教材管理: the teacher's textbooks including archived ones (not those deleted for good), newest first. */
export async function textbookLibrary(env: Env, user: SessionUser): Promise<LibraryRow[]> {
  return db(env)
    .select({
      id: documents.id,
      title: documents.title,
      filename: documents.filename,
      pageCount: documents.pageCount,
      pagesReceived: documents.pagesReceived,
      flaggedPages: sql<number>`(select count(*) from ${pages} where ${pages.documentId} = ${documents.id} and (
        (${pages.kind} in (${sql.join(MUST_FIX_KINDS.map((k) => sql`${k}`), sql`, `)}) and ${pages.parser} = ${PDFJS_PARSER})
        or (${pages.words} < ${MIN_PAGE_WORDS} and coalesce(${pages.kind}, '') <> 'blank')))`,
      createdAt: documents.createdAt,
      archivedAt: documents.archivedAt,
    })
    .from(documents)
    .where(and(eq(documents.orgId, user.orgId), eq(documents.ownerId, user.id), isNull(documents.purgedAt)))
    .orderBy(desc(documents.createdAt))
    .limit(200);
}

/** Textbooks in the org that are not deleted, for the 后台 overview. */
export async function textbookCount(env: Env, orgId: string): Promise<number> {
  return (await db(env).select({ n: count() }).from(documents).where(and(eq(documents.orgId, orgId), isNull(documents.archivedAt))))[0]?.n ?? 0;
}

export type TextbookLookup =
  | { status: "none" }
  | { status: "ready"; document: TextbookRow }
  | { status: "incomplete"; document: TextbookRow; missing: PageRange[] }
  | { status: "archived"; document: TextbookRow };

/**
 * Has this teacher uploaded this file before? `ready`: use it as is (no parsing, no upload); `incomplete`:
 * an interrupted upload, resume with the `missing` pages; `archived`: deleted, can be restored.
 */
export async function lookupTextbook(env: Env, user: SessionUser, sha256: string): Promise<TextbookLookup> {
  const rows = await db(env)
    .select()
    .from(documents)
    .where(and(eq(documents.orgId, user.orgId), eq(documents.ownerId, user.id), eq(documents.fileSha256, sha256)))
    .orderBy(desc(documents.createdAt));
  const active = rows.find((r) => r.archivedAt === null);
  if (!active) return rows[0] ? { status: "archived", document: rows[0] } : { status: "none" };
  if (active.pagesReceived >= active.pageCount) return { status: "ready", document: active };
  const present = await db(env).select({ no: pages.no }).from(pages).where(eq(pages.documentId, active.id));
  return { status: "incomplete", document: active, missing: missingRanges(present.map((p) => p.no), active.pageCount) };
}

export async function chapterTree(env: Env, documentId: string): Promise<ChapterNode[]> {
  const rows = await db(env).select().from(chapters).where(eq(chapters.documentId, documentId)).orderBy(chapters.ord);
  return rows.map(({ documentId: _d, ...ch }) => ch);
}

export interface PageMeta {
  labels: Record<number, string>;
  /** Index i is page i + 1. */
  words: number[];
  chars: number[];
  /** Only pages whose text did not come from the PDF's text layer (e.g. `paste`). */
  parsers: Record<number, string>;
  /** Only pages with suspicious text. */
  flags: Record<number, PageFlag[]>;
  /** Only pages whose kind is neither `text` nor `blank` (must-fix and refine kinds). */
  kinds: Record<number, PageKind>;
  /** Contiguous ranges of pages already uploaded to D1 (`[{ start: 1, end: pageCount }]` when complete). */
  importedRanges: PageRange[];
}

/** Per-page facts for the chapters step, without page text. */
export async function pageMeta(env: Env, doc: Pick<TextbookRow, "id" | "pageCount">): Promise<PageMeta> {
  const rows = await db(env)
    .select({ no: pages.no, words: pages.words, chars: pages.chars, label: pages.label, parser: pages.parser, flags: pages.flags, kind: pages.kind })
    .from(pages)
    .where(eq(pages.documentId, doc.id));
  const importedRanges =
    rows.length === 0
      ? []
      : rows.length >= doc.pageCount
        ? [{ start: 1, end: doc.pageCount }]
        : normalizeRanges(
            rows.map((p) => ({ start: p.no, end: p.no })),
            doc.pageCount,
          );
  const meta: PageMeta = { labels: {}, words: new Array<number>(doc.pageCount).fill(0), chars: new Array<number>(doc.pageCount).fill(0), parsers: {}, flags: {}, kinds: {}, importedRanges };
  for (const p of rows) {
    meta.words[p.no - 1] = p.words;
    meta.chars[p.no - 1] = p.chars;
    if (p.label) meta.labels[p.no] = p.label;
    if (p.parser !== PDFJS_PARSER) meta.parsers[p.no] = p.parser;
    if (p.flags.length) meta.flags[p.no] = p.flags;
    if (p.kind && p.kind !== "text" && p.kind !== "blank") meta.kinds[p.no] = p.kind;
  }
  return meta;
}

/**
 * Printed labels of only the given pages and ranges (pages whose label differs from the index): a
 * shared deck carries the labels of the pages it cites, not of the whole book. Usually one query.
 */
export async function labelsFor(env: Env, documentId: string, want: { ranges?: PageRange[]; pages?: number[] }): Promise<Record<number, string>> {
  const merged = normalizeRanges([...(want.ranges ?? []), ...(want.pages ?? []).map((no) => ({ start: no, end: no }))], Number.MAX_SAFE_INTEGER);
  const out: Record<number, string> = {};
  // Two bound parameters per range, under D1's 100 per query.
  for (let i = 0; i < merged.length; i += 45) {
    const rows = await db(env)
      .select({ no: pages.no, label: pages.label })
      .from(pages)
      .where(and(eq(pages.documentId, documentId), isNotNull(pages.label), or(...merged.slice(i, i + 45).map((r) => between(pages.no, r.start, r.end)))));
    for (const r of rows) out[r.no] = r.label!;
  }
  return out;
}

/** One page's text, printed label and where the text came from (also for deleted textbooks: lessons made from them still cite it). */
export async function page(env: Env, documentId: string, no: number): Promise<{ no: number; text: string; label: string | null; parser: string } | null> {
  const row = (await db(env).select({ no: pages.no, text: pages.text, label: pages.label, parser: pages.parser }).from(pages).where(and(eq(pages.documentId, documentId), eq(pages.no, no))).limit(1))[0];
  return row ?? null;
}

/** Text of the given pages that have any (pages without text never reach the model), in page order. */
export async function pageTexts(env: Env, documentId: string, wanted: number[]): Promise<PageText[]> {
  const out: PageText[] = [];
  for (let i = 0; i < wanted.length; i += 90) {
    const chunk = wanted.slice(i, i + 90);
    const rows = await db(env)
      .select({ no: pages.no, text: pages.text, label: pages.label })
      .from(pages)
      .where(and(eq(pages.documentId, documentId), inArray(pages.no, chunk), gte(pages.words, MIN_PAGE_WORDS)))
      .orderBy(asc(pages.no));
    out.push(...rows.map((r) => ({ no: r.no, text: r.text, ...(r.label ? { label: r.label } : {}) })));
  }
  return out;
}

/** Text of a selection's pages that have any. */
export async function selectionPages(env: Env, documentId: string, ranges: PageRange[]): Promise<PageText[]> {
  return pageTexts(env, documentId, pagesInRanges(ranges));
}

/**
 * The pages one slide is written and checked from: its cited pages inside the selection, or the whole
 * selection when it cites none (the 待核实 check then reads all of it). Mirrors generation's
 * `sourcePagesFor` / `checkSourceText`, so a slide never loads the selection it does not use.
 */
export async function slideSourcePages(env: Env, documentId: string, cited: number[], ranges: PageRange[]): Promise<PageText[]> {
  if (!cited.length) return selectionPages(env, documentId, ranges);
  const inSelection = new Set(pagesInRanges(ranges));
  return pageTexts(env, documentId, [...new Set(cited)].filter((no) => inSelection.has(no)).sort((a, b) => a - b));
}

export interface ScopeStats {
  /** Word count (for the "this needs about N minutes" estimate). */
  words: number;
  /** Pages without usable text (scanned images): never sent to the model. */
  emptyPages: number[];
  /** Pages with text beyond `sourceBudget` characters: a planner reading that much cannot read them. */
  unreadPages: number[];
}

/** One query over the selection's page sizes; texts are not loaded (`pages.chars` predicts the source cut). */
export async function scopeStats(env: Env, documentId: string, ranges: PageRange[], opts: { sourceBudget: number }): Promise<ScopeStats> {
  const inRanges = or(...ranges.map((r) => and(gte(pages.no, r.start), lte(pages.no, r.end))));
  const rows = await db(env)
    .select({ no: pages.no, words: pages.words, chars: pages.chars })
    .from(pages)
    .where(and(eq(pages.documentId, documentId), inRanges))
    .orderBy(asc(pages.no));
  const withText = rows.filter((r) => !isEmptyPage(r.words));
  return {
    words: withText.reduce((n, r) => n + r.words, 0),
    emptyPages: rows.filter((r) => isEmptyPage(r.words)).map((r) => r.no),
    unreadPages: sourceCut(withText, opts.sourceBudget).omitted,
  };
}

/** The selection cut into runs of pages per leaf chapter, with word counts (the input of a unit split). */
export async function chapterRuns(env: Env, documentId: string, scope: Pick<LessonScope, "chapterIds" | "ranges">, tree: ChapterNode[]): Promise<ChapterRun[]> {
  const nos = pagesInRanges(scope.ranges);
  const words = new Map<number, number>();
  for (let i = 0; i < nos.length; i += 90) {
    const rows = await db(env)
      .select({ no: pages.no, words: pages.words })
      .from(pages)
      .where(and(eq(pages.documentId, documentId), inArray(pages.no, nos.slice(i, i + 90))))
      .orderBy(asc(pages.no));
    for (const r of rows) words.set(r.no, r.words);
  }
  return chapterRunsOf(tree, scope, words);
}

/** Multi-PDF selection pages: `ord = 0` keeps raw `no`, `ord = k >= 1` maps to `k * 100_000 + no`. */
export async function multiSelectionPages(env: Env, pdfSources: Pick<PdfLessonSource, "documentId" | "title" | "ranges">[]): Promise<PageText[]> {
  if (!pdfSources.length) return [];
  const groups = await Promise.all(pdfSources.map((src) => selectionPages(env, src.documentId, src.ranges)));
  return groups.flatMap((list, idx) => {
    const prefix = idx === 0 ? "" : shortSourceTitle(pdfSources[idx]!.title);
    return list.map((p) => ({
      no: encodeSourcePage(idx, p.no),
      text: p.text,
      ...(idx === 0 ? (p.label ? { label: p.label } : {}) : { label: `${prefix} p.${p.label ?? p.no}` }),
    }));
  });
}

/** Multi-PDF slide source pages: resolves cited virtual page numbers across attached PDFs (or full selection when uncited). */
export async function multiSlideSourcePages(
  env: Env,
  pdfSources: Pick<PdfLessonSource, "documentId" | "title" | "ranges">[],
  cited: number[],
): Promise<PageText[]> {
  if (pdfSources.length <= 1) {
    const first = pdfSources[0];
    return first ? slideSourcePages(env, first.documentId, cited, first.ranges) : [];
  }
  if (!cited.length) return multiSelectionPages(env, pdfSources);
  const bySource = new Map<number, number[]>();
  for (const v of [...new Set(cited)]) {
    const { pdfIndex, pageNo } = decodeSourcePage(v);
    if (pdfIndex < 0 || pdfIndex >= pdfSources.length) continue;
    const allowed = new Set(pagesInRanges(pdfSources[pdfIndex]!.ranges));
    if (!allowed.has(pageNo)) continue;
    const arr = bySource.get(pdfIndex) ?? [];
    arr.push(pageNo);
    bySource.set(pdfIndex, arr);
  }
  const groups = await Promise.all(
    [...bySource.entries()].map(async ([idx, nos]) => {
      const src = pdfSources[idx]!;
      const rows = await pageTexts(env, src.documentId, nos.sort((a, b) => a - b));
      const prefix = idx === 0 ? "" : shortSourceTitle(src.title);
      return rows.map((p) => ({
        no: encodeSourcePage(idx, p.no),
        text: p.text,
        ...(idx === 0 ? (p.label ? { label: p.label } : {}) : { label: `${prefix} p.${p.label ?? p.no}` }),
      }));
    }),
  );
  return groups.flat().sort((a, b) => a.no - b.no);
}

/** Multi-PDF scope word/empty/unread stats across all attached PDFs. */
export async function multiScopeStats(
  env: Env,
  pdfSources: Pick<PdfLessonSource, "documentId" | "ranges">[],
  opts: { sourceBudget: number },
): Promise<ScopeStats> {
  if (pdfSources.length <= 1) {
    const first = pdfSources[0];
    return first ? scopeStats(env, first.documentId, first.ranges, opts) : { words: 0, emptyPages: [], unreadPages: [] };
  }
  const perSource = await Promise.all(
    pdfSources.map(async (src, idx) => {
      if (!src.ranges.length) return [];
      const inRanges = or(...src.ranges.map((r) => and(gte(pages.no, r.start), lte(pages.no, r.end))));
      const rows = await db(env)
        .select({ no: pages.no, words: pages.words, chars: pages.chars })
        .from(pages)
        .where(and(eq(pages.documentId, src.documentId), inRanges))
        .orderBy(asc(pages.no));
      return rows.map((r) => ({ no: encodeSourcePage(idx, r.no), words: r.words, chars: r.chars }));
    }),
  );
  const all = perSource.flat();
  const withText = all.filter((r) => !isEmptyPage(r.words));
  return {
    words: withText.reduce((n, r) => n + r.words, 0),
    emptyPages: all.filter((r) => isEmptyPage(r.words)).map((r) => r.no),
    unreadPages: sourceCut(withText, opts.sourceBudget).omitted,
  };
}

/** Multi-PDF page labels: primary PDF keeps printed labels; secondary PDFs map virtual pages to `"${shortTitle} p.N"`. */
export async function multiLabelsFor(
  env: Env,
  pdfSources: Pick<PdfLessonSource, "documentId" | "title" | "ranges">[],
  citedVirtualPages: number[],
  opts: { includeRanges?: boolean } = { includeRanges: true },
): Promise<Record<number, string>> {
  if (!pdfSources.length) return {};
  const includeRanges = opts.includeRanges ?? true;
  const primaryCited = citedVirtualPages.filter((v) => v <= SOURCE_STRIDE);
  const out: Record<number, string> = await labelsFor(env, pdfSources[0]!.documentId, {
    ...(includeRanges ? { ranges: pdfSources[0]!.ranges } : {}),
    pages: primaryCited,
  });
  for (let idx = 1; idx < pdfSources.length; idx++) {
    const src = pdfSources[idx]!;
    const citedForIdx = citedVirtualPages.filter((v) => decodeSourcePage(v).pdfIndex === idx).map((v) => decodeSourcePage(v).pageNo);
    const wantedPages = includeRanges ? [...new Set([...pagesInRanges(src.ranges), ...citedForIdx])] : [...new Set(citedForIdx)];
    if (!wantedPages.length) continue;
    const rawLabels = await labelsFor(env, src.documentId, { ...(includeRanges ? { ranges: src.ranges } : {}), pages: citedForIdx });
    const short = shortSourceTitle(src.title);
    for (const pageNo of wantedPages) {
      out[encodeSourcePage(idx, pageNo)] = `${short} p.${rawLabels[pageNo] ?? pageNo}`;
    }
  }
  return out;
}

/**
 * A selection of chapters and page ranges checked against the textbook: known chapter ids, merged ranges
 * and a title from the topmost picked chapters. `existing`: re-scoping a lesson that already uses the
 * textbook, which works after the textbook is deleted.
 */
export async function resolveScope(
  env: Env,
  user: SessionUser,
  documentId: string,
  chapterIds: string[],
  ranges: PageRange[],
  existing = false,
): Promise<{ scope: { chapterIds: string[]; ranges: PageRange[] }; title: string; docTitle: string }> {
  const doc = await ownedTextbook(env, user, documentId, { archived: existing });
  if (doc.pagesReceived === 0) throw new HttpError(409, "DOCUMENT_INCOMPLETE", "The PDF is still uploading · PDF 还在上传");
  const tree = await chapterTree(env, doc.id);
  const known = new Set(tree.map((c) => c.id));
  const ids = chapterIds.filter((id) => known.has(id));
  const fromChapters = ids.length ? rangesForChapters(tree, ids, doc.pageCount) : [];
  const merged = normalizeRanges([...fromChapters, ...ranges], doc.pageCount);
  if (!merged.length) throw new HttpError(400, "EMPTY_SCOPE", "Choose at least one chapter or page range · 请至少选择一个章节或页码范围");
  if (doc.pagesReceived < doc.pageCount) {
    const leavesWithWords = tree.filter((c) => c.words > 0 && !tree.some((k) => k.parentId === c.id));
    if (leavesWithWords.length > 0) {
      const presentRows = await db(env).select({ no: pages.no }).from(pages).where(eq(pages.documentId, doc.id));
      const presentSet = new Set(presentRows.map((r) => r.no));
      const midFlightFullUpload = leavesWithWords.some((ch) => {
        for (let p = ch.pageStart; p <= ch.pageEnd; p++) if (presentSet.has(p)) return false;
        return true;
      });
      if (midFlightFullUpload) throw new HttpError(409, "DOCUMENT_INCOMPLETE", "The PDF is still uploading · PDF 还在上传");
      let haveInMerged = 0;
      for (const r of merged) for (let p = r.start; p <= r.end; p++) if (presentSet.has(p)) haveInMerged++;
      if (haveInMerged < countPages(merged)) {
        throw new HttpError(409, "DOCUMENT_INCOMPLETE", "所选页码尚未导入完整，请先补传这些页 · Selected pages are not imported yet");
      }
    } else {
      let haveInMerged = 0;
      for (let i = 0; i < merged.length; i += 45) {
        const chunk = merged.slice(i, i + 45);
        const [cnt] = await db(env)
          .select({ n: count() })
          .from(pages)
          .where(and(eq(pages.documentId, doc.id), or(...chunk.map((r) => between(pages.no, r.start, r.end)))));
        haveInMerged += cnt?.n ?? 0;
      }
      if (haveInMerged < countPages(merged)) {
        throw new HttpError(409, "DOCUMENT_INCOMPLETE", "所选页码尚未导入完整，请先补传这些页 · Selected pages are not imported yet");
      }
    }
  }
  const picked = topSections(tree, ids);
  const title = picked.length ? picked.map((c) => c.title).join(" · ") : `${doc.title} pp. ${merged.map((r) => `${r.start}–${r.end}`).join(", ")}`;
  return { scope: { chapterIds: ids, ranges: merged }, title: title.slice(0, 200), docTitle: doc.title };
}
