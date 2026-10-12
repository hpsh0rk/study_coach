import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { sha256Hex } from "@kj/schema";
import { db } from "../auth/session.ts";
import { lessons, shareLinks, users } from "../db/schema.ts";
import { secret, type AppBindings, type Env } from "../env.ts";
import { HttpError } from "../http.ts";
import { deckExport, pageLabels, sharedSlides, versionOf } from "../store.ts";

/**
 * A link's token is derived from its id (HMAC with the app secret), so sharing again can hand out
 * the same URL while the database only stores sha256(token).
 */
export async function shareToken(env: Env, linkId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret(env, "AI_CONFIG_KEY")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`kj-share-link:v1:${linkId}`)));
  let bin = "";
  for (const b of mac.slice(0, 24)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Public, read-only decks frozen at the version the teacher shared. No speaker notes or misconception
 * labels, and no flagged slides the teacher has not reviewed.
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
  const deck = deckExport(row.lesson, version, slides, { includeNotes: false, pageLabels: await pageLabels(c.env, row.lesson.documentId) });
  return c.json({ lesson: deck.lesson, slides: deck.slides });
});
