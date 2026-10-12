import { and, asc, desc, eq, gte, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { pagesInRanges } from "@kj/pdf-structure";
import { checkSourceText } from "@kj/generation";
import { verifyNumbers } from "@kj/pedagogy";
import { LessonParams, LessonScope, newId, Outline, sha256Hex, SlideContent, type PageText, type PageType, type Slide, type SlideSpec, type Unverified } from "@kj/schema";
import { db } from "./auth/session.ts";
import { documents, lessons, outlineVersions, pages, slides } from "./db/schema.ts";
import type { Env, SessionUser } from "./env.ts";
import { HttpError } from "./http.ts";

export type LessonRow = typeof lessons.$inferSelect;
export type VersionRow = typeof outlineVersions.$inferSelect;
export type SlideRow = typeof slides.$inferSelect;

export async function ownedDocument(env: Env, user: SessionUser, id: string) {
  const row = (await db(env).select().from(documents).where(and(eq(documents.id, id), eq(documents.orgId, user.orgId), eq(documents.ownerId, user.id))).limit(1))[0];
  if (!row) throw new HttpError(404, "NOT_FOUND", "Document not found · 找不到该文档");
  return row;
}

export async function ownedLesson(env: Env, user: SessionUser, id: string): Promise<LessonRow> {
  const row = (await db(env).select().from(lessons).where(and(eq(lessons.id, id), eq(lessons.orgId, user.orgId), eq(lessons.ownerId, user.id))).limit(1))[0];
  if (!row) throw new HttpError(404, "NOT_FOUND", "Lesson not found · 找不到该课");
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

export async function scopePages(env: Env, documentId: string, scope: LessonScope): Promise<PageText[]> {
  return pagesByNo(env, documentId, pagesInRanges(scope.ranges));
}

export async function pagesByNo(env: Env, documentId: string, wanted: number[]): Promise<PageText[]> {
  const out: PageText[] = [];
  for (let i = 0; i < wanted.length; i += 90) {
    const chunk = wanted.slice(i, i + 90);
    const rows = await db(env)
      .select({ no: pages.no, text: pages.text, label: pages.label })
      .from(pages)
      .where(and(eq(pages.documentId, documentId), inArray(pages.no, chunk)))
      .orderBy(asc(pages.no));
    out.push(...rows.map((r) => ({ no: r.no, text: r.text, ...(r.label ? { label: r.label } : {}) })));
  }
  return out;
}

/** Word count of a scope (for the "this needs about N minutes" estimate). */
export async function scopeWords(env: Env, documentId: string, scope: LessonScope): Promise<number> {
  const inRanges = or(...scope.ranges.map((r) => and(gte(pages.no, r.start), lte(pages.no, r.end))));
  const row = await db(env)
    .select({ n: sql<number>`COALESCE(SUM(${pages.words}), 0)` })
    .from(pages)
    .where(and(eq(pages.documentId, documentId), inRanges));
  return row[0]?.n ?? 0;
}

/** Printed page labels of a document (only pages whose label differs from the index). */
export async function pageLabels(env: Env, documentId: string): Promise<Record<number, string>> {
  const rows = await db(env)
    .select({ no: pages.no, label: pages.label })
    .from(pages)
    .where(and(eq(pages.documentId, documentId), isNotNull(pages.label)));
  return Object.fromEntries(rows.map((r) => [r.no, r.label!]));
}

export async function specHash(spec: SlideSpec, params: LessonParams): Promise<string> {
  const { id: _id, ...rest } = spec;
  return sha256Hex(JSON.stringify({ spec: rest, params }));
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

/** Re-runs the 待核实 check for edited content against the slide's cited pages (or the version's whole selection). */
export async function unverifiedFor(env: Env, documentId: string, row: SlideRow, content: SlideContent, notes: string): Promise<Unverified[]> {
  const sources = JSON.parse(row.sources) as number[];
  const list = sources.length
    ? await pagesByNo(env, documentId, sources)
    : await scopePages(env, documentId, versionScope(await versionOf(env, row.lessonId, row.outlineVersionId)));
  return verifyNumbers(content, checkSourceText(sources, list), { pageType: row.pageType as PageType, notes });
}

/** Slides of a version in outline order (missing specs are simply not generated yet). */
export async function slidesOf(env: Env, version: VersionRow): Promise<Slide[]> {
  const rows = await db(env).select().from(slides).where(eq(slides.outlineVersionId, version.id));
  const order = new Map(outlineOf(version).slides.map((s, i) => [s.id, i]));
  return rows
    .filter((r) => order.has(r.specId))
    .sort((a, b) => order.get(a.specId)! - order.get(b.specId)!)
    .map(slideFromRow);
}

/**
 * Copies slides whose spec (and params) are unchanged from any earlier version of the lesson into
 * `version`, so confirming a revised outline keeps every untouched — or hand-edited — slide.
 */
export async function carryOverSlides(env: Env, version: VersionRow): Promise<void> {
  const params = versionParams(version);
  const specs = outlineOf(version).slides;
  const hashes = await Promise.all(specs.map((s) => specHash(s, params)));
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
    return [{ ...src, id: newId("sl"), outlineVersionId: version.id, specId: spec.id, prevContent: null, prevNotes: null, updatedAt: Date.now() }];
  });
  for (let i = 0; i < rows.length; i += 5) await d.insert(slides).values(rows.slice(i, i + 5));
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
      latestConfirmed: sql<number | null>`${latest}`,
      planned: sql<number>`COALESCE((SELECT v.spec_count FROM outline_versions v WHERE v.id = ${confirmedId}), 0)`,
      slides: sql<number>`(SELECT COUNT(*) FROM slides s WHERE s.outline_version_id = ${confirmedId})`,
    })
    .from(lessons)
    .where(and(eq(lessons.orgId, user.orgId), eq(lessons.ownerId, user.id)))
    .orderBy(desc(lessons.updatedAt))
    .limit(100);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    updatedAt: r.updatedAt,
    params: LessonParams.parse(JSON.parse(r.params)),
    status: r.latestConfirmed === null ? "scoped" : !r.latestConfirmed ? "outline" : r.slides ? "slides" : "confirmed",
    slides: r.slides,
    planned: r.planned,
  }));
}

/** Export shape shared with the eval tooling (internal/eval/score.ts reads it). */
export function deckExport(lesson: LessonRow, version: VersionRow, list: Slide[], extra: { includeNotes: boolean; pageLabels: Record<number, string> }) {
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
    },
    meta: { outlineVersion: version.version, confirmedAt: version.confirmedAt },
    outline: outlineOf(version),
    slides: list.map(({ canUndo: _u, ...s }) => (extra.includeNotes ? s : { ...s, notes: "", unverified: [] })),
  };
}
