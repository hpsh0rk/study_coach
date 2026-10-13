/**
 * The textbook module's writes, used only by routes/documents.ts. Page text is append-only: an upload
 * upserts pages, and a paste only fills pages that have no text.
 */
import { and, asc, between, count, eq } from "drizzle-orm";
import { distributeText, isEmptyPage } from "@kj/pdf-structure";
import { countWords, newId, type ChapterNode, type PageText } from "@kj/schema";
import { db } from "../db/index.ts";
import { auditLog } from "../db/schema.ts";
import type { Env, SessionUser } from "../env.ts";
import { HttpError } from "../http.ts";
import type { TextbookRow } from "./index.ts";
import { chapters, documents, pages } from "./tables.ts";

/** 40 upserts + ownership check + count + update stay under D1's 50-queries-per-invocation limit. */
export const PAGE_BATCH = 40;

export async function createTextbook(env: Env, user: SessionUser, meta: { filename: string; title: string; sizeBytes: number; pageCount: number }, tree: ChapterNode[]): Promise<string> {
  const id = newId("doc");
  const d = db(env);
  await d.insert(documents).values({ id, orgId: user.orgId, ownerId: user.id, ...meta, hasBookmarks: tree.length > 0 });
  for (let i = 0; i < tree.length; i += 10) {
    const rows = tree.slice(i, i + 10).map((ch) => ({ documentId: id, id: ch.id, parentId: ch.parentId, ord: ch.ord, level: ch.level, title: ch.title.slice(0, 300), pageStart: ch.pageStart, pageEnd: ch.pageEnd, words: ch.words }));
    await d.insert(chapters).values(rows);
  }
  return id;
}

/** Upserts a batch of parsed pages; word counts are computed here, not trusted from the browser. */
export async function putPages(env: Env, doc: TextbookRow, batch: PageText[]): Promise<{ received: number; pageCount: number; complete: boolean }> {
  const d = db(env);
  await d.batch(
    batch.map((p) => {
      const row = { text: p.text, label: p.label ?? null, words: countWords(p.text) };
      return d.insert(pages).values({ documentId: doc.id, no: p.no, ...row }).onConflictDoUpdate({ target: [pages.documentId, pages.no], set: row });
    }) as [any, ...any[]],
  );
  const received = (await d.select({ n: count() }).from(pages).where(eq(pages.documentId, doc.id)))[0]!.n;
  await d.update(documents).set({ pagesReceived: received }).where(eq(documents.id, doc.id));
  return { received, pageCount: doc.pageCount, complete: received === doc.pageCount };
}

/** Text a teacher pasted for a page range, spread over the range's pages without text (pages with text are never overwritten). */
export async function pastePages(env: Env, doc: TextbookRow, start: number, end: number, text: string): Promise<{ no: number; words: number; chars: number }[]> {
  const d = db(env);
  const rows = await d.select({ no: pages.no, words: pages.words }).from(pages).where(and(eq(pages.documentId, doc.id), between(pages.no, start, end))).orderBy(asc(pages.no));
  const empty = rows.filter((r) => isEmptyPage(r.words)).map((r) => r.no);
  if (!empty.length) throw new HttpError(409, "PAGES_HAVE_TEXT", "这些页已经有文字，不需要粘贴 · These pages already have text");
  if (empty.length > PAGE_BATCH) throw new HttpError(400, "TOO_MANY_PAGES", `一次最多为 ${PAGE_BATCH} 页粘贴文字，请分几次 · At most ${PAGE_BATCH} pages at a time`);
  const parts = distributeText(text, empty.length);
  const filled = empty.map((no, i) => ({ no, text: parts[i]!.slice(0, 40_000), words: countWords(parts[i]!.slice(0, 40_000)) }));
  await d.batch(filled.map((p) => d.update(pages).set({ text: p.text, words: p.words }).where(and(eq(pages.documentId, doc.id), eq(pages.no, p.no)))) as [any, ...any[]]);
  return filled.map(({ no, words, text: t }) => ({ no, words, chars: t.length }));
}

/** Soft delete or restore, with an audit record in the same batch. */
export async function setTextbookArchived(env: Env, user: SessionUser, doc: TextbookRow, archived: boolean): Promise<void> {
  const d = db(env);
  await d.batch([
    d.update(documents).set({ archivedAt: archived ? Date.now() : null }).where(eq(documents.id, doc.id)),
    d.insert(auditLog).values({ orgId: doc.orgId, actorId: user.id, action: archived ? "document.deleted" : "document.restored", target: doc.id }),
  ]);
}
