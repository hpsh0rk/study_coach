import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { pagesInRanges } from "@kj/pdf-structure";
import { LessonParams, LessonScope, Outline, SlideContent, type ConfirmedOutline, type PageText, type Slide } from "@kj/schema";
import { db } from "./auth/session.ts";
import { documents, lessons, outlineVersions, pages, slides } from "./db/schema.ts";
import type { Env, SessionUser } from "./env.ts";
import { HttpError } from "./http.ts";

export type LessonRow = typeof lessons.$inferSelect;
export type VersionRow = typeof outlineVersions.$inferSelect;

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

export async function versionOf(env: Env, lessonId: string, versionId: string): Promise<VersionRow> {
  const row = (await db(env).select().from(outlineVersions).where(and(eq(outlineVersions.id, versionId), eq(outlineVersions.lessonId, lessonId))).limit(1))[0];
  if (!row) throw new HttpError(404, "NOT_FOUND", "Outline version not found");
  return row;
}

export async function latestVersion(env: Env, lessonId: string): Promise<VersionRow | null> {
  return (await db(env).select().from(outlineVersions).where(eq(outlineVersions.lessonId, lessonId)).orderBy(desc(outlineVersions.version)).limit(1))[0] ?? null;
}

export async function latestConfirmed(env: Env, lessonId: string): Promise<VersionRow | null> {
  const rows = await db(env).select().from(outlineVersions).where(eq(outlineVersions.lessonId, lessonId)).orderBy(desc(outlineVersions.version));
  return rows.find((r) => r.confirmedAt !== null) ?? null;
}

export const outlineOf = (v: VersionRow) => Outline.parse(JSON.parse(v.outline));

/** The only constructor of ConfirmedOutline: generation code cannot get one for a draft. */
export function confirmedOutline(v: VersionRow): ConfirmedOutline {
  if (v.confirmedAt === null) throw new HttpError(409, "OUTLINE_NOT_CONFIRMED", "Confirm the outline before generating slides · 请先确认大纲再生成");
  return { versionId: v.id, lessonId: v.lessonId, outline: outlineOf(v), confirmedAt: v.confirmedAt } as ConfirmedOutline;
}

export async function scopePages(env: Env, lesson: LessonRow): Promise<PageText[]> {
  const wanted = pagesInRanges(lessonScope(lesson).ranges);
  const out: PageText[] = [];
  for (let i = 0; i < wanted.length; i += 90) {
    const chunk = wanted.slice(i, i + 90);
    const rows = await db(env)
      .select({ no: pages.no, text: pages.text })
      .from(pages)
      .where(and(eq(pages.documentId, lesson.documentId), inArray(pages.no, chunk)))
      .orderBy(asc(pages.no));
    out.push(...rows);
  }
  return out;
}

export function slideFromRow(r: typeof slides.$inferSelect): Slide {
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
  };
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

/** Export shape shared with the eval tooling (internal/eval/score.ts reads it). */
export function deckExport(lesson: LessonRow, version: VersionRow, list: Slide[], extra: { includeNotes: boolean }) {
  const params = lessonParams(lesson);
  const scope = lessonScope(lesson);
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
    },
    meta: { outlineVersion: version.version, confirmedAt: version.confirmedAt },
    outline: outlineOf(version),
    slides: list.map((s) => (extra.includeNotes ? s : { ...s, notes: "" })),
  };
}
