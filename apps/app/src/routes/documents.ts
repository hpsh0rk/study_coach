import { and, asc, between, count, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { distributeText, isEmptyPage } from "@kj/pdf-structure";
import { ChapterNode, countWords, newId, PageText } from "@kj/schema";
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
    for (const ch of body.chapters) {
      if (ch.pageEnd > body.pageCount || ch.pageStart > ch.pageEnd) throw new HttpError(400, "VALIDATION", `Chapter "${ch.title}" has an invalid page range`);
    }
    const u = c.get("user");
    const id = newId("doc");
    const d = db(c.env);
    await d.insert(documents).values({ id, orgId: u.orgId, ownerId: u.id, filename: body.filename, title: body.title, sizeBytes: body.sizeBytes, pageCount: body.pageCount, hasBookmarks: body.chapters.length > 0 });
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
      body.pages.map((p) => {
        const row = { text: p.text, label: p.label ?? null, words: countWords(p.text) };
        return d.insert(pages).values({ documentId: doc.id, no: p.no, ...row }).onConflictDoUpdate({ target: [pages.documentId, pages.no], set: row });
      }) as [any, ...any[]],
    );
    const received = (await d.select({ n: count() }).from(pages).where(eq(pages.documentId, doc.id)))[0]!.n;
    await d.update(documents).set({ pagesReceived: received }).where(eq(documents.id, doc.id));
    return c.json({ received, pageCount: doc.pageCount, complete: received === doc.pageCount });
  })
  /**
   * Fallback for scanned pages: text the teacher pastes for a page range is spread over the range's
   * pages that have no text (pages with text are never overwritten).
   */
  .post("/:id/pages/paste", async (c) => {
    const doc = await ownedDocument(c.env, c.get("user"), c.req.param("id"));
    const body = await parseJson(c, z.object({ start: z.number().int().min(1), end: z.number().int().min(1), text: z.string().trim().min(1).max(PAGE_BATCH * 8_000) }));
    if (body.end < body.start || body.end > doc.pageCount) throw new HttpError(400, "VALIDATION", "页码范围不对 · Invalid page range");
    const d = db(c.env);
    const rows = await d.select({ no: pages.no, words: pages.words }).from(pages).where(and(eq(pages.documentId, doc.id), between(pages.no, body.start, body.end))).orderBy(asc(pages.no));
    const empty = rows.filter((r) => isEmptyPage(r.words)).map((r) => r.no);
    if (!empty.length) throw new HttpError(409, "PAGES_HAVE_TEXT", "这些页已经有文字，不需要粘贴 · These pages already have text");
    if (empty.length > PAGE_BATCH) throw new HttpError(400, "TOO_MANY_PAGES", `一次最多为 ${PAGE_BATCH} 页粘贴文字，请分几次 · At most ${PAGE_BATCH} pages at a time`);
    const parts = distributeText(body.text, empty.length);
    const filled = empty.map((no, i) => ({ no, text: parts[i]!.slice(0, 40_000), words: countWords(parts[i]!.slice(0, 40_000)) }));
    await d.batch(filled.map((p) => d.update(pages).set({ text: p.text, words: p.words }).where(and(eq(pages.documentId, doc.id), eq(pages.no, p.no)))) as [any, ...any[]]);
    return c.json({ pages: filled.map(({ no, words }) => ({ no, words, chars: filled.find((f) => f.no === no)!.text.length })) });
  })
  .get("/:id", async (c) => {
    const doc = await ownedDocument(c.env, c.get("user"), c.req.param("id"));
    const tree = await db(c.env).select().from(chapters).where(eq(chapters.documentId, doc.id)).orderBy(chapters.ord);
    const sizes = await db(c.env).select({ no: pages.no, words: pages.words, chars: sql<number>`LENGTH(${pages.text})` }).from(pages).where(eq(pages.documentId, doc.id));
    const pageWords = new Array<number>(doc.pageCount).fill(0);
    const pageChars = new Array<number>(doc.pageCount).fill(0);
    for (const p of sizes) {
      pageWords[p.no - 1] = p.words;
      pageChars[p.no - 1] = p.chars;
    }
    return c.json({ document: doc, chapters: tree.map(({ documentId: _d, ...ch }) => ch), pageLabels: await pageLabels(c.env, doc.id), pageWords, pageChars });
  })
  .get("/:id/pages/:no", async (c) => {
    const doc = await ownedDocument(c.env, c.get("user"), c.req.param("id"));
    const no = Number(c.req.param("no"));
    const row = (await db(c.env).select().from(pages).where(and(eq(pages.documentId, doc.id), eq(pages.no, no))).limit(1))[0];
    if (!row) throw new HttpError(404, "NOT_FOUND", "Page not found");
    return c.json({ no: row.no, text: row.text, label: row.label });
  });
