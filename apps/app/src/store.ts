import { z } from "zod";
import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { checkSourceText, slideKey, sourceUnverified, suspiciousContent } from "@kj/generation";
import { checkOutline, OUTLINE_SOURCE_CHARS, outlineTiming, verifyNumbers } from "@kj/pedagogy";
import {
  decodeSourcePage,
  LessonParams,
  LessonScope,
  LessonSource,
  newId,
  Outline,
  shortSourceTitle,
  SlideContent,
  SOURCE_STRIDE,
  type PageType,
  type PdfLessonSource,
  type Slide,
  type Unverified,
} from "@kj/schema";
import { seededRandom, withoutAnswers } from "@kj/templates";
import { db } from "./db/index.ts";
import { lessons, outlineVersions, shareLinks, slideLocks, slides } from "./db/schema.ts";
import { secret, type Env, type SessionUser } from "./env.ts";
import { HttpError } from "./http.ts";
import { multiLabelsFor, multiScopeStats, multiSlideSourcePages } from "./textbook/index.ts";

export type LessonRow = typeof lessons.$inferSelect;
export type VersionRow = typeof outlineVersions.$inferSelect;
export type SlideRow = typeof slides.$inferSelect;

/** Archived lessons are not found unless `archived` is set (only restore asks for them). */
export async function ownedLesson(env: Env, user: SessionUser, id: string, opts: { archived?: boolean } = {}): Promise<LessonRow> {
  const row = (await db(env).select().from(lessons).where(and(eq(lessons.id, id), eq(lessons.orgId, user.orgId), eq(lessons.ownerId, user.id))).limit(1))[0];
  if (!row || (row.archivedAt !== null && !opts.archived)) throw new HttpError(404, "NOT_FOUND", "Lesson not found · 找不到该课");
  return row;
}

export function parseLessonSources(raw: string | null | undefined): LessonSource[] {
  if (!raw) return [];
  try {
    const parsed = z.array(LessonSource).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export const lessonSources = (l: Pick<LessonRow, "sourcesJson">) => parseLessonSources(l.sourcesJson);

/** Lessons (not deleted) made from a textbook (either primary document_id or secondary PDF in sources_json). */
export async function lessonsUsing(env: Env, documentId: string): Promise<number> {
  return (await lessonCountsByDocument(env, [documentId]))[documentId]?.live ?? 0;
}

/** Lessons made from each textbook: `live` leaves out archived lessons; `all` counts every lesson still pointing at it (including secondary PDFs in sources_json). */
export async function lessonCountsByDocument(env: Env, documentIds: string[]): Promise<Record<string, { live: number; all: number }>> {
  const out: Record<string, { live: number; all: number }> = {};
  for (const id of documentIds) out[id] = { live: 0, all: 0 };
  if (!documentIds.length) return out;
  const wanted = new Set(documentIds);
  const allSets = new Map<string, Set<string>>(documentIds.map((id) => [id, new Set<string>()]));
  const liveSets = new Map<string, Set<string>>(documentIds.map((id) => [id, new Set<string>()]));

  const primaryRows = await db(env)
    .select({ lessonId: lessons.id, documentId: lessons.documentId, archivedAt: lessons.archivedAt })
    .from(lessons)
    .where(inArray(lessons.documentId, documentIds));
  for (const r of primaryRows) {
    allSets.get(r.documentId)?.add(r.lessonId);
    if (r.archivedAt === null) liveSets.get(r.documentId)?.add(r.lessonId);
  }

  const multiRows = await db(env)
    .select({ lessonId: lessons.id, sourcesJson: lessons.sourcesJson, archivedAt: lessons.archivedAt })
    .from(lessons)
    .where(isNotNull(lessons.sourcesJson));
  for (const r of multiRows) {
    for (const s of parseLessonSources(r.sourcesJson)) {
      if (s.kind !== "pdf" || !wanted.has(s.documentId)) continue;
      allSets.get(s.documentId)?.add(r.lessonId);
      if (r.archivedAt === null) liveSets.get(s.documentId)?.add(r.lessonId);
    }
  }

  for (const id of documentIds) {
    out[id] = { live: liveSets.get(id)?.size ?? 0, all: allSets.get(id)?.size ?? 0 };
  }
  return out;
}

export const lessonParams = (l: LessonRow) => LessonParams.parse(JSON.parse(l.params));
export const lessonScope = (l: LessonRow) => LessonScope.parse(JSON.parse(l.scope));
/** A version's own snapshot: later changes to the lesson settings never affect it. */
export const versionParams = (v: VersionRow) => LessonParams.parse(JSON.parse(v.params));
export const versionScope = (v: VersionRow) => LessonScope.parse(JSON.parse(v.scope));

export function effectiveSourcesForVersion(lesson: Pick<LessonRow, "sourcesJson">, version?: VersionRow | null): LessonSource[] {
  if (version) {
    const vScope = versionScope(version);
    if (vScope.sources?.length) return vScope.sources;
  }
  return lessonSources(lesson);
}

export function pdfSourcesOf(
  sources: LessonSource[],
  fallbackDocumentId: string,
  fallbackScope: Pick<LessonScope, "chapterIds" | "ranges">,
): PdfLessonSource[] {
  const pdfs = sources.filter((s): s is PdfLessonSource => s.kind === "pdf");
  if (pdfs.length > 0) return pdfs;
  return [
    {
      id: "src_primary",
      kind: "pdf",
      documentId: fallbackDocumentId,
      title: "",
      chapterIds: fallbackScope.chapterIds,
      ranges: fallbackScope.ranges,
      role: "textbook",
    },
  ];
}

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
 * selection across all attached PDF sources); the outline's source-page flag for the slide stays until the outline itself is fixed.
 */
export async function unverifiedFor(env: Env, documentId: string, row: SlideRow, content: SlideContent, notes: string): Promise<Unverified[]> {
  const sources = JSON.parse(row.sources) as number[];
  const [version, lessonRow] = await Promise.all([
    versionOf(env, row.lessonId, row.outlineVersionId),
    db(env).select({ sourcesJson: lessons.sourcesJson }).from(lessons).where(eq(lessons.id, row.lessonId)).limit(1),
  ]);
  const vScope = versionScope(version);
  const pdfSources = pdfSourcesOf(effectiveSourcesForVersion(lessonRow[0] ?? { sourcesJson: null }, version), documentId, vScope);
  const spec = outlineOf(version).slides.find((s) => s.id === row.specId);
  const list = await multiSlideSourcePages(env, pdfSources, sources);
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
  await d.delete(slideLocks).where(lt(slideLocks.until, Date.now()));
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
    answers === "hidden"
      ? withoutAnswers(s.content, seededRandom(`${s.outlineVersionId}\0${s.specId}`), s.pageType)
      : s.content.layout === "quiz"
        ? { ...s.content, options: s.content.options.map((o) => ({ ...o, misconception: "" })) }
        : s.content;
  return { ...s, content, notes: "", warnings: [], unverified: [] };
}

/** Pages the slides cite: the only printed labels a deck needs. */
export function citedPages(list: Pick<Slide, "sources">[]): number[] {
  return [...new Set(list.flatMap((s) => s.sources))];
}

/**
 * Export shape shared with the eval tooling (internal/eval/score.ts reads it). Student copies
 * (`includeNotes: false`) drop notes and checks, and with `answers: "hidden"` every revealed answer.
 */
export function deckExport(lesson: LessonRow, version: VersionRow, list: Slide[], extra: { includeNotes: boolean; answers?: AnswerMode; pageLabels: Record<number, string> }) {
  const answers: AnswerMode = extra.includeNotes ? "shown" : (extra.answers ?? "hidden");
  const params = versionParams(version);
  const scope = versionScope(version);
  const pdfSources = pdfSourcesOf(effectiveSourcesForVersion(lesson, version), lesson.documentId, scope);
  const pageLabels: Record<number, string> = { ...extra.pageLabels };
  if (pdfSources.length > 1) {
    for (const v of citedPages(list)) {
      if (v <= SOURCE_STRIDE || pageLabels[v]) continue;
      const { pdfIndex, pageNo } = decodeSourcePage(v);
      const src = pdfSources[pdfIndex];
      if (src) pageLabels[v] = `${shortSourceTitle(src.title)} p.${pageNo}`;
    }
  }
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
      pageLabels,
      answers,
    },
    meta: { outlineVersion: version.version, confirmedAt: version.confirmedAt },
    outline: outlineOf(version),
    slides: list.map((s) => (extra.includeNotes ? (({ canUndo: _u, ...rest }) => rest)(s) : studentSlide(s, answers))),
  };
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

/** Acquires a per-slide generation lock and opportunistically sweeps expired locks across all lessons. */
export async function acquireSlideLock(env: Env, outlineVersionId: string, specId: string, now = Date.now()): Promise<boolean> {
  const d = db(env);
  await d.delete(slideLocks).where(lt(slideLocks.until, now));
  const locked = await d
    .insert(slideLocks)
    .values({ outlineVersionId, specId, until: now + DRAFT_LOCK_MS })
    .onConflictDoUpdate({ target: [slideLocks.outlineVersionId, slideLocks.specId], set: { until: now + DRAFT_LOCK_MS }, setWhere: lt(slideLocks.until, now) })
    .returning({ until: slideLocks.until });
  return locked.length > 0;
}

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
  const sources = lessonSources(lesson);
  const pdfSources = pdfSourcesOf(sources, lesson.documentId, scope);
  const [latest, confirmed, stats, share] = await Promise.all([
    latestVersion(env, lesson.id),
    latestConfirmed(env, lesson.id),
    multiScopeStats(env, pdfSources, { sourceBudget: OUTLINE_SOURCE_CHARS }),
    shareView(env, lesson.id),
  ]);
  const deck = confirmed ? await slidesOf(env, confirmed) : [];
  const outlinePages = [latest, confirmed].flatMap((v) => (v ? outlineOf(v).slides.flatMap((s) => s.sourcePages) : []));
  const labels = await multiLabelsFor(env, pdfSources, [...citedPages(deck), ...outlinePages]);
  const drafting = lesson.draftingUntil !== null && lesson.draftingUntil > Date.now();
  return {
    lesson: {
      id: lesson.id,
      title: lesson.title,
      documentId: lesson.documentId,
      theme: lesson.theme,
      params: lessonParams(lesson),
      scope,
      sources,
      scopeWords: stats.words,
      emptyPages: stats.emptyPages,
      unreadPages: stats.unreadPages,
      createdAt: lesson.createdAt,
      updatedAt: lesson.updatedAt,
    },
    draft: latest && latest.confirmedAt === null ? versionView(latest) : null,
    confirmed: confirmed ? versionView(confirmed) : null,
    slides: deck,
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
