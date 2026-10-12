import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { checkSourceText, slideKey, sourceUnverified, suspiciousContent } from "@kj/generation";
import { isEmptyPage, MIN_PAGE_WORDS, normalizeRanges, pagesInRanges, rangesForChapters, sourceCut } from "@kj/pdf-structure";
import { checkOutline, OUTLINE_SOURCE_CHARS, outlineTiming, verifyNumbers } from "@kj/pedagogy";
import { LessonParams, LessonScope, newId, Outline, SlideContent, type ChapterNode, type PageRange, type PageText, type PageType, type Slide, type Unverified } from "@kj/schema";
import { withoutAnswers } from "@kj/templates";
import { db } from "./db/index.ts";
import { chapters, documents, lessons, outlineVersions, pages, shareLinks, slides } from "./db/schema.ts";
import { secret, type Env, type SessionUser } from "./env.ts";
import { HttpError } from "./http.ts";

export type LessonRow = typeof lessons.$inferSelect;
export type VersionRow = typeof outlineVersions.$inferSelect;
export type SlideRow = typeof slides.$inferSelect;

/**
 * Deleted (archived) documents are not found unless `archived` is set: reads of its pages for
 * lessons already made from it, editing those lessons' scope, and restore.
 */
export async function ownedDocument(env: Env, user: SessionUser, id: string, opts: { archived?: boolean } = {}) {
  const row = (await db(env).select().from(documents).where(and(eq(documents.id, id), eq(documents.orgId, user.orgId), eq(documents.ownerId, user.id))).limit(1))[0];
  if (!row || (row.archivedAt !== null && !opts.archived)) throw new HttpError(404, "NOT_FOUND", "Document not found · 找不到该文档");
  return row;
}

/** Archived lessons are not found unless `archived` is set (only restore asks for them). */
export async function ownedLesson(env: Env, user: SessionUser, id: string, opts: { archived?: boolean } = {}): Promise<LessonRow> {
  const row = (await db(env).select().from(lessons).where(and(eq(lessons.id, id), eq(lessons.orgId, user.orgId), eq(lessons.ownerId, user.id))).limit(1))[0];
  if (!row || (row.archivedAt !== null && !opts.archived)) throw new HttpError(404, "NOT_FOUND", "Lesson not found · 找不到该课");
  return row;
}

export const lessonParams = (l: LessonRow) => LessonParams.parse(JSON.parse(l.params));
export const lessonScope = (l: LessonRow) => LessonScope.parse(JSON.parse(l.scope));
/** A version's own snapshot: later changes to the lesson settings never affect it. */
export const versionParams = (v: VersionRow) => LessonParams.parse(JSON.parse(v.params));
export const versionScope = (v: VersionRow) => LessonScope.parse(JSON.parse(v.scope));

export async function versionOf(env: Env, lessonId: string, versionId: string): Promise<VersionRow> {
  const row = (await db(env).select().from(outlineVersions).where(and(eq(outlineVersions.id, versionId), eq(outlineVersions.lessonId, lessonId))).limit(1))[0];
  if (!row) throw new HttpError(404, "NOT_FOUND", "Outline version not found");
  return row;
}

export async function latestVersion(env: Env, lessonId: string): Promise<VersionRow | null> {
  return (await db(env).select().from(outlineVersions).where(eq(outlineVersions.lessonId, lessonId)).orderBy(desc(outlineVersions.version)).limit(1))[0] ?? null;
}

export async function latestConfirmed(env: Env, lessonId: string): Promise<VersionRow | null> {
  return (
    (await db(env).select().from(outlineVersions).where(and(eq(outlineVersions.lessonId, lessonId), isNotNull(outlineVersions.confirmedAt))).orderBy(desc(outlineVersions.version)).limit(1))[0] ?? null
  );
}

export const outlineOf = (v: VersionRow) => Outline.parse(JSON.parse(v.outline));

/** Generation gate (with the slides_require_confirmed_insert trigger): drafts never produce slides. */
export function confirmedOutline(v: VersionRow): Outline {
  if (v.confirmedAt === null) throw new HttpError(409, "OUTLINE_NOT_CONFIRMED", "Confirm the outline before generating slides · 请先确认大纲再生成");
  return outlineOf(v);
}

/** Text of the scope's pages that have any (pages without text never reach the model). */
export async function scopePages(env: Env, documentId: string, scope: LessonScope): Promise<PageText[]> {
  return pagesByNo(env, documentId, pagesInRanges(scope.ranges));
}

async function pagesByNo(env: Env, documentId: string, wanted: number[]): Promise<PageText[]> {
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

interface ScopeStats {
  /** Word count (for the "this needs about N minutes" estimate). */
  words: number;
  /** Pages without usable text (scanned images): never sent to the model. */
  emptyPages: number[];
  /** Pages with text beyond OUTLINE_SOURCE_CHARS: the outline planner cannot read them. */
  unreadPages: number[];
}

/** One query over the scope's page sizes; texts are not loaded (LENGTH() predicts the source cut). */
export async function scopeStats(env: Env, documentId: string, scope: LessonScope): Promise<ScopeStats> {
  const inRanges = or(...scope.ranges.map((r) => and(gte(pages.no, r.start), lte(pages.no, r.end))));
  const rows = await db(env)
    .select({ no: pages.no, words: pages.words, chars: sql<number>`LENGTH(${pages.text})` })
    .from(pages)
    .where(and(eq(pages.documentId, documentId), inRanges))
    .orderBy(asc(pages.no));
  const withText = rows.filter((r) => !isEmptyPage(r.words));
  return {
    words: rows.reduce((n, r) => n + r.words, 0),
    emptyPages: rows.filter((r) => isEmptyPage(r.words)).map((r) => r.no),
    unreadPages: sourceCut(withText, OUTLINE_SOURCE_CHARS).omitted,
  };
}

/** Printed page labels of a document (only pages whose label differs from the index). */
export async function pageLabels(env: Env, documentId: string): Promise<Record<number, string>> {
  const rows = await db(env)
    .select({ no: pages.no, label: pages.label })
    .from(pages)
    .where(and(eq(pages.documentId, documentId), isNotNull(pages.label)));
  return Object.fromEntries(rows.map((r) => [r.no, r.label!]));
}

export function slideFromRow(r: SlideRow): Slide {
  return {
    id: r.id,
    specId: r.specId,
    outlineVersionId: r.outlineVersionId,
    layout: r.layout,
    pageType: r.pageType as Slide["pageType"],
    minutes: r.minutes,
    content: SlideContent.parse(JSON.parse(r.content)),
    notes: r.notes,
    sources: JSON.parse(r.sources) as number[],
    warnings: JSON.parse(r.warnings) as string[],
    unverified: JSON.parse(r.unverified) as Unverified[],
    canUndo: r.prevContent !== null,
  };
}

/**
 * Re-runs the 待核实 check for edited content against the slide's cited pages (or the version's whole
 * selection); the outline's source-page flag for the slide stays until the outline itself is fixed.
 */
export async function unverifiedFor(env: Env, documentId: string, row: SlideRow, content: SlideContent, notes: string): Promise<Unverified[]> {
  const sources = JSON.parse(row.sources) as number[];
  const version = await versionOf(env, row.lessonId, row.outlineVersionId);
  const spec = outlineOf(version).slides.find((s) => s.id === row.specId);
  const list = sources.length ? await pagesByNo(env, documentId, sources) : await scopePages(env, documentId, versionScope(version));
  return [...(spec ? sourceUnverified(spec) : []), ...verifyNumbers(content, checkSourceText(sources, list), { pageType: row.pageType as PageType, notes })].slice(0, 10);
}

async function slideRowsOf(env: Env, version: VersionRow): Promise<SlideRow[]> {
  const rows = await db(env).select().from(slides).where(eq(slides.outlineVersionId, version.id));
  const order = new Map(outlineOf(version).slides.map((s, i) => [s.id, i]));
  return rows.filter((r) => order.has(r.specId)).sort((a, b) => order.get(a.specId)! - order.get(b.specId)!);
}

/** Slides of a version in outline order (missing specs are simply not generated yet). */
export async function slidesOf(env: Env, version: VersionRow): Promise<Slide[]> {
  return (await slideRowsOf(env, version)).map(slideFromRow);
}

/** Pages whose student-visible text has links, e-mails, downloads or instruction-like text. */
export function flaggedSlides(list: Slide[], outline: Outline) {
  const order = new Map(outline.slides.map((s, i) => [s.id, i]));
  return list.flatMap((s) => {
    const issues = suspiciousContent(studentSlide(s, "shown").content);
    return issues.length ? [{ page: (order.get(s.specId) ?? 0) + 1, title: "title" in s.content ? s.content.title : s.content.question, issues }] : [];
  });
}

/**
 * What a share link shows: flagged slides generated or edited after the teacher last shared (and
 * so reviewed) the deck are held back until the teacher shares again.
 */
export async function sharedSlides(env: Env, version: VersionRow, reviewedAt: number): Promise<{ slides: Slide[]; held: number[] }> {
  const rows = await slideRowsOf(env, version);
  const late = new Set(rows.filter((r) => r.updatedAt > reviewedAt).map((r) => r.id));
  const list = rows.map(slideFromRow);
  const held = new Set(
    flaggedSlides(
      list.filter((s) => late.has(s.id)),
      outlineOf(version),
    ).map((f) => f.page),
  );
  const order = new Map(outlineOf(version).slides.map((s, i) => [s.id, i + 1]));
  return { slides: list.filter((s) => !held.has(order.get(s.specId)!)), held: [...held] };
}

/**
 * Copies slides whose writer inputs (`slideKey`: spec plan, level, language) are unchanged from any earlier
 * version of the lesson into `version`, so confirming a revised outline keeps every untouched — or hand-edited — slide.
 */
export async function carryOverSlides(env: Env, version: VersionRow): Promise<void> {
  const params = versionParams(version);
  const specs = outlineOf(version).slides;
  const hashes = await Promise.all(specs.map((s) => slideKey(s, params)));
  const d = db(env);
  const existing = new Set((await d.select({ specId: slides.specId }).from(slides).where(eq(slides.outlineVersionId, version.id))).map((r) => r.specId));
  const candidates = await d
    .select()
    .from(slides)
    .where(and(eq(slides.lessonId, version.lessonId), inArray(slides.specHash, [...new Set(hashes)])))
    .orderBy(desc(slides.updatedAt));
  const byHash = new Map<string, SlideRow>();
  for (const r of candidates) if (!byHash.has(r.specHash)) byHash.set(r.specHash, r);
  const rows = specs.flatMap((spec, i) => {
    const src = byHash.get(hashes[i]!);
    if (!src || existing.has(spec.id)) return [];
    const unverified = [...sourceUnverified(spec), ...(JSON.parse(src.unverified) as Unverified[]).filter((u) => u.kind !== "source")].slice(0, 10);
    return [{ ...src, id: newId("sl"), outlineVersionId: version.id, specId: spec.id, unverified: JSON.stringify(unverified), prevContent: null, prevNotes: null, updatedAt: Date.now() }];
  });
  for (let i = 0; i < rows.length; i += 5) await d.insert(slides).values(rows.slice(i, i + 5));
}

/**
 * The version students get when a link is created: the newest confirmed version whose slides are
 * all generated, else the newest confirmed version with any slide.
 */
export async function shareableVersion(env: Env, lessonId: string): Promise<VersionRow | null> {
  const rows = await db(env)
    .select({ id: outlineVersions.id, specCount: outlineVersions.specCount, slides: sql<number>`(SELECT COUNT(*) FROM slides s WHERE s.outline_version_id = outline_versions.id)` })
    .from(outlineVersions)
    .where(and(eq(outlineVersions.lessonId, lessonId), isNotNull(outlineVersions.confirmedAt)))
    .orderBy(desc(outlineVersions.version));
  const pick = rows.find((r) => r.slides >= r.specCount) ?? rows.find((r) => r.slides > 0);
  return pick ? versionOf(env, lessonId, pick.id) : null;
}

/** Lesson list in one query: status and counts come from correlated subqueries, no outline JSON is parsed. */
export async function lessonList(env: Env, user: SessionUser) {
  const latest = sql`(SELECT v.confirmed_at IS NOT NULL FROM outline_versions v WHERE v.lesson_id = ${lessons.id} ORDER BY v.version DESC LIMIT 1)`;
  const confirmedId = sql`(SELECT v.id FROM outline_versions v WHERE v.lesson_id = ${lessons.id} AND v.confirmed_at IS NOT NULL ORDER BY v.version DESC LIMIT 1)`;
  const rows = await db(env)
    .select({
      id: lessons.id,
      title: lessons.title,
      updatedAt: lessons.updatedAt,
      params: lessons.params,
      scope: lessons.scope,
      latestConfirmed: sql<number | null>`${latest}`,
      planned: sql<number>`COALESCE((SELECT v.spec_count FROM outline_versions v WHERE v.id = ${confirmedId}), 0)`,
      slides: sql<number>`(SELECT COUNT(*) FROM slides s WHERE s.outline_version_id = ${confirmedId})`,
    })
    .from(lessons)
    .where(and(eq(lessons.orgId, user.orgId), eq(lessons.ownerId, user.id), isNull(lessons.archivedAt)))
    .orderBy(desc(lessons.updatedAt))
    .limit(100);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    updatedAt: r.updatedAt,
    params: LessonParams.parse(JSON.parse(r.params)),
    unit: LessonScope.parse(JSON.parse(r.scope)).unit ?? null,
    status: r.latestConfirmed === null ? "scoped" : r.slides ? "slides" : !r.latestConfirmed ? "outline" : "confirmed",
    slides: r.slides,
    planned: r.planned,
  }));
}

/** What students may see of a slide: no speaker notes, checks, 待核实 flags or misconception labels on quiz options. */
export type AnswerMode = "hidden" | "shown";

export function studentSlide({ canUndo: _u, ...s }: Slide, answers: AnswerMode) {
  const content =
    answers === "hidden" ? withoutAnswers(s.content) : s.content.layout === "quiz" ? { ...s.content, options: s.content.options.map((o) => ({ ...o, misconception: "" })) } : s.content;
  return { ...s, content, notes: "", warnings: [], unverified: [] };
}

/**
 * Export shape shared with the eval tooling (internal/eval/score.ts reads it). Student copies
 * (`includeNotes: false`) drop notes and checks, and with `answers: "hidden"` every revealed answer.
 */
export function deckExport(lesson: LessonRow, version: VersionRow, list: Slide[], extra: { includeNotes: boolean; answers?: AnswerMode; pageLabels: Record<number, string> }) {
  const answers: AnswerMode = extra.includeNotes ? "shown" : (extra.answers ?? "hidden");
  const params = versionParams(version);
  const scope = versionScope(version);
  return {
    lesson: {
      id: lesson.id,
      title: lesson.title,
      theme: lesson.theme,
      minutes: params.minutes,
      level: params.level,
      lessonType: params.lessonType,
      language: params.language,
      pageRanges: scope.ranges.map((r) => [r.start, r.end]),
      pageLabels: extra.pageLabels,
      answers,
    },
    meta: { outlineVersion: version.version, confirmedAt: version.confirmedAt },
    outline: outlineOf(version),
    slides: list.map((s) => (extra.includeNotes ? (({ canUndo: _u, ...rest }) => rest)(s) : studentSlide(s, answers))),
  };
}

export async function treeOf(env: Env, documentId: string): Promise<ChapterNode[]> {
  const rows = await db(env).select().from(chapters).where(eq(chapters.documentId, documentId)).orderBy(chapters.ord);
  return rows.map(({ documentId: _d, ...ch }) => ch);
}

/** `existing`: re-scoping a lesson that already uses the document, which works after the document is deleted. */
export async function scopeFor(env: Env, user: SessionUser, documentId: string, chapterIds: string[], ranges: PageRange[], existing = false): Promise<{ scope: LessonScope; title: string }> {
  const doc = await ownedDocument(env, user, documentId, { archived: existing });
  if (doc.pagesReceived < doc.pageCount) throw new HttpError(409, "DOCUMENT_INCOMPLETE", "The PDF is still uploading · PDF 还在上传");
  const tree = await treeOf(env, doc.id);
  const known = new Set(tree.map((c) => c.id));
  const ids = chapterIds.filter((id) => known.has(id));
  const fromChapters = ids.length ? rangesForChapters(tree, ids, doc.pageCount) : [];
  const merged = normalizeRanges([...fromChapters, ...ranges], doc.pageCount);
  if (!merged.length) throw new HttpError(400, "EMPTY_SCOPE", "Choose at least one chapter or page range · 请至少选择一个章节或页码范围");
  const picked = tree.filter((c) => ids.includes(c.id) && !(c.parentId && ids.includes(c.parentId)));
  const title = picked.length ? picked.map((c) => c.title).join(" · ") : `${doc.title} pp. ${merged.map((r) => `${r.start}–${r.end}`).join(", ")}`;
  return { scope: { chapterIds: ids, ranges: merged }, title: title.slice(0, 200) };
}

export function versionView(v: VersionRow) {
  const outline = outlineOf(v);
  const params = versionParams(v);
  return {
    id: v.id,
    version: v.version,
    outline,
    params,
    scope: versionScope(v),
    rev: v.rev,
    confirmedAt: v.confirmedAt,
    ackOverBudget: v.ackOverBudget,
    timing: outlineTiming(outline, params),
    warnings: checkOutline(outline, params),
  };
}

/** A draft holds this long at most: a request that dies mid-draft (closed tab, Worker limit) frees the lesson on its own. */
export const DRAFT_LOCK_MS = 150_000;

export async function activeShare(env: Env, lessonId: string) {
  return (await db(env).select().from(shareLinks).where(and(eq(shareLinks.lessonId, lessonId), isNull(shareLinks.revokedAt))).limit(1))[0] ?? null;
}

/** `held`: pages students do not see until the teacher shares again (flagged after the last review). */
export async function shareView(env: Env, lessonId: string) {
  const link = await activeShare(env, lessonId);
  if (!link?.versionId) return null;
  const v = await versionOf(env, lessonId, link.versionId);
  const { held } = await sharedSlides(env, v, link.reviewedAt);
  return { path: `/s/${await shareToken(env, link.id)}`, versionId: v.id, version: v.version, held, answers: link.answers };
}

/**
 * `confirmed` (newest confirmed version and its slides) is what step 5 presents and shares; `draft`
 * is a newer unconfirmed outline, if any. A draft never hides the generated deck.
 */
export async function lessonView(env: Env, lesson: LessonRow) {
  const scope = lessonScope(lesson);
  const [latest, confirmed, labels, stats, share] = await Promise.all([
    latestVersion(env, lesson.id),
    latestConfirmed(env, lesson.id),
    pageLabels(env, lesson.documentId),
    scopeStats(env, lesson.documentId, scope),
    shareView(env, lesson.id),
  ]);
  const drafting = lesson.draftingUntil !== null && lesson.draftingUntil > Date.now();
  return {
    lesson: {
      id: lesson.id,
      title: lesson.title,
      documentId: lesson.documentId,
      theme: lesson.theme,
      params: lessonParams(lesson),
      scope,
      scopeWords: stats.words,
      emptyPages: stats.emptyPages,
      unreadPages: stats.unreadPages,
      createdAt: lesson.createdAt,
      updatedAt: lesson.updatedAt,
    },
    draft: latest && latest.confirmedAt === null ? versionView(latest) : null,
    confirmed: confirmed ? versionView(confirmed) : null,
    slides: confirmed ? await slidesOf(env, confirmed) : [],
    pageLabels: labels,
    share,
    drafting: drafting ? { startedAt: lesson.draftingUntil! - DRAFT_LOCK_MS } : null,
  };
}

/**
 * A link's token is derived from its id (HMAC with the app secret), so sharing again can hand out
 * the same URL while the database only stores sha256(token).
 */
export async function shareToken(env: Env, linkId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret(env, "AI_CONFIG_KEY")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`kj-share-link:v1:${linkId}`)));
  let bin = "";
  for (const b of mac.slice(0, 24)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
