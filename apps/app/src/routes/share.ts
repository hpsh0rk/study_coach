import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { sha256Hex } from "@kj/schema";
import { db } from "../db/index.ts";
import { lessons, shareLinks, users } from "../db/schema.ts";
import type { AppBindings } from "../env.ts";
import { HttpError } from "../http.ts";
import { citedPages, deckExport, sharedSlides, versionOf } from "../store.ts";
import { labelsFor } from "../textbook/index.ts";


/**
 * Public, read-only decks frozen at the version the teacher shared. No speaker notes or misconception
 * labels, no flagged slides the teacher has not reviewed, and no answers unless the link is 课后复习.
 */
export const shareRoutes = new Hono<AppBindings>().get("/:token", async (c) => {
  const hash = await sha256Hex(c.req.param("token"));
  const row = (
    await db(c.env)
      .select({ link: shareLinks, lesson: lessons })
      .from(shareLinks)
      .innerJoin(lessons, eq(lessons.id, shareLinks.lessonId))
      .innerJoin(users, eq(users.id, lessons.ownerId))
      .where(and(eq(shareLinks.tokenHash, hash), isNull(shareLinks.revokedAt), isNull(users.disabledAt)))
      .limit(1)
  )[0];
  if (!row?.link.versionId) throw new HttpError(404, "NOT_FOUND", "This link is invalid or was revoked · 链接无效或已撤销");
  const version = await versionOf(c.env, row.lesson.id, row.link.versionId);
  const { slides } = await sharedSlides(c.env, version, row.link.reviewedAt);
  const deck = deckExport(row.lesson, version, slides, { includeNotes: false, answers: row.link.answers, pageLabels: await labelsFor(c.env, row.lesson.documentId, { pages: citedPages(slides) }) });
  return c.json({ lesson: deck.lesson, slides: deck.slides });
});
