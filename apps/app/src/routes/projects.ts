import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { BUILTIN_THEMES, DEFAULT_THEME, newId, randomToken, sha256Hex } from "@kj/schema";
import { chapters, documents, projects, shareLinks } from "../db/schema.ts";
import type { AppBindings, SessionUser } from "../env.ts";
import { HttpError, parseJson } from "../http.ts";
import { db, requireUser } from "../auth/session.ts";
import type { ScopeChapter } from "../do/project-do.ts";

const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

async function loadProject(c: Context<AppBindings>, user: SessionUser, id: string) {
  const row = (await db(c.env).select().from(projects).where(eq(projects.id, id)).limit(1))[0];
  if (!row || row.orgId !== user.orgId || (row.ownerId !== user.id && user.role !== "admin")) throw new HttpError(404, "NOT_FOUND", "Project not found");
  return row;
}

function stub(c: Context<AppBindings>, projectId: string) {
  return c.env.PROJECT.get(c.env.PROJECT.idFromName(projectId));
}

function gateError(code: string, message: string): never {
  const status = code === "OUTLINE_NOT_CONFIRMED" || code === "THEME_NOT_LOCKED" || code === "NO_OUTLINE" || code === "GENERATION_IN_PROGRESS" || code === "OUTLINE_CHANGED" ? 409 : 400;
  throw new HttpError(status, code, message);
}

export const projectRoutes = new Hono<AppBindings>()
  .use(requireUser())
  .get("/", async (c) => {
    const u = c.get("user");
    const rows = await db(c.env)
      .select()
      .from(projects)
      .where(u.role === "admin" ? eq(projects.orgId, u.orgId) : and(eq(projects.orgId, u.orgId), eq(projects.ownerId, u.id)))
      .orderBy(desc(projects.updatedAt));
    return c.json({ projects: rows });
  })
  .post("/", async (c) => {
    const body = await parseJson(c, z.object({ title: z.string().trim().min(1).max(120) }));
    const u = c.get("user");
    const id = newId("prj");
    await db(c.env).insert(projects).values({ id, orgId: u.orgId, ownerId: u.id, title: body.title });
    await stub(c, id).init(id, u.orgId, body.title);
    return c.json({ id }, 201);
  })
  .get("/:id", async (c) => {
    const u = c.get("user");
    const project = await loadProject(c, u, c.req.param("id"));
    const docs = await db(c.env).select().from(documents).where(eq(documents.projectId, project.id)).orderBy(desc(documents.createdAt));
    const chapterRows = docs.length ? await db(c.env).select().from(chapters).where(inArray(chapters.documentId, docs.map((d) => d.id))).orderBy(chapters.pageStart, chapters.level) : [];
    const state = await stub(c, project.id).getState();
    return c.json({
      project,
      documents: docs.map((d) => ({ ...d, chapters: chapterRows.filter((ch) => ch.documentId === d.id) })),
      state,
      themes: Object.values(BUILTIN_THEMES).map((t) => ({ id: t.id, name: t.name })),
    });
  })

  // ---- upload & ingest ----
  .post("/:id/documents", async (c) => {
    const u = c.get("user");
    const project = await loadProject(c, u, c.req.param("id"));
    const size = Number(c.req.header("content-length") ?? 0);
    if (!size) throw new HttpError(411, "LENGTH_REQUIRED", "Content-Length required");
    if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, "TOO_LARGE", "PDF is larger than 300 MB");
    const filename = decodeURIComponent(c.req.header("x-filename") ?? "textbook.pdf").slice(0, 200);
    const body = c.req.raw.body;
    if (!body) throw new HttpError(400, "EMPTY", "Empty upload");

    const gate = c.env.USER_GATE.get(c.env.USER_GATE.idFromName(u.id));
    const documentId = newId("doc");
    const lease = await gate.acquire("ingest", documentId);
    if (!lease.ok) throw new HttpError(429, "QUOTA", "Another PDF is still being processed · 已有资料在处理中，请稍候");

    try {
      const r2Key = `uploads/${u.orgId}/${documentId}.pdf`;
      await c.env.FILES.put(r2Key, body, { httpMetadata: { contentType: "application/pdf" }, customMetadata: { filename } });
      const head = await c.env.FILES.get(r2Key, { range: { offset: 0, length: 5 } });
      const magic = head ? new TextDecoder().decode(await head.arrayBuffer()) : "";
      if (magic !== "%PDF-") {
        await c.env.FILES.delete(r2Key);
        throw new HttpError(415, "NOT_PDF", "Only PDF files are supported · 仅支持 PDF");
      }
      const parser = c.env.PARSER === "heavy" ? "heavy" : "pdf-lite";
      await db(c.env).insert(documents).values({ id: documentId, orgId: u.orgId, projectId: project.id, uploadedBy: u.id, filename, r2Key, sizeBytes: size, status: "uploaded", parserId: parser });
      const instance = await c.env.INGEST_WF.create({ id: documentId, params: { documentId, projectId: project.id, orgId: u.orgId, userId: u.id, r2Key, parser, leaseId: documentId } });
      await db(c.env).update(documents).set({ workflowInstanceId: instance.id }).where(eq(documents.id, documentId));
      return c.json({ documentId, status: "uploaded" }, 202);
    } catch (err) {
      await gate.release(documentId);
      throw err;
    }
  })

  // ---- scope -> fixed outline -> confirm -> theme lock -> generate ----
  .put("/:id/scope", async (c) => {
    const body = await parseJson(c, z.object({ documentId: z.string(), chapterIds: z.array(z.string()).min(1).max(30) }));
    const u = c.get("user");
    const project = await loadProject(c, u, c.req.param("id"));
    const doc = (await db(c.env).select().from(documents).where(and(eq(documents.id, body.documentId), eq(documents.projectId, project.id))).limit(1))[0];
    if (!doc || doc.status !== "ready") throw new HttpError(400, "DOCUMENT_NOT_READY", "The textbook is not parsed yet");
    const all = await db(c.env).select().from(chapters).where(eq(chapters.documentId, doc.id));
    const selected = all.filter((ch) => body.chapterIds.includes(ch.id));
    if (selected.length !== new Set(body.chapterIds).size) throw new HttpError(400, "VALIDATION", "Unknown chapters");
    const scope: ScopeChapter[] = selected.map((ch) => ({
      id: ch.id,
      title: ch.title,
      pageStart: ch.pageStart,
      pageEnd: ch.pageEnd,
      childTitles: all.filter((x) => x.parentId === ch.id).sort((a, b) => a.ord - b.ord).map((x) => x.title),
    }));
    const outline = await stub(c, project.id).setScope(doc.id, scope);
    return c.json({ outline });
  })
  .post("/:id/outline/confirm", async (c) => {
    const body = await parseJson(c, z.object({ versionId: z.string() }));
    const u = c.get("user");
    const project = await loadProject(c, u, c.req.param("id"));
    const res = await stub(c, project.id).confirmOutline(body.versionId, u.id);
    if (!res.ok) gateError(res.code, res.message);
    return c.json(res);
  })
  .post("/:id/theme/lock", async (c) => {
    const body = await parseJson(c, z.object({ themeId: z.string().default(DEFAULT_THEME.id) }));
    const u = c.get("user");
    const project = await loadProject(c, u, c.req.param("id"));
    const res = await stub(c, project.id).lockTheme(body.themeId, u.id);
    if (!res.ok) gateError(res.code, res.message);
    return c.json(res);
  })
  .post("/:id/generate", async (c) => {
    const body = await parseJson(c, z.object({ itemIds: z.array(z.string()).max(30).optional() }));
    const u = c.get("user");
    const project = await loadProject(c, u, c.req.param("id"));
    const gate = c.env.USER_GATE.get(c.env.USER_GATE.idFromName(u.id));
    const leaseId = newId("run");
    const lease = await gate.acquire("generate", leaseId);
    if (!lease.ok) throw new HttpError(429, "QUOTA", "Another generation is running · 已有生成任务在进行");
    try {
      const res = await stub(c, project.id).startGeneration({ userId: u.id, orgId: u.orgId, leaseId, ...(body.itemIds ? { itemIds: body.itemIds } : {}) });
      if (!res.ok) gateError(res.code, res.message);
      return c.json(res, 202);
    } catch (err) {
      await gate.release(leaseId);
      throw err;
    }
  })
  .get("/:id/deck", async (c) => {
    const project = await loadProject(c, c.get("user"), c.req.param("id"));
    const deck = await stub(c, project.id).getDeck();
    return c.json({ deck, theme: BUILTIN_THEMES[deck?.theme.themeId ?? DEFAULT_THEME.id] ?? DEFAULT_THEME });
  })
  .get("/:id/ws", async (c) => {
    const project = await loadProject(c, c.get("user"), c.req.param("id"));
    if (c.req.header("upgrade") !== "websocket") throw new HttpError(426, "UPGRADE_REQUIRED", "Expected WebSocket");
    return stub(c, project.id).fetch(c.req.raw);
  })

  // ---- student share links ----
  .get("/:id/shares", async (c) => {
    const project = await loadProject(c, c.get("user"), c.req.param("id"));
    const rows = await db(c.env).select().from(shareLinks).where(eq(shareLinks.projectId, project.id)).orderBy(desc(shareLinks.createdAt));
    return c.json({ shares: rows.map(({ tokenHash: _t, ...r }) => r) });
  })
  .post("/:id/shares", async (c) => {
    const body = await parseJson(c, z.object({ expiresInDays: z.number().int().min(1).max(365).nullable().default(30) }));
    const u = c.get("user");
    const project = await loadProject(c, u, c.req.param("id"));
    const token = randomToken(24);
    const id = newId("shr");
    const expiresAt = body.expiresInDays ? Date.now() + body.expiresInDays * 86_400_000 : null;
    await db(c.env).insert(shareLinks).values({ id, tokenHash: await sha256Hex(token), projectId: project.id, createdBy: u.id, expiresAt });
    return c.json({ id, token, path: `/s/${token}`, expiresAt }, 201);
  })
  .delete("/:id/shares/:shareId", async (c) => {
    const project = await loadProject(c, c.get("user"), c.req.param("id"));
    await db(c.env)
      .update(shareLinks)
      .set({ revokedAt: Date.now() })
      .where(and(eq(shareLinks.id, c.req.param("shareId")), eq(shareLinks.projectId, project.id)));
    return c.json({ ok: true });
  });
