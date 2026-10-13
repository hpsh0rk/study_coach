import { Hono } from "hono";
import { z } from "zod";
import { ChapterNode, PageText } from "@kj/schema";
import type { AppBindings } from "../env.ts";
import { HttpError, parseJson } from "../http.ts";
import { requireUser } from "../auth/session.ts";
import { lessonsUsing } from "../store.ts";
import { chapterTree, lookupTextbook, ownedTextbook, page, pageMeta, textbookList } from "../textbook/index.ts";
import { createTextbook, PAGE_BATCH, pastePages, putPages, setTextbookArchived } from "../textbook/write.ts";
import { createParseJob, externalParserInfo, jobResult, pollJob, saveJobPages, uploadJobFile } from "../textbook/parsers/jobs.ts";

export const MAX_PAGES = 600;
export { PAGE_BATCH };

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex");

const CreateDocument = z.object({
  filename: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(300),
  sizeBytes: z.number().int().min(1).max(200 * 1024 * 1024),
  pageCount: z.number().int().min(1).max(MAX_PAGES),
  chapters: z.array(ChapterNode).max(800),
  sha256: Sha256.optional(),
});

export const documentRoutes = new Hono<AppBindings>()
  .use(requireUser())
  .get("/", async (c) => c.json({ documents: await textbookList(c.env, c.get("user")) }))
  /** Before parsing: the browser asks whether this file (by sha256) is already here, so a book is parsed and uploaded once. */
  .post("/lookup", async (c) => {
    const body = await parseJson(c, z.object({ sha256: Sha256 }));
    return c.json({ ...(await lookupTextbook(c.env, c.get("user"), body.sha256)), pageBatch: PAGE_BATCH });
  })
  .post("/", async (c) => {
    const body = await parseJson(c, CreateDocument);
    for (const ch of body.chapters) {
      if (ch.pageEnd > body.pageCount || ch.pageStart > ch.pageEnd) throw new HttpError(400, "VALIDATION", `Chapter "${ch.title}" has an invalid page range`);
    }
    const { chapters, ...meta } = body;
    const id = await createTextbook(c.env, c.get("user"), meta, chapters);
    return c.json({ id, pageBatch: PAGE_BATCH }, 201);
  })
  .post("/:id/pages", async (c) => {
    const doc = await ownedTextbook(c.env, c.get("user"), c.req.param("id"));
    const body = await parseJson(c, z.object({ pages: z.array(PageText.extend({ text: z.string().max(40_000) })).min(1).max(PAGE_BATCH) }));
    if (body.pages.some((p) => p.no > doc.pageCount)) throw new HttpError(400, "VALIDATION", "Page number beyond the document");
    return c.json(await putPages(c.env, doc, body.pages));
  })
  /**
   * Fallback for scanned pages: text the teacher pastes for a page range is spread over the range's
   * pages that have no text (pages with text are never overwritten).
   */
  .post("/:id/pages/paste", async (c) => {
    // Pasting text for scanned pages also serves lessons already made from a deleted document.
    const doc = await ownedTextbook(c.env, c.get("user"), c.req.param("id"), { archived: true });
    const body = await parseJson(c, z.object({ start: z.number().int().min(1), end: z.number().int().min(1), text: z.string().trim().min(1).max(PAGE_BATCH * 8_000) }));
    if (body.end < body.start || body.end > doc.pageCount) throw new HttpError(400, "VALIDATION", "页码范围不对 · Invalid page range");
    return c.json({ pages: await pastePages(c.env, doc, body.start, body.end, body.text) });
  })
  .get("/:id", async (c) => {
    const doc = await ownedTextbook(c.env, c.get("user"), c.req.param("id"), { archived: true });
    const [tree, meta, externalParser] = await Promise.all([chapterTree(c.env, doc.id), pageMeta(c.env, doc), externalParserInfo(c.env, c.get("user").orgId)]);
    return c.json({
      document: doc,
      chapters: tree,
      pageLabels: meta.labels,
      pageWords: meta.words,
      pageChars: meta.chars,
      pageParsers: meta.parsers,
      pageFlags: meta.flags,
      pageKinds: meta.kinds,
      externalParser,
    });
  })
  /**
   * External parser ("外部解析服务", admin switch, off by default). The browser cuts the pages into a small
   * PDF; the Worker streams it to the parser and the result back, and stores the text the browser maps back
   * by page. Pages a copy of the same file already got are copied instead of sent.
   */
  .post("/:id/parse", async (c) => {
    const doc = await ownedTextbook(c.env, c.get("user"), c.req.param("id"), { archived: true });
    const body = await parseJson(c, z.object({ pages: z.array(z.number().int().min(1).max(doc.pageCount)).min(1).max(50), reason: z.enum(["auto", "refine"]), ocr: z.boolean().default(false) }));
    return c.json(await createParseJob(c.env, c.get("user"), doc, body));
  })
  .put("/:id/parse/:job/file", async (c) => {
    const doc = await ownedTextbook(c.env, c.get("user"), c.req.param("id"), { archived: true });
    await uploadJobFile(c.env, c.get("user"), doc, c.req.param("job"), c.req.raw.body, Number(c.req.header("content-length")));
    return c.json({ ok: true });
  })
  .get("/:id/parse/:job", async (c) => {
    const doc = await ownedTextbook(c.env, c.get("user"), c.req.param("id"), { archived: true });
    return c.json(await pollJob(c.env, c.get("user"), doc, c.req.param("job")));
  })
  .get("/:id/parse/:job/result", async (c) => {
    const doc = await ownedTextbook(c.env, c.get("user"), c.req.param("id"), { archived: true });
    return jobResult(c.env, c.get("user"), doc, c.req.param("job"));
  })
  .post("/:id/parse/:job/pages", async (c) => {
    const doc = await ownedTextbook(c.env, c.get("user"), c.req.param("id"), { archived: true });
    const body = await parseJson(c, z.object({ pages: z.array(z.object({ no: z.number().int().min(1), text: z.string().max(40_000) })).max(50) }));
    return c.json({ pages: await saveJobPages(c.env, c.get("user"), doc, c.req.param("job"), body.pages) });
  })
  .get("/:id/pages/:no", async (c) => {
    const doc = await ownedTextbook(c.env, c.get("user"), c.req.param("id"), { archived: true });
    const row = await page(c.env, doc.id, Number(c.req.param("no")));
    if (!row) throw new HttpError(404, "NOT_FOUND", "Page not found");
    return c.json(row);
  })
  /**
   * Soft delete, like lessons: gone from the list and from new lessons; lessons already made from it
   * keep their source pages. `lessons`: how many of those there are.
   */
  .delete("/:id", async (c) => {
    const u = c.get("user");
    const doc = await ownedTextbook(c.env, u, c.req.param("id"));
    await setTextbookArchived(c.env, u, doc, true);
    return c.json({ ok: true, lessons: await lessonsUsing(c.env, doc.id) });
  })
  .post("/:id/restore", async (c) => {
    const u = c.get("user");
    const doc = await ownedTextbook(c.env, u, c.req.param("id"), { archived: true });
    await setTextbookArchived(c.env, u, doc, false);
    return c.json({ ok: true });
  });
