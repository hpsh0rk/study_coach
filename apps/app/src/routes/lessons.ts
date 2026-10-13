import { and, eq, isNull, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { checkSourcePages, draftOutline, problemsOf, slideKey, SlideInvalidError, SpecNotFoundError, workedSpecFor, writeSlide, type PlannerSection } from "@kj/generation";
import { leafSections } from "@kj/pdf-structure";
import { outlineTiming } from "@kj/pedagogy";
import { DEFAULT_PARAMS, LessonParams, newId, Outline, PageRange, sha256Hex, SlideContent, ThemeId, type ChapterNode, type LessonScope } from "@kj/schema";
import { layoutForPageType, SLOT_SCHEMAS } from "@kj/templates";
import { describeIssue, slotIssues, widgetIssues } from "@kj/templates/issues";
import { makeAi } from "../ai.ts";
import { auditLog, lessons, outlineVersions, shareLinks, slides } from "../db/schema.ts";
import type { AppBindings, Env } from "../env.ts";
import { HttpError, parseJson } from "../http.ts";
import { requireUser } from "../auth/session.ts";
import { db } from "../db/index.ts";
import {
  activeShare,
  carryOverSlides,
  DRAFT_LOCK_MS,
  confirmedOutline,
  citedPages,
  deckExport,
  flaggedSlides,
  latestConfirmed,
  latestVersion,
  lessonList,
  lessonView,
  lessonParams,
  lessonScope,
  outlineOf,
  ownedLesson,
  shareableVersion,
  shareToken,
  shareView,
  slideFromRow,
  unverifiedFor,
  slidesOf,
  versionOf,
  versionParams,
  versionScope,
  versionView,
  type LessonRow,
  type SlideRow,
  type VersionRow,
} from "../store.ts";
import { chapterTree, labelsFor, resolveScope, selectionPages, slideSourcePages } from "../textbook/index.ts";

const AnswerMode = z.enum(["hidden", "shown"]);

/** Deepest selected chapters in reading order become the planner's sections. */
function sectionsOf(tree: ChapterNode[], scope: LessonScope): PlannerSection[] {
  return leafSections(tree, scope.chapterIds).map((c) => ({ title: c.title, pageStart: c.pageStart, pageEnd: c.pageEnd }));
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
  const pageTexts = changed ? await selectionPages(env, lesson.documentId, versionScope(v).ranges) : [];
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

/** Why a write was refused: the version was confirmed meanwhile, or someone saved a newer edit. */
async function staleVersion(env: Env, lessonId: string, versionId: string): Promise<never> {
  const now = await versionOf(env, lessonId, versionId);
  if (now.confirmedAt !== null) throw new HttpError(409, "OUTLINE_VERSION_IMMUTABLE", "这一版大纲已经确认，不能再改；请点“修改大纲（新版本）”· A confirmed outline cannot be changed");
  throw new HttpError(409, "OUTLINE_CHANGED", "这份大纲刚在别处（另一个标签页或设备）改过。你这次的修改还没有保存：请先复制要保留的内容，再刷新页面 · The outline was changed elsewhere; reload before saving", { rev: now.rev });
}

/** `snapshot` defaults to the lesson's current settings; a revision copies its source version's snapshot instead. */
async function insertVersion(env: Env, lesson: LessonRow, outline: Outline, snapshot: { params: string; scope: string } = lesson): Promise<VersionRow> {
  const prev = await latestVersion(env, lesson.id);
  const id = newId("ov");
  await db(env)
    .insert(outlineVersions)
    .values({ id, lessonId: lesson.id, version: (prev?.version ?? 0) + 1, outline: JSON.stringify(outline), params: snapshot.params, scope: snapshot.scope, specCount: outline.slides.length });
  return versionOf(env, lesson.id, id);
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
    const { scope, title } = await resolveScope(c.env, u, body.documentId, body.chapterIds, body.ranges);
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
      const { scope, title } = await resolveScope(c.env, u, lesson.documentId, body.chapterIds ?? [], body.ranges ?? [], true);
      const unit = lessonScope(lesson).unit;
      patch.scope = JSON.stringify(unit ? { ...scope, unit } : scope);
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
    const [pageTexts, tree] = await Promise.all([selectionPages(c.env, lesson.documentId, scope.ranges), chapterTree(c.env, lesson.documentId)]);
    if (!pageTexts.length) {
      throw new HttpError(422, "NO_SOURCE_TEXT", "所选页面都没有可读的文字（可能是扫描图），不能凭空起草。请回到“选章节”，为这些页粘贴文字 · The selected pages have no text; paste it on the chapters step");
    }
    const now = Date.now();
    const locked = await db(c.env)
      .update(lessons)
      .set({ draftingUntil: now + DRAFT_LOCK_MS })
      .where(and(eq(lessons.id, lesson.id), or(isNull(lessons.draftingUntil), lt(lessons.draftingUntil, now))))
      .returning({ id: lessons.id });
    if (!locked.length) throw new HttpError(409, "DRAFT_IN_PROGRESS", "这节课的大纲正在生成中，请稍候（通常 30–90 秒）· An outline draft is already running");
    const run = (async () => {
      try {
        const res = await draftOutline(makeAi(c.env, u.orgId), {
          lessonTitle: lesson.title,
          params: lessonParams(lesson),
          sections: sectionsOf(tree, scope),
          pages: pageTexts,
          ctx: { orgId: u.orgId, userId: u.id, lessonId: lesson.id },
        });
        return { v: await insertVersion(c.env, lesson, res.outline), providerId: res.providerId };
      } finally {
        await db(c.env).update(lessons).set({ draftingUntil: null, updatedAt: Date.now() }).where(eq(lessons.id, lesson.id));
      }
    })();
    // A refresh or closed tab must not cancel a draft that is already billed.
    try {
      c.executionCtx.waitUntil(run.catch(() => undefined));
    } catch {}
    const { v, providerId } = await run;
    return c.json({ version: versionView(v), providerId }, 201);
  })
  .put("/:id/outline-versions/:vid", async (c) => {
    const lesson = await ownedLesson(c.env, c.get("user"), c.req.param("id"));
    const v = await versionOf(c.env, lesson.id, c.req.param("vid"));
    const body = await parseJson(c, z.object({ outline: Outline, rev: z.number().int().min(0) }));
    if (v.confirmedAt !== null) await staleVersion(c.env, lesson.id, v.id);
    const outline = await recheckSources(c.env, lesson, v, normalizeEdited(body.outline));
    const saved = await db(c.env)
      .update(outlineVersions)
      .set({ outline: JSON.stringify(outline), specCount: outline.slides.length, rev: body.rev + 1 })
      .where(and(eq(outlineVersions.id, v.id), isNull(outlineVersions.confirmedAt), eq(outlineVersions.rev, body.rev)))
      .returning({ id: outlineVersions.id });
    if (!saved.length) await staleVersion(c.env, lesson.id, v.id);
    return c.json({ version: versionView(await versionOf(c.env, lesson.id, v.id)) });
  })
  .post("/:id/outline-versions/:vid/confirm", async (c) => {
    const lesson = await ownedLesson(c.env, c.get("user"), c.req.param("id"));
    const v = await versionOf(c.env, lesson.id, c.req.param("vid"));
    const body = await parseJson(c, z.object({ ackOverBudget: z.boolean().default(false), rev: z.number().int().min(0).optional() }));
    if (v.confirmedAt !== null) return c.json({ version: versionView(v), slides: await slidesOf(c.env, v) });
    if (body.rev !== undefined && body.rev !== v.rev) await staleVersion(c.env, lesson.id, v.id);
    const params = versionParams(v);
    const timing = outlineTiming(outlineOf(v), params);
    if (timing.needsAck && !body.ackOverBudget) {
      throw new HttpError(409, "OVER_BUDGET_ACK_REQUIRED", `Outline is ${timing.totalMinutes} min for a ${params.minutes}-min lesson (beyond ±15%); confirm again to accept · 大纲时长超出 ±15%，请再次确认`, timing);
    }
    // Confirms exactly the outline whose timing was just checked: a concurrent save bumps rev and loses this race.
    const done = await db(c.env)
      .update(outlineVersions)
      .set({ confirmedAt: Date.now(), ackOverBudget: timing.needsAck })
      .where(and(eq(outlineVersions.id, v.id), isNull(outlineVersions.confirmedAt), eq(outlineVersions.rev, v.rev)))
      .returning({ id: outlineVersions.id });
    if (!done.length) await staleVersion(c.env, lesson.id, v.id);
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
      pages: await slideSourcePages(c.env, lesson.documentId, spec.sourcePages, versionScope(v).ranges),
      workedProblem: workedContent?.layout === "steps" ? workedContent.problem : undefined,
      ctx: { orgId: u.orgId, userId: u.id, lessonId: lesson.id },
    }).catch((e: unknown) => {
      if (e instanceof SlideInvalidError) throw new HttpError(502, "SLIDE_INVALID", "这一页没能生成合格的内容，请点“重新生成” · The slide could not be written within its budgets; regenerate it", e.problems.slice(0, 10));
      throw e;
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
    // `audience=student`: the same stripping as the share link (no notes, checks or misconception labels);
    // answers too unless `answers=shown` (课后复习).
    const includeNotes = c.req.query("audience") !== "student";
    const answers = c.req.query("answers") === "shown" ? "shown" : "hidden";
    const deck = await slidesOf(c.env, v);
    return c.json(deckExport(lesson, v, deck, { includeNotes, answers, pageLabels: await labelsFor(c.env, lesson.documentId, { pages: citedPages(deck) }) }));
  })
  /**
   * Shares a frozen version. With a link already active this keeps the same URL (on the same
   * version unless `versionId` moves it). Every share is a review: pages with links or
   * instruction-like text need `ack`.
   */
  .post("/:id/share", async (c) => {
    const u = c.get("user");
    const lesson = await ownedLesson(c.env, u, c.req.param("id"));
    const body = await parseJson(c, z.object({ versionId: z.string().optional(), ack: z.boolean().default(false), answers: AnswerMode.optional() }).default({ ack: false }));
    const link = await activeShare(c.env, lesson.id);
    const targetId = body.versionId ?? link?.versionId;
    const target = targetId ? await versionOf(c.env, lesson.id, targetId) : await shareableVersion(c.env, lesson.id);
    const list = target?.confirmedAt ? await slidesOf(c.env, target) : [];
    if (!target || !list.length) throw new HttpError(409, "NOTHING_TO_SHARE", "还没有生成好的页面可以分享 · Generate slides before sharing");
    const flagged = flaggedSlides(list, outlineOf(target));
    if (flagged.length && !body.ack) {
      throw new HttpError(409, "SHARE_REVIEW_REQUIRED", `第 ${flagged.map((f) => f.page).join("、")} 页含有网址、邮箱或像指令的文字，学生会看到。请检查后再分享 · Check these pages before sharing`, flagged);
    }
    if (link) {
      await db(c.env).update(shareLinks).set({ versionId: target.id, reviewedAt: Date.now(), ...(body.answers ? { answers: body.answers } : {}) }).where(eq(shareLinks.id, link.id));
      return c.json(await shareView(c.env, lesson.id));
    }
    const id = newId("shr");
    await db(c.env)
      .insert(shareLinks)
      .values({ id, tokenHash: await sha256Hex(await shareToken(c.env, id)), lessonId: lesson.id, versionId: target.id, reviewedAt: Date.now(), answers: body.answers ?? "hidden", createdBy: u.id });
    return c.json(await shareView(c.env, lesson.id), 201);
  })
  /** Switches the live link between 课前预习 (answers stripped) and 课后复习 without moving its version or review. */
  .patch("/:id/share", async (c) => {
    const lesson = await ownedLesson(c.env, c.get("user"), c.req.param("id"));
    const body = await parseJson(c, z.object({ answers: AnswerMode }));
    const link = await activeShare(c.env, lesson.id);
    if (!link) throw new HttpError(404, "NOT_FOUND", "Not shared");
    await db(c.env).update(shareLinks).set({ answers: body.answers }).where(eq(shareLinks.id, link.id));
    return c.json(await shareView(c.env, lesson.id));
  })
  .delete("/:id/share", async (c) => {
    const lesson = await ownedLesson(c.env, c.get("user"), c.req.param("id"));
    await db(c.env).update(shareLinks).set({ revokedAt: Date.now() }).where(and(eq(shareLinks.lessonId, lesson.id), isNull(shareLinks.revokedAt)));
    return c.json({ ok: true });
  })
  /** Soft delete (archive): the share link stops working at once and is not brought back by a restore. */
  .delete("/:id", async (c) => {
    const lesson = await ownedLesson(c.env, c.get("user"), c.req.param("id"));
    const at = Date.now();
    await db(c.env).batch([
      db(c.env).update(shareLinks).set({ revokedAt: at }).where(and(eq(shareLinks.lessonId, lesson.id), isNull(shareLinks.revokedAt))),
      db(c.env).update(lessons).set({ archivedAt: at, draftingUntil: null }).where(eq(lessons.id, lesson.id)),
      db(c.env).insert(auditLog).values({ orgId: lesson.orgId, actorId: c.get("user").id, action: "lesson.deleted", target: lesson.id }),
    ]);
    return c.json({ ok: true });
  })
  .post("/:id/restore", async (c) => {
    const lesson = await ownedLesson(c.env, c.get("user"), c.req.param("id"), { archived: true });
    await db(c.env).batch([
      db(c.env).update(lessons).set({ archivedAt: null }).where(eq(lessons.id, lesson.id)),
      db(c.env).insert(auditLog).values({ orgId: lesson.orgId, actorId: c.get("user").id, action: "lesson.restored", target: lesson.id }),
    ]);
    return c.json({ ok: true });
  });
