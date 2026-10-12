import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { checkSourcePages, draftOutline, problemsOf, slideKey, SpecNotFoundError, workedSpecFor, writeSlide, type PlannerSection } from "@kj/generation";
import { normalizeRanges, rangesForChapters } from "@kj/pdf-structure";
import { checkOutline, outlineTiming } from "@kj/pedagogy";
import { DEFAULT_PARAMS, LessonParams, newId, Outline, PageRange, randomToken, sha256Hex, SlideContent, ThemeId, type ChapterNode, type LessonScope } from "@kj/schema";
import { layoutForPageType, SLOT_SCHEMAS } from "@kj/templates";
import { describeIssue, slotIssues, widgetIssues } from "@kj/templates/issues";
import { makeAi } from "../ai.ts";
import { chapters, lessons, outlineVersions, shareLinks, slides } from "../db/schema.ts";
import type { AppBindings, Env, SessionUser } from "../env.ts";
import { HttpError, parseJson } from "../http.ts";
import { db, requireUser } from "../auth/session.ts";
import {
  carryOverSlides,
  confirmedOutline,
  deckExport,
  latestConfirmed,
  latestVersion,
  lessonList,
  lessonParams,
  lessonScope,
  outlineOf,
  ownedDocument,
  ownedLesson,
  pageLabels,
  scopePages,
  scopeWords,
  slideFromRow,
  unverifiedFor,
  slidesOf,
  versionOf,
  versionParams,
  versionScope,
  type LessonRow,
  type SlideRow,
  type VersionRow,
} from "../store.ts";

async function treeOf(env: Env, documentId: string): Promise<ChapterNode[]> {
  const rows = await db(env).select().from(chapters).where(eq(chapters.documentId, documentId)).orderBy(chapters.ord);
  return rows.map(({ documentId: _d, ...ch }) => ch);
}

async function scopeFor(env: Env, user: SessionUser, documentId: string, chapterIds: string[], ranges: PageRange[]): Promise<{ scope: LessonScope; title: string }> {
  const doc = await ownedDocument(env, user, documentId);
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

/** Deepest selected chapters in reading order become the planner's sections. */
function sectionsOf(tree: ChapterNode[], scope: LessonScope): PlannerSection[] {
  const ids = new Set(scope.chapterIds);
  const leaves = tree.filter((c) => ids.has(c.id) && !tree.some((k) => k.parentId === c.id && ids.has(k.id)));
  return leaves.map((c) => ({ title: c.title, pageStart: c.pageStart, pageEnd: c.pageEnd }));
}

function versionView(v: VersionRow) {
  const outline = outlineOf(v);
  const params = versionParams(v);
  return {
    id: v.id,
    version: v.version,
    outline,
    params,
    scope: versionScope(v),
    confirmedAt: v.confirmedAt,
    ackOverBudget: v.ackOverBudget,
    timing: outlineTiming(outline, params),
    warnings: checkOutline(outline, params),
  };
}

/** Teacher edits may change page types; layouts always follow the page type, ids stay unique. */
function normalizeEdited(outline: Outline): Outline {
  const seen = new Set<string>();
  return Outline.parse({
    ...outline,
    slides: outline.slides.map((s) => {
      let id = s.id;
      if (seen.has(id)) id = newId("sp", 8);
      seen.add(id);
      return { ...s, id, layout: layoutForPageType(s.pageType) };
    }),
  });
}

/**
 * Source-page flags on a teacher's edit: slides whose pages changed are checked afresh against the version's
 * selection; on unchanged pages the teacher may clear a flag ("页码没问题") but never set one.
 */
async function recheckSources(env: Env, lesson: LessonRow, v: VersionRow, outline: Outline): Promise<Outline> {
  const before = new Map(outlineOf(v).slides.map((s) => [s.id, s]));
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((p, i) => p === b[i]);
  const changed = outline.slides.some((s) => !before.has(s.id) || !same(before.get(s.id)!.sourcePages, s.sourcePages));
  const pageTexts = changed ? await scopePages(env, lesson.documentId, versionScope(v)) : [];
  const checked = changed ? checkSourcePages(outline.slides.map((s) => ({ ...s, sourceIssue: undefined })), pageTexts.map((p) => p.no), pageTexts) : outline.slides;
  return {
    ...outline,
    slides: outline.slides.map((s, i) => {
      const old = before.get(s.id);
      if (old && same(old.sourcePages, s.sourcePages)) return { ...s, sourceIssue: s.sourceIssue && old.sourceIssue };
      return checked[i]!;
    }),
  };
}

function immutableGuard(err: unknown): never {
  if (err instanceof Error && /OUTLINE_VERSION_IMMUTABLE/.test(`${err.message} ${(err as { cause?: Error }).cause?.message ?? ""}`)) {
    throw new HttpError(409, "OUTLINE_VERSION_IMMUTABLE", "A confirmed outline cannot be changed; start a new version · 已确认的大纲不能修改，请新建版本");
  }
  throw err;
}

/** `snapshot` defaults to the lesson's current settings; a revision copies its source version's snapshot instead. */
async function insertVersion(env: Env, lesson: LessonRow, outline: Outline, snapshot: { params: string; scope: string } = lesson): Promise<VersionRow> {
  const prev = await latestVersion(env, lesson.id);
  const id = newId("ov");
  const totalMinutes = outline.slides.reduce((n, s) => n + s.minutes, 0);
  await db(env)
    .insert(outlineVersions)
    .values({ id, lessonId: lesson.id, version: (prev?.version ?? 0) + 1, outline: JSON.stringify(outline), params: snapshot.params, scope: snapshot.scope, specCount: outline.slides.length, totalMinutes });
  return versionOf(env, lesson.id, id);
}

async function lessonView(env: Env, lesson: LessonRow) {
  const scope = lessonScope(lesson);
  const [latest, confirmed, labels, words] = await Promise.all([latestVersion(env, lesson.id), latestConfirmed(env, lesson.id), pageLabels(env, lesson.documentId), scopeWords(env, lesson.documentId, scope)]);
  const share = (await db(env).select({ id: shareLinks.id }).from(shareLinks).where(and(eq(shareLinks.lessonId, lesson.id), isNull(shareLinks.revokedAt))).limit(1))[0];
  return {
    lesson: { id: lesson.id, title: lesson.title, documentId: lesson.documentId, theme: lesson.theme, params: lessonParams(lesson), scope, scopeWords: words, createdAt: lesson.createdAt, updatedAt: lesson.updatedAt },
    version: latest ? versionView(latest) : null,
    confirmedVersionId: confirmed?.id ?? null,
    slides: confirmed ? await slidesOf(env, confirmed) : [],
    pageLabels: labels,
    shared: !!share,
  };
}

async function ownedSlide(env: Env, lessonId: string, slideId: string): Promise<SlideRow> {
  const row = (await db(env).select().from(slides).where(and(eq(slides.id, slideId), eq(slides.lessonId, lessonId))).limit(1))[0];
  if (!row) throw new HttpError(404, "NOT_FOUND", "Slide not found");
  return row;
}

export const lessonRoutes = new Hono<AppBindings>()
  .use(requireUser())
  .get("/", async (c) => c.json({ lessons: await lessonList(c.env, c.get("user")) }))
  .post("/", async (c) => {
    const body = await parseJson(c, z.object({ documentId: z.string(), chapterIds: z.array(z.string()).max(200).default([]), ranges: z.array(PageRange).max(50).default([]), title: z.string().trim().max(200).optional() }));
    const u = c.get("user");
    const { scope, title } = await scopeFor(c.env, u, body.documentId, body.chapterIds, body.ranges);
    const id = newId("les");
    await db(c.env)
      .insert(lessons)
      .values({ id, orgId: u.orgId, ownerId: u.id, documentId: body.documentId, title: body.title || title, scope: JSON.stringify(scope), params: JSON.stringify(DEFAULT_PARAMS) });
    return c.json(await lessonView(c.env, await ownedLesson(c.env, u, id)), 201);
  })
  .get("/:id", async (c) => c.json(await lessonView(c.env, await ownedLesson(c.env, c.get("user"), c.req.param("id")))))
  .patch("/:id", async (c) => {
    const body = await parseJson(
      c,
      z.object({ title: z.string().trim().min(1).max(200).optional(), params: LessonParams.optional(), theme: ThemeId.optional(), chapterIds: z.array(z.string()).max(200).optional(), ranges: z.array(PageRange).max(50).optional() }),
    );
    const u = c.get("user");
    const lesson = await ownedLesson(c.env, u, c.req.param("id"));
    const patch: Partial<typeof lessons.$inferInsert> = { updatedAt: Date.now() };
    if (body.title) patch.title = body.title;
    if (body.params) patch.params = JSON.stringify(body.params);
    if (body.theme) patch.theme = body.theme;
    if (body.chapterIds || body.ranges) {
      const { scope, title } = await scopeFor(c.env, u, lesson.documentId, body.chapterIds ?? [], body.ranges ?? []);
      patch.scope = JSON.stringify(scope);
      if (!body.title) patch.title = title;
    }
    await db(c.env).update(lessons).set(patch).where(eq(lessons.id, lesson.id));
    return c.json(await lessonView(c.env, await ownedLesson(c.env, u, lesson.id)));
  })

  // ---- outline: draft → (edit) → confirm. Only a confirmed version can produce slides. ----
  .post("/:id/outline", async (c) => {
    const u = c.get("user");
    const lesson = await ownedLesson(c.env, u, c.req.param("id"));
    const scope = lessonScope(lesson);
    const [pageTexts, tree] = await Promise.all([scopePages(c.env, lesson.documentId, scope), treeOf(c.env, lesson.documentId)]);
    const res = await draftOutline(makeAi(c.env, u.orgId), {
      lessonTitle: lesson.title,
      params: lessonParams(lesson),
      sections: sectionsOf(tree, scope),
      pages: pageTexts,
      ctx: { orgId: u.orgId, userId: u.id, lessonId: lesson.id },
    });
    const v = await insertVersion(c.env, lesson, res.outline);
    await db(c.env).update(lessons).set({ updatedAt: Date.now() }).where(eq(lessons.id, lesson.id));
    return c.json({ version: versionView(v), providerId: res.providerId }, 201);
  })
  .put("/:id/outline-versions/:vid", async (c) => {
    const lesson = await ownedLesson(c.env, c.get("user"), c.req.param("id"));
    const v = await versionOf(c.env, lesson.id, c.req.param("vid"));
    const body = await parseJson(c, z.object({ outline: Outline }));
    if (v.confirmedAt !== null) immutableGuard(new Error("OUTLINE_VERSION_IMMUTABLE"));
    const outline = await recheckSources(c.env, lesson, v, normalizeEdited(body.outline));
    await db(c.env)
      .update(outlineVersions)
      .set({ outline: JSON.stringify(outline), specCount: outline.slides.length, totalMinutes: outline.slides.reduce((n, s) => n + s.minutes, 0) })
      .where(eq(outlineVersions.id, v.id))
      .catch(immutableGuard);
    return c.json({ version: versionView(await versionOf(c.env, lesson.id, v.id)) });
  })
  .post("/:id/outline-versions/:vid/confirm", async (c) => {
    const lesson = await ownedLesson(c.env, c.get("user"), c.req.param("id"));
    const v = await versionOf(c.env, lesson.id, c.req.param("vid"));
    const body = await parseJson(c, z.object({ ackOverBudget: z.boolean().default(false) }));
    if (v.confirmedAt !== null) return c.json({ version: versionView(v) });
    const params = versionParams(v);
    const timing = outlineTiming(outlineOf(v), params);
    if (timing.needsAck && !body.ackOverBudget) {
      throw new HttpError(409, "OVER_BUDGET_ACK_REQUIRED", `Outline is ${timing.totalMinutes} min for a ${params.minutes}-min lesson (beyond ±15%); confirm again to accept · 大纲时长超出 ±15%，请再次确认`, timing);
    }
    await db(c.env).update(outlineVersions).set({ confirmedAt: Date.now(), ackOverBudget: timing.needsAck }).where(eq(outlineVersions.id, v.id)).catch(immutableGuard);
    const confirmed = await versionOf(c.env, lesson.id, v.id);
    await carryOverSlides(c.env, confirmed);
    return c.json({ version: versionView(confirmed), slides: await slidesOf(c.env, confirmed) });
  })
  .post("/:id/outline-versions/:vid/revise", async (c) => {
    const lesson = await ownedLesson(c.env, c.get("user"), c.req.param("id"));
    const v = await versionOf(c.env, lesson.id, c.req.param("vid"));
    const next = await insertVersion(c.env, lesson, outlineOf(v), v);
    return c.json({ version: versionView(next) }, 201);
  })
  /**
   * Idempotent: returns the existing slide, else reuses an identical spec's slide from another
   * version, else calls the model. `regenerate: true` always calls the model and keeps the old
   * content for one level of undo.
   */
  .post("/:id/outline-versions/:vid/slides/:specId/generate", async (c) => {
    const u = c.get("user");
    const lesson = await ownedLesson(c.env, u, c.req.param("id"));
    const v = await versionOf(c.env, lesson.id, c.req.param("vid"));
    const outline = confirmedOutline(v);
    const body = await parseJson(c, z.object({ regenerate: z.boolean().default(false) }).default({ regenerate: false }));
    const specId = c.req.param("specId");
    const spec = outline.slides.find((s) => s.id === specId);
    if (!spec) throw new HttpError(404, "NOT_FOUND", new SpecNotFoundError(specId).message);
    const d = db(c.env);
    const existing = (await d.select().from(slides).where(and(eq(slides.outlineVersionId, v.id), eq(slides.specId, specId))).limit(1))[0];
    if (existing && !body.regenerate) return c.json({ slide: slideFromRow(existing), reused: true });
    if (!existing) {
      await carryOverSlides(c.env, v);
      const carried = (await d.select().from(slides).where(and(eq(slides.outlineVersionId, v.id), eq(slides.specId, specId))).limit(1))[0];
      if (carried && !body.regenerate) return c.json({ slide: slideFromRow(carried), reused: true });
    }
    const params = versionParams(v);
    const worked = workedSpecFor(outline, specId);
    const workedRow = worked ? (await d.select({ content: slides.content }).from(slides).where(and(eq(slides.outlineVersionId, v.id), eq(slides.specId, worked))).limit(1))[0] : undefined;
    const workedContent = workedRow ? SlideContent.parse(JSON.parse(workedRow.content)) : undefined;
    const res = await writeSlide(makeAi(c.env, u.orgId), outline, specId, {
      lessonTitle: lesson.title,
      params,
      pages: await scopePages(c.env, lesson.documentId, versionScope(v)),
      workedProblem: workedContent?.layout === "steps" ? workedContent.problem : undefined,
      ctx: { orgId: u.orgId, userId: u.id, lessonId: lesson.id },
    });
    const current = (await d.select().from(slides).where(and(eq(slides.outlineVersionId, v.id), eq(slides.specId, specId))).limit(1))[0];
    const row = {
      id: newId("sl"),
      lessonId: lesson.id,
      outlineVersionId: v.id,
      specId,
      specHash: await slideKey(spec, params),
      layout: spec.layout,
      pageType: spec.pageType,
      minutes: spec.minutes,
      content: JSON.stringify(res.content),
      notes: res.notes,
      sources: JSON.stringify(res.sources),
      warnings: JSON.stringify(res.warnings),
      unverified: JSON.stringify(res.unverified),
      providerId: res.providerId,
      prevContent: current?.content ?? null,
      prevNotes: current?.notes ?? null,
      updatedAt: Date.now(),
    };
    const { id: _id, ...update } = row;
    await d.insert(slides).values(row).onConflictDoUpdate({ target: [slides.outlineVersionId, slides.specId], set: update });
    const saved = (await d.select().from(slides).where(and(eq(slides.outlineVersionId, v.id), eq(slides.specId, specId))).limit(1))[0]!;
    return c.json({ slide: slideFromRow(saved), reused: false });
  })
  /** Slot-form edit: content must match the slide's layout and hard budgets; the old content is kept for undo. */
  .patch("/:id/slides/:slideId", async (c) => {
    const lesson = await ownedLesson(c.env, c.get("user"), c.req.param("id"));
    const row = await ownedSlide(c.env, lesson.id, c.req.param("slideId"));
    const body = await parseJson(c, z.object({ content: z.unknown().optional(), notes: z.string().max(4000).optional() }));
    let content = JSON.parse(row.content) as SlideContent;
    if (body.content !== undefined) {
      const parsed = SLOT_SCHEMAS[row.layout as SlideContent["layout"]].safeParse(body.content);
      if (!parsed.success) {
        const issues = slotIssues({ ...(body.content as object), layout: row.layout } as SlideContent);
        const shown = issues.length ? issues : parsed.error.issues.map((i) => ({ path: i.path, message: i.message }));
        throw new HttpError(422, "INVALID_CONTENT", shown.slice(0, 5).map(describeIssue).join("；"), shown.slice(0, 20));
      }
      content = parsed.data as SlideContent;
    }
    const broken = body.content !== undefined ? widgetIssues(content) : [];
    if (broken.length) throw new HttpError(422, "INVALID_CONTENT", broken.map(describeIssue).join("；"), broken);
    const found = problemsOf(content, row.pageType as Parameters<typeof problemsOf>[1]);
    const notes = body.notes ?? row.notes;
    const unverified = await unverifiedFor(c.env, lesson.documentId, row, content, notes);
    await db(c.env)
      .update(slides)
      .set({ content: JSON.stringify(content), notes, warnings: JSON.stringify([...found.errors, ...found.warnings]), unverified: JSON.stringify(unverified), prevContent: row.content, prevNotes: row.notes, updatedAt: Date.now() })
      .where(eq(slides.id, row.id));
    return c.json({ slide: slideFromRow(await ownedSlide(c.env, lesson.id, row.id)) });
  })
  /** Swaps current and previous content, so undoing twice restores the edit. */
  .post("/:id/slides/:slideId/undo", async (c) => {
    const lesson = await ownedLesson(c.env, c.get("user"), c.req.param("id"));
    const row = await ownedSlide(c.env, lesson.id, c.req.param("slideId"));
    if (row.prevContent === null) throw new HttpError(409, "NOTHING_TO_UNDO", "Nothing to undo · 没有可撤销的修改");
    const content = SlideContent.parse(JSON.parse(row.prevContent));
    const found = problemsOf(content, row.pageType as Parameters<typeof problemsOf>[1]);
    const notes = row.prevNotes ?? row.notes;
    const unverified = await unverifiedFor(c.env, lesson.documentId, row, content, notes);
    await db(c.env)
      .update(slides)
      .set({ content: row.prevContent, notes, warnings: JSON.stringify([...found.errors, ...found.warnings]), unverified: JSON.stringify(unverified), prevContent: row.content, prevNotes: row.notes, updatedAt: Date.now() })
      .where(eq(slides.id, row.id));
    return c.json({ slide: slideFromRow(await ownedSlide(c.env, lesson.id, row.id)) });
  })
  .get("/:id/deck", async (c) => {
    const lesson = await ownedLesson(c.env, c.get("user"), c.req.param("id"));
    const v = await latestConfirmed(c.env, lesson.id);
    if (!v) throw new HttpError(409, "OUTLINE_NOT_CONFIRMED", "No confirmed outline yet");
    return c.json(deckExport(lesson, v, await slidesOf(c.env, v), { includeNotes: true, pageLabels: await pageLabels(c.env, lesson.documentId) }));
  })
  .post("/:id/share", async (c) => {
    const u = c.get("user");
    const lesson = await ownedLesson(c.env, u, c.req.param("id"));
    await db(c.env).update(shareLinks).set({ revokedAt: Date.now() }).where(and(eq(shareLinks.lessonId, lesson.id), isNull(shareLinks.revokedAt)));
    const token = randomToken(24);
    await db(c.env).insert(shareLinks).values({ id: newId("shr"), tokenHash: await sha256Hex(token), lessonId: lesson.id, createdBy: u.id });
    return c.json({ token, path: `/s/${token}` }, 201);
  })
  .delete("/:id/share", async (c) => {
    const lesson = await ownedLesson(c.env, c.get("user"), c.req.param("id"));
    await db(c.env).update(shareLinks).set({ revokedAt: Date.now() }).where(and(eq(shareLinks.lessonId, lesson.id), isNull(shareLinks.revokedAt)));
    return c.json({ ok: true });
  });
