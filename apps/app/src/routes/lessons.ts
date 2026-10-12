import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { normalizeRanges, rangesForChapters, textForRanges } from "@kj/pdf-structure";
import { checkOutline, outlineTiming } from "@kj/pedagogy";
import { draftOutline, type PlannerSection } from "@kj/planner";
import { DEFAULT_PARAMS, LessonParams, newId, Outline, PageRange, randomToken, sha256Hex, ThemeId, type ChapterNode, type LessonScope } from "@kj/schema";
import { layoutForPageType } from "@kj/templates";
import { SpecNotFoundError, writeSlide } from "@kj/writer";
import { makeAi } from "../ai.ts";
import { chapters, lessons, outlineVersions, shareLinks, slides } from "../db/schema.ts";
import type { AppBindings, Env, SessionUser } from "../env.ts";
import { HttpError, parseJson } from "../http.ts";
import { db, requireUser } from "../auth/session.ts";
import {
  confirmedOutline,
  deckExport,
  latestConfirmed,
  latestVersion,
  lessonParams,
  lessonScope,
  outlineOf,
  ownedDocument,
  ownedLesson,
  scopePages,
  slidesOf,
  versionOf,
  type LessonRow,
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

function versionView(v: VersionRow, params: LessonParams) {
  const outline = outlineOf(v);
  return {
    id: v.id,
    version: v.version,
    outline,
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

function immutableGuard(err: unknown): never {
  if (err instanceof Error && /OUTLINE_VERSION_IMMUTABLE/.test(`${err.message} ${(err as { cause?: Error }).cause?.message ?? ""}`)) {
    throw new HttpError(409, "OUTLINE_VERSION_IMMUTABLE", "A confirmed outline cannot be changed; start a new version · 已确认的大纲不能修改，请新建版本");
  }
  throw err;
}

async function insertVersion(env: Env, lessonId: string, outline: Outline): Promise<VersionRow> {
  const prev = await latestVersion(env, lessonId);
  const id = newId("ov");
  const totalMinutes = outline.slides.reduce((n, s) => n + s.minutes, 0);
  await db(env).insert(outlineVersions).values({ id, lessonId, version: (prev?.version ?? 0) + 1, outline: JSON.stringify(outline), totalMinutes });
  return versionOf(env, lessonId, id);
}

async function lessonView(env: Env, lesson: LessonRow) {
  const params = lessonParams(lesson);
  const [latest, confirmed] = await Promise.all([latestVersion(env, lesson.id), latestConfirmed(env, lesson.id)]);
  const share = (await db(env).select({ id: shareLinks.id }).from(shareLinks).where(and(eq(shareLinks.lessonId, lesson.id), isNull(shareLinks.revokedAt))).limit(1))[0];
  return {
    lesson: { id: lesson.id, title: lesson.title, documentId: lesson.documentId, theme: lesson.theme, params, scope: lessonScope(lesson), createdAt: lesson.createdAt, updatedAt: lesson.updatedAt },
    version: latest ? versionView(latest, params) : null,
    confirmedVersionId: confirmed?.id ?? null,
    slides: confirmed ? await slidesOf(env, confirmed) : [],
    shared: !!share,
  };
}

export const lessonRoutes = new Hono<AppBindings>()
  .use(requireUser())
  .get("/", async (c) => {
    const u = c.get("user");
    const rows = await db(c.env).select().from(lessons).where(and(eq(lessons.orgId, u.orgId), eq(lessons.ownerId, u.id))).orderBy(desc(lessons.updatedAt)).limit(100);
    const out = [];
    for (const l of rows) {
      const v = await latestVersion(c.env, l.id);
      const conf = await latestConfirmed(c.env, l.id);
      const n = conf ? (await slidesOf(c.env, conf)).length : 0;
      out.push({ id: l.id, title: l.title, updatedAt: l.updatedAt, params: lessonParams(l), status: !v ? "scoped" : !v.confirmedAt ? "outline" : n ? "slides" : "confirmed", slides: n, planned: conf ? outlineOf(conf).slides.length : 0 });
    }
    return c.json({ lessons: out });
  })
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
    const params = lessonParams(lesson);
    const scope = lessonScope(lesson);
    const [pageTexts, tree] = await Promise.all([scopePages(c.env, lesson), treeOf(c.env, lesson.documentId)]);
    const res = await draftOutline(makeAi(c.env, u.orgId), {
      lessonTitle: lesson.title,
      params,
      sections: sectionsOf(tree, scope),
      pages: pageTexts,
      sourceText: textForRanges(pageTexts, scope.ranges),
      ctx: { orgId: u.orgId, userId: u.id, lessonId: lesson.id },
    });
    const v = await insertVersion(c.env, lesson.id, res.outline);
    await db(c.env).update(lessons).set({ updatedAt: Date.now() }).where(eq(lessons.id, lesson.id));
    return c.json({ version: versionView(v, params), providerId: res.providerId }, 201);
  })
  .put("/:id/outline-versions/:vid", async (c) => {
    const lesson = await ownedLesson(c.env, c.get("user"), c.req.param("id"));
    const v = await versionOf(c.env, lesson.id, c.req.param("vid"));
    const body = await parseJson(c, z.object({ outline: Outline }));
    const outline = normalizeEdited(body.outline);
    if (v.confirmedAt !== null) immutableGuard(new Error("OUTLINE_VERSION_IMMUTABLE"));
    await db(c.env)
      .update(outlineVersions)
      .set({ outline: JSON.stringify(outline), totalMinutes: outline.slides.reduce((n, s) => n + s.minutes, 0) })
      .where(eq(outlineVersions.id, v.id))
      .catch(immutableGuard);
    return c.json({ version: versionView(await versionOf(c.env, lesson.id, v.id), lessonParams(lesson)) });
  })
  .post("/:id/outline-versions/:vid/confirm", async (c) => {
    const lesson = await ownedLesson(c.env, c.get("user"), c.req.param("id"));
    const v = await versionOf(c.env, lesson.id, c.req.param("vid"));
    const body = await parseJson(c, z.object({ ackOverBudget: z.boolean().default(false) }));
    const params = lessonParams(lesson);
    if (v.confirmedAt !== null) return c.json({ version: versionView(v, params) });
    const timing = outlineTiming(outlineOf(v), params);
    if (timing.needsAck && !body.ackOverBudget) {
      throw new HttpError(409, "OVER_BUDGET_ACK_REQUIRED", `Outline is ${timing.totalMinutes} min for a ${params.minutes}-min lesson (beyond ±15%); confirm again to accept · 大纲时长超出 ±15%，请再次确认`, timing);
    }
    await db(c.env).update(outlineVersions).set({ confirmedAt: Date.now(), ackOverBudget: timing.needsAck }).where(eq(outlineVersions.id, v.id)).catch(immutableGuard);
    return c.json({ version: versionView(await versionOf(c.env, lesson.id, v.id), params) });
  })
  .post("/:id/outline-versions/:vid/revise", async (c) => {
    const lesson = await ownedLesson(c.env, c.get("user"), c.req.param("id"));
    const v = await versionOf(c.env, lesson.id, c.req.param("vid"));
    const next = await insertVersion(c.env, lesson.id, outlineOf(v));
    return c.json({ version: versionView(next, lessonParams(lesson)) }, 201);
  })
  .post("/:id/outline-versions/:vid/slides/:specId/generate", async (c) => {
    const u = c.get("user");
    const lesson = await ownedLesson(c.env, u, c.req.param("id"));
    const v = await versionOf(c.env, lesson.id, c.req.param("vid"));
    const confirmed = confirmedOutline(v);
    const params = lessonParams(lesson);
    if (outlineTiming(confirmed.outline, params).needsAck && !v.ackOverBudget) throw new HttpError(409, "OVER_BUDGET_ACK_REQUIRED", "Over-budget outline was not acknowledged");
    const specId = c.req.param("specId");
    const spec = confirmed.outline.slides.find((s) => s.id === specId);
    if (!spec) throw new HttpError(404, "NOT_FOUND", new SpecNotFoundError(specId).message);
    const res = await writeSlide(makeAi(c.env, u.orgId), confirmed, specId, {
      lessonTitle: lesson.title,
      params,
      pages: await scopePages(c.env, lesson),
      ctx: { orgId: u.orgId, userId: u.id, lessonId: lesson.id },
    });
    const row = {
      id: newId("sl"),
      lessonId: lesson.id,
      outlineVersionId: v.id,
      specId,
      layout: spec.layout,
      pageType: spec.pageType,
      minutes: spec.minutes,
      content: JSON.stringify(res.content),
      notes: res.notes,
      sources: JSON.stringify(res.sources),
      warnings: JSON.stringify(res.warnings),
      providerId: res.providerId,
      updatedAt: Date.now(),
    };
    const { id: _id, ...update } = row;
    await db(c.env).insert(slides).values(row).onConflictDoUpdate({ target: [slides.outlineVersionId, slides.specId], set: update });
    const saved = (await slidesOf(c.env, v)).find((s) => s.specId === specId)!;
    return c.json({ slide: saved });
  })
  .get("/:id/deck", async (c) => {
    const lesson = await ownedLesson(c.env, c.get("user"), c.req.param("id"));
    const v = await latestConfirmed(c.env, lesson.id);
    if (!v) throw new HttpError(409, "OUTLINE_NOT_CONFIRMED", "No confirmed outline yet");
    return c.json(deckExport(lesson, v, await slidesOf(c.env, v), { includeNotes: true }));
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
