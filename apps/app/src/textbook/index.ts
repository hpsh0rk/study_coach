/**
 * The textbook module's read interface: the only way lesson, generation and share code reaches a
 * textbook's pages, chapters and labels. It knows nothing about lessons (see .dependency-cruiser.cjs).
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { chapterRunsOf, isEmptyPage, MIN_PAGE_WORDS, missingRanges, normalizeRanges, pagesInRanges, rangesForChapters, sourceCut, type ChapterRun } from "@kj/pdf-structure";
import type { ChapterNode, LessonScope, PageRange, PageText } from "@kj/schema";
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
  if (!row || (row.archivedAt !== null && !opts.archived)) throw new HttpError(404, "NOT_FOUND", "Document not found · 找不到该文档");
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

/** Per-page sizes for the chapters step (no page text): index i is page i + 1. */
export async function pageMeta(env: Env, doc: Pick<TextbookRow, "id" | "pageCount">): Promise<{ labels: Record<number, string>; words: number[]; chars: number[] }> {
  const rows = await db(env).select({ no: pages.no, words: pages.words, chars: sql<number>`LENGTH(${pages.text})`, label: pages.label }).from(pages).where(eq(pages.documentId, doc.id));
  const words = new Array<number>(doc.pageCount).fill(0);
  const chars = new Array<number>(doc.pageCount).fill(0);
  const labels: Record<number, string> = {};
  for (const p of rows) {
    words[p.no - 1] = p.words;
    chars[p.no - 1] = p.chars;
    if (p.label) labels[p.no] = p.label;
  }
  return { labels, words, chars };
}

/** Printed page labels of a textbook (only pages whose label differs from the index). */
export async function pageLabels(env: Env, documentId: string): Promise<Record<number, string>> {
  const rows = await db(env)
    .select({ no: pages.no, label: pages.label })
    .from(pages)
    .where(and(eq(pages.documentId, documentId), isNotNull(pages.label)));
  return Object.fromEntries(rows.map((r) => [r.no, r.label!]));
}

/** One page's text and printed label (also for deleted textbooks: lessons made from them still cite it). */
export async function page(env: Env, documentId: string, no: number): Promise<{ no: number; text: string; label: string | null } | null> {
  const row = (await db(env).select({ no: pages.no, text: pages.text, label: pages.label }).from(pages).where(and(eq(pages.documentId, documentId), eq(pages.no, no))).limit(1))[0];
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

export interface ScopeStats {
  /** Word count (for the "this needs about N minutes" estimate). */
  words: number;
  /** Pages without usable text (scanned images): never sent to the model. */
  emptyPages: number[];
  /** Pages with text beyond `sourceBudget` characters: a planner reading that much cannot read them. */
  unreadPages: number[];
}

/** One query over the selection's page sizes; texts are not loaded (LENGTH() predicts the source cut). */
export async function scopeStats(env: Env, documentId: string, ranges: PageRange[], opts: { sourceBudget: number }): Promise<ScopeStats> {
  const inRanges = or(...ranges.map((r) => and(gte(pages.no, r.start), lte(pages.no, r.end))));
  const rows = await db(env)
    .select({ no: pages.no, words: pages.words, chars: sql<number>`LENGTH(${pages.text})` })
    .from(pages)
    .where(and(eq(pages.documentId, documentId), inRanges))
    .orderBy(asc(pages.no));
  const withText = rows.filter((r) => !isEmptyPage(r.words));
  return {
    words: rows.reduce((n, r) => n + r.words, 0),
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
): Promise<{ scope: { chapterIds: string[]; ranges: PageRange[] }; title: string }> {
  const doc = await ownedTextbook(env, user, documentId, { archived: existing });
  if (doc.pagesReceived < doc.pageCount) throw new HttpError(409, "DOCUMENT_INCOMPLETE", "The PDF is still uploading · PDF 还在上传");
  const tree = await chapterTree(env, doc.id);
  const known = new Set(tree.map((c) => c.id));
  const ids = chapterIds.filter((id) => known.has(id));
  const fromChapters = ids.length ? rangesForChapters(tree, ids, doc.pageCount) : [];
  const merged = normalizeRanges([...fromChapters, ...ranges], doc.pageCount);
  if (!merged.length) throw new HttpError(400, "EMPTY_SCOPE", "Choose at least one chapter or page range · 请至少选择一个章节或页码范围");
  const picked = tree.filter((c) => ids.includes(c.id) && !(c.parentId && ids.includes(c.parentId)));
  const title = picked.length ? picked.map((c) => c.title).join(" · ") : `${doc.title} pp. ${merged.map((r) => `${r.start}–${r.end}`).join(", ")}`;
  return { scope: { chapterIds: ids, ranges: merged }, title: title.slice(0, 200) };
}
