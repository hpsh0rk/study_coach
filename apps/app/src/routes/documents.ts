import { and, count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { ChapterNode, newId, PageText } from "@kj/schema";
import { chapters, documents, pages } from "../db/schema.ts";
import type { AppBindings } from "../env.ts";
import { HttpError, parseJson } from "../http.ts";
import { db, requireUser } from "../auth/session.ts";
import { ownedDocument, pageLabels } from "../store.ts";

export const MAX_PAGES = 600;
/** 40 upserts + ownership check + count + update stay under D1's 50-queries-per-invocation limit. */
export const PAGE_BATCH = 40;

const CreateDocument = z.object({
  filename: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(300),
  sizeBytes: z.number().int().min(1).max(200 * 1024 * 1024),
  pageCount: z.number().int().min(1).max(MAX_PAGES),
  hasTextLayer: z.boolean(),
  chapters: z.array(ChapterNode).max(800),
});

export const documentRoutes = new Hono<AppBindings>()
  .use(requireUser())
  .get("/", async (c) => {
    const u = c.get("user");
    const rows = await db(c.env).select().from(documents).where(and(eq(documents.orgId, u.orgId), eq(documents.ownerId, u.id))).orderBy(desc(documents.createdAt)).limit(100);
    return c.json({ documents: rows });
  })
  .post("/", async (c) => {
    const body = await parseJson(c, CreateDocument);
    if (!body.hasTextLayer) throw new HttpError(422, "NO_TEXT_LAYER", "This PDF has no text layer (scanned?). Please upload a born-digital PDF · 该 PDF 没有文字层（可能是扫描件），请上传电子版 PDF");
    for (const ch of body.chapters) {
      if (ch.pageEnd > body.pageCount || ch.pageStart > ch.pageEnd) throw new HttpError(400, "VALIDATION", `Chapter "${ch.title}" has an invalid page range`);
    }
    const u = c.get("user");
    const id = newId("doc");
    const d = db(c.env);
    await d.insert(documents).values({ id, orgId: u.orgId, ownerId: u.id, filename: body.filename, title: body.title, sizeBytes: body.sizeBytes, pageCount: body.pageCount, hasTextLayer: true, hasBookmarks: body.chapters.length > 0 });
    for (let i = 0; i < body.chapters.length; i += 10) {
      const rows = body.chapters.slice(i, i + 10).map((ch) => ({ documentId: id, id: ch.id, parentId: ch.parentId, ord: ch.ord, level: ch.level, title: ch.title.slice(0, 300), pageStart: ch.pageStart, pageEnd: ch.pageEnd, words: ch.words }));
      await d.insert(chapters).values(rows);
    }
    return c.json({ id, pageBatch: PAGE_BATCH }, 201);
  })
  .post("/:id/pages", async (c) => {
    const doc = await ownedDocument(c.env, c.get("user"), c.req.param("id"));
    const body = await parseJson(c, z.object({ pages: z.array(PageText.extend({ text: z.string().max(40_000) })).min(1).max(PAGE_BATCH) }));
    if (body.pages.some((p) => p.no > doc.pageCount)) throw new HttpError(400, "VALIDATION", "Page number beyond the document");
    const d = db(c.env);
    await d.batch(
      body.pages.map((p) => d.insert(pages).values({ documentId: doc.id, no: p.no, text: p.text, label: p.label ?? null }).onConflictDoUpdate({ target: [pages.documentId, pages.no], set: { text: p.text, label: p.label ?? null } })) as [any, ...any[]],
    );
    const received = (await d.select({ n: count() }).from(pages).where(eq(pages.documentId, doc.id)))[0]!.n;
    await d.update(documents).set({ pagesReceived: received }).where(eq(documents.id, doc.id));
    return c.json({ received, pageCount: doc.pageCount, complete: received === doc.pageCount });
  })
  .get("/:id", async (c) => {
    const doc = await ownedDocument(c.env, c.get("user"), c.req.param("id"));
    const tree = await db(c.env).select().from(chapters).where(eq(chapters.documentId, doc.id)).orderBy(chapters.ord);
    return c.json({ document: doc, chapters: tree.map(({ documentId: _d, ...ch }) => ch), pageLabels: await pageLabels(c.env, doc.id) });
  })
  .get("/:id/pages/:no", async (c) => {
    const doc = await ownedDocument(c.env, c.get("user"), c.req.param("id"));
    const no = Number(c.req.param("no"));
    const row = (await db(c.env).select().from(pages).where(and(eq(pages.documentId, doc.id), eq(pages.no, no))).limit(1))[0];
    if (!row) throw new HttpError(404, "NOT_FOUND", "Page not found");
    return c.json({ no: row.no, text: row.text, label: row.label });
  });
