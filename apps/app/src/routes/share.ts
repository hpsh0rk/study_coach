import { and, count, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { sha256Hex } from "@kj/schema";
import { db } from "../db/index.ts";
import { lessons, shareLinks, slides as slidesTable, users } from "../db/schema.ts";
import type { AppBindings } from "../env.ts";
import { HttpError } from "../http.ts";
import { citedPages, deckExport, sharedSlides, versionOf } from "../store.ts";
import { labelsFor } from "../textbook/index.ts";

const SHARE_CACHE_CONTROL = "public, max-age=0, s-maxage=30, must-revalidate";

const stripWeak = (tag: string) => tag.trim().replace(/^W\//i, "");

function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const trimmed = header.trim();
  if (trimmed === "*") return true;
  const target = stripWeak(etag);
  return trimmed.split(",").some((candidate) => stripWeak(candidate) === target);
}

/**
 * Public, read-only decks frozen at the version the teacher shared. No speaker notes or misconception
 * labels, no flagged slides the teacher has not reviewed, and no answers unless the link is 课后复习.
 */
export const shareRoutes = new Hono<AppBindings>().get("/:token", async (c) => {
  const hash = await sha256Hex(c.req.param("token"));
  const d = db(c.env);
  const row = (
    await d
      .select({ link: shareLinks, lesson: lessons })
      .from(shareLinks)
      .innerJoin(lessons, eq(lessons.id, shareLinks.lessonId))
      .innerJoin(users, eq(users.id, lessons.ownerId))
      .where(and(eq(shareLinks.tokenHash, hash), isNull(shareLinks.revokedAt), isNull(users.disabledAt)))
      .limit(1)
  )[0];
  if (!row?.link.versionId) throw new HttpError(404, "NOT_FOUND", "This link is invalid or was revoked · 链接无效或已撤销");

  const [slideMeta] = await d
    .select({ count: count(), latest: sql<number>`COALESCE(MAX(${slidesTable.updatedAt}), 0)` })
    .from(slidesTable)
    .where(eq(slidesTable.outlineVersionId, row.link.versionId));

  const stamp = [
    hash,
    row.link.versionId,
    row.link.reviewedAt,
    row.link.answers,
    row.lesson.updatedAt,
    row.lesson.theme,
    row.lesson.title,
    slideMeta?.count ?? 0,
    slideMeta?.latest ?? 0,
  ].join(":");
  const etag = `W/"${(await sha256Hex(stamp)).slice(0, 32)}"`;

  if (matchesIfNoneMatch(c.req.header("if-none-match"), etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": SHARE_CACHE_CONTROL,
      },
    });
  }

  const version = await versionOf(c.env, row.lesson.id, row.link.versionId);
  const { slides } = await sharedSlides(c.env, version, row.link.reviewedAt);
  const deck = deckExport(row.lesson, version, slides, {
    includeNotes: false,
    answers: row.link.answers,
    pageLabels: await labelsFor(c.env, row.lesson.documentId, { pages: citedPages(slides) }),
  });
  c.header("ETag", etag);
  c.header("Cache-Control", SHARE_CACHE_CONTROL);
  return c.json({ lesson: deck.lesson, slides: deck.slides });
});
