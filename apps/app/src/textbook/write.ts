/**
 * The textbook module's writes, used only by routes/documents.ts. Page text is append-only: an upload
 * upserts pages, and a paste only fills pages that have no text.
 */
import { and, asc, between, count, eq, isNull, sql } from "drizzle-orm";
import { distributeText, needsText, PASTE_PARSER, PDFJS_PARSER, pageFacts, type PageFacts } from "@kj/pdf-structure";
import { newId, type ChapterNode, type PageText } from "@kj/schema";
import { db } from "../db/index.ts";
import { auditLog } from "../db/schema.ts";
import type { Env, SessionUser } from "../env.ts";
import { HttpError } from "../http.ts";
import type { TextbookRow } from "./index.ts";
import { chapters, documents, pages } from "./tables.ts";

/** 40 upserts + ownership check + count + update stay under D1's 50-queries-per-invocation limit. */
export const PAGE_BATCH = 40;

/** Per teacher (deleted textbooks not counted): keeps one account from filling the free-tier database (500 MB, about 3 MB per 600-page book). */
export const MAX_TEXTBOOKS = 30;
export const MAX_TEXTBOOK_PAGES = 15_000;

async function activeWithHash(env: Env, ownerId: string, sha256: string, except?: string) {
  const rows = await db(env)
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.ownerId, ownerId), eq(documents.fileSha256, sha256), isNull(documents.archivedAt)));
  return rows.find((r) => r.id !== except) ?? null;
}

const alreadyUploaded = (id: string) => new HttpError(409, "DOCUMENT_EXISTS", "这本教材已经上传过，请直接使用 · This PDF is already uploaded", { id });

export async function createTextbook(
  env: Env,
  user: SessionUser,
  meta: { filename: string; title: string; sizeBytes: number; pageCount: number; sha256?: string },
  tree: ChapterNode[],
): Promise<string> {
  const d = db(env);
  if (meta.sha256) {
    const existing = await activeWithHash(env, user.id, meta.sha256);
    if (existing) throw alreadyUploaded(existing.id);
  }
  const [used] = await d
    .select({ books: count(), pages: sql<number>`COALESCE(SUM(${documents.pageCount}), 0)` })
    .from(documents)
    .where(and(eq(documents.orgId, user.orgId), eq(documents.ownerId, user.id), isNull(documents.archivedAt)));
  if ((used?.books ?? 0) >= MAX_TEXTBOOKS || (used?.pages ?? 0) + meta.pageCount > MAX_TEXTBOOK_PAGES) {
    throw new HttpError(409, "TEXTBOOK_QUOTA", `每位老师最多 ${MAX_TEXTBOOKS} 本教材、共 ${MAX_TEXTBOOK_PAGES} 页；请先删除不用的教材 · Textbook limit reached; delete one first`);
  }
  const { sha256, ...rest } = meta;
  const id = newId("doc");
  try {
    await d.insert(documents).values({ id, orgId: user.orgId, ownerId: user.id, ...rest, fileSha256: sha256 ?? null, hasBookmarks: tree.length > 0 });
  } catch (err) {
    // Two tabs uploading the same file: documents_owner_sha_uq lets one insert through.
    const winner = sha256 ? await activeWithHash(env, user.id, sha256) : null;
    if (winner) throw alreadyUploaded(winner.id);
    throw err;
  }
  for (let i = 0; i < tree.length; i += 10) {
    const rows = tree.slice(i, i + 10).map((ch) => ({ documentId: id, id: ch.id, parentId: ch.parentId, ord: ch.ord, level: ch.level, title: ch.title.slice(0, 300), pageStart: ch.pageStart, pageEnd: ch.pageEnd, words: ch.words }));
    await d.insert(chapters).values(rows);
  }
  return id;
}

/** Upserts a batch of parsed pages; page facts (words, chars, flags) are computed here, not trusted from the browser. */
export async function putPages(env: Env, doc: TextbookRow, batch: PageText[]): Promise<{ received: number; pageCount: number; complete: boolean }> {
  const d = db(env);
  await d.batch(
    batch.map((p) => {
      const row = { text: p.text, label: p.label ?? null, ...pageFacts(p.text), parser: PDFJS_PARSER, kind: p.kind ?? null };
      return d.insert(pages).values({ documentId: doc.id, no: p.no, ...row }).onConflictDoUpdate({ target: [pages.documentId, pages.no], set: row });
    }) as [any, ...any[]],
  );
  const received = (await d.select({ n: count() }).from(pages).where(eq(pages.documentId, doc.id)))[0]!.n;
  await d.update(documents).set({ pagesReceived: received }).where(eq(documents.id, doc.id));
  return { received, pageCount: doc.pageCount, complete: received === doc.pageCount };
}

/**
 * Text a teacher pasted for a page range, spread over the range's pages that need it: pages without text,
 * and must-fix pages (scanned, garbled, formula-lost) still holding pdf.js text. Other text is never overwritten.
 */
export async function pastePages(env: Env, doc: TextbookRow, start: number, end: number, text: string): Promise<({ no: number; parser: string } & PageFacts)[]> {
  const d = db(env);
  const rows = await d
    .select({ no: pages.no, words: pages.words, kind: pages.kind, parser: pages.parser })
    .from(pages)
    .where(and(eq(pages.documentId, doc.id), between(pages.no, start, end)))
    .orderBy(asc(pages.no));
  const empty = rows.filter((r) => needsText(r)).map((r) => r.no);
  if (!empty.length) throw new HttpError(409, "PAGES_HAVE_TEXT", "这些页的文字已经读好了，不需要粘贴 · These pages already have readable text");
  if (empty.length > PAGE_BATCH) throw new HttpError(400, "TOO_MANY_PAGES", `一次最多为 ${PAGE_BATCH} 页粘贴文字，请分几次 · At most ${PAGE_BATCH} pages at a time`);
  const parts = distributeText(text, empty.length);
  const filled = empty.map((no, i) => {
    const t = parts[i]!.slice(0, 40_000);
    return { no, text: t, ...pageFacts(t), parser: PASTE_PARSER };
  });
  await d.batch(filled.map(({ no, ...row }) => d.update(pages).set(row).where(and(eq(pages.documentId, doc.id), eq(pages.no, no)))) as [any, ...any[]]);
  return filled.map(({ no, words, chars, flags, parser }) => ({ no, words, chars, flags, parser }));
}

/** Soft delete or restore, with an audit record in the same batch. A restore never makes a second live copy of the same file. */
export async function setTextbookArchived(env: Env, user: SessionUser, doc: TextbookRow, archived: boolean): Promise<void> {
  const d = db(env);
  if (!archived && doc.fileSha256) {
    const live = await activeWithHash(env, doc.ownerId, doc.fileSha256, doc.id);
    if (live) throw alreadyUploaded(live.id);
  }
  await d.batch([
    d.update(documents).set({ archivedAt: archived ? Date.now() : null }).where(eq(documents.id, doc.id)),
    d.insert(auditLog).values({ orgId: doc.orgId, actorId: user.id, action: archived ? "document.deleted" : "document.restored", target: doc.id }),
  ]);
}
