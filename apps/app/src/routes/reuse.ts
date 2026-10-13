import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { normalizeRanges, pagesInRanges } from "@kj/pdf-structure";
import { planBudget, planUnit, unitGroupLabel, unitGroupMinutes } from "@kj/pedagogy";
import { DEFAULT_PARAMS, LessonParams, newId, PageRange, type LessonScope } from "@kj/schema";
import { requireUser } from "../auth/session.ts";
import { db } from "../db/index.ts";
import { lessons, outlineVersions, slides } from "../db/schema.ts";
import type { AppBindings } from "../env.ts";
import { HttpError, parseJson } from "../http.ts";
import { latestConfirmed, latestVersion, lessonScope, lessonView, ownedLesson, type VersionRow } from "../store.ts";
import { chapterRuns, chapterTree, resolveScope } from "../textbook/index.ts";

/** A copy starts a fresh edit history (`rev` 0); share links stay with the source lesson. */
const copyVersion = (v: VersionRow, lessonId: string, version: number) => ({
  id: newId("ov"),
  lessonId,
  version,
  outline: v.outline,
  params: v.params,
  scope: v.scope,
  specCount: v.specCount,
  rev: 0,
  ackOverBudget: v.ackOverBudget,
  confirmedAt: v.confirmedAt,
});

/** Reuse: copy a lesson to a new term (keeping its confirmed outline and every slide, hand edits included) and plan a unit. */
export const reuseRoutes = new Hono<AppBindings>()
  .use(requireUser())
  /**
   * "复制这节课到新学期": the copy starts from the latest confirmed outline and its slides (plus a newer draft,
   * if any). Revising it regenerates only slides whose writer inputs changed (slideKey carry-over).
   */
  .post("/:id/duplicate", async (c) => {
    const u = c.get("user");
    const src = await ownedLesson(c.env, u, c.req.param("id"));
    const body = await parseJson(c, z.object({ title: z.string().trim().min(1).max(200).optional() }).default({}));
    const d = db(c.env);
    const [confirmed, latest] = await Promise.all([latestConfirmed(c.env, src.id), latestVersion(c.env, src.id)]);
    const id = newId("les");
    const { unit: _unit, ...scope } = lessonScope(src);
    const title = body.title ?? `${src.title}（新学期）`.slice(0, 200);
    await d.insert(lessons).values({ id, orgId: u.orgId, ownerId: u.id, documentId: src.documentId, title, scope: JSON.stringify(scope), params: src.params, theme: src.theme });
    let version = 0;
    if (confirmed) {
      const copy = copyVersion(confirmed, id, ++version);
      await d.insert(outlineVersions).values(copy);
      const rows = await d.select().from(slides).where(eq(slides.outlineVersionId, confirmed.id));
      const copies = rows.map((r) => ({ ...r, id: newId("sl"), lessonId: id, outlineVersionId: copy.id, prevContent: null, prevNotes: null, updatedAt: Date.now() }));
      for (let i = 0; i < copies.length; i += 5) await d.insert(slides).values(copies.slice(i, i + 5));
    }
    if (latest && latest.id !== confirmed?.id) await d.insert(outlineVersions).values(copyVersion(latest, id, ++version));
    return c.json(await lessonView(c.env, await ownedLesson(c.env, u, id)), 201);
  })
  /**
   * "整单元规划": one chapter range planned as several lessons, split by the minutes estimate (chapters kept
   * whole where they fit). `lessonId` reuses a lesson that has no outline yet as the first lesson.
   */
  .post("/unit", async (c) => {
    const u = c.get("user");
    const body = await parseJson(
      c,
      z.object({
        documentId: z.string(),
        chapterIds: z.array(z.string()).max(200).default([]),
        ranges: z.array(PageRange).max(50).default([]),
        title: z.string().trim().min(1).max(160).optional(),
        params: LessonParams.optional(),
        count: z.number().int().min(2).max(12).optional(),
        lessonId: z.string().optional(),
      }),
    );
    const { scope, title } = await resolveScope(c.env, u, body.documentId, body.chapterIds, body.ranges);
    const reuse = body.lessonId ? await ownedLesson(c.env, u, body.lessonId) : null;
    const drafting = !!reuse?.draftingUntil && reuse.draftingUntil > Date.now();
    if (reuse && (drafting || reuse.documentId !== body.documentId || (await latestVersion(c.env, reuse.id)))) throw new HttpError(409, "LESSON_IN_USE", "This lesson already has an outline · 这节课已经有大纲，不能并入单元");
    const params = body.params ?? (reuse ? LessonParams.parse(JSON.parse(reuse.params)) : DEFAULT_PARAMS);
    const d = db(c.env);
    const nos = pagesInRanges(scope.ranges);
    const tree = await chapterTree(c.env, body.documentId);
    const groups = planUnit(await chapterRuns(c.env, body.documentId, scope, tree), params.minutes, body.count);
    if (groups.length < 2) throw new HttpError(400, "UNIT_TOO_SMALL", "The selection fits one lesson · 所选内容一节课就够了，不需要拆分");
    const unit = { id: newId("unit", 8), title: (body.title ?? title).slice(0, 160), count: groups.length };
    const maxMinutes = planBudget(params).maxMinutes;
    const plan = groups.map((group) => {
      const groupPages = group.flatMap((p) => p.pages.map((x) => x.no));
      const ranges = normalizeRanges(
        groupPages.map((no) => ({ start: no, end: no })),
        Math.max(...groupPages),
      );
      // The title doubles as the cover title students see, so it carries no "第 N/M 课".
      const lessonTitle = `${unit.title} · ${unitGroupLabel(group)}`.slice(0, 200);
      const estimatedMinutes = unitGroupMinutes(group, params.minutes);
      return { group, groupPages, ranges, title: lessonTitle, estimatedMinutes, over: estimatedMinutes > maxMinutes };
    });
    if (c.req.query("dryRun") === "1")
      return c.json({ unit: { title: unit.title, count: groups.length }, minutes: params.minutes, maxMinutes, lessons: plan.map(({ title: t, ranges, estimatedMinutes, over }) => ({ title: t, ranges, estimatedMinutes, over })) });
    const created = [];
    for (const [k, { group, groupPages, ranges, title: lessonTitle, estimatedMinutes: est }] of plan.entries()) {
      const owned = new Set(groupPages);
      const chapterIds = [...new Set(group.flatMap((p) => (p.chapterId ? [p.chapterId] : [])))].filter((cid) => {
        const ch = tree.find((t) => t.id === cid);
        return !!ch && Array.from({ length: ch.pageEnd - ch.pageStart + 1 }, (_, i) => ch.pageStart + i).every((no) => owned.has(no) || !nos.includes(no));
      });
      const lessonScopeJson = JSON.stringify({ chapterIds, ranges, unit: { ...unit, index: k + 1 } } satisfies LessonScope);
      if (k === 0 && reuse) {
        await d.update(lessons).set({ title: lessonTitle, scope: lessonScopeJson, params: JSON.stringify(params), updatedAt: Date.now() }).where(eq(lessons.id, reuse.id));
        created.push({ id: reuse.id, title: lessonTitle, ranges, estimatedMinutes: est });
        continue;
      }
      const id = newId("les");
      await d.insert(lessons).values({ id, orgId: u.orgId, ownerId: u.id, documentId: body.documentId, title: lessonTitle, scope: lessonScopeJson, params: JSON.stringify(params) });
      created.push({ id, title: lessonTitle, ranges, estimatedMinutes: est });
    }
    return c.json({ unit, lessons: created }, 201);
  });
