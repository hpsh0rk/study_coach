import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { sha256Hex } from "@kj/schema";
import { db } from "../auth/session.ts";
import { lessons, shareLinks } from "../db/schema.ts";
import type { AppBindings } from "../env.ts";
import { HttpError } from "../http.ts";
import { deckExport, latestConfirmed, slidesOf } from "../store.ts";

/** Public, read-only decks. Speaker notes are never included. */
export const shareRoutes = new Hono<AppBindings>().get("/:token", async (c) => {
  const hash = await sha256Hex(c.req.param("token"));
  const link = (await db(c.env).select().from(shareLinks).where(and(eq(shareLinks.tokenHash, hash), isNull(shareLinks.revokedAt))).limit(1))[0];
  const lesson = link && (await db(c.env).select().from(lessons).where(eq(lessons.id, link.lessonId)).limit(1))[0];
  const version = lesson && (await latestConfirmed(c.env, lesson.id));
  if (!lesson || !version) throw new HttpError(404, "NOT_FOUND", "This link is invalid or was revoked · 链接无效或已撤销");
  const deck = deckExport(lesson, version, await slidesOf(c.env, version), { includeNotes: false });
  return c.json({ lesson: deck.lesson, slides: deck.slides });
});
