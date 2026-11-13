import { Hono } from "hono";
import { z } from "zod";
import { loadSessionUser, requireUser } from "../auth/session.ts";
import type { AppBindings } from "../env.ts";
import { HttpError, parseJson } from "../http.ts";
import {
  deleteMediaAsset,
  listDocumentMedia,
  listLessonMedia,
  MAX_MEDIA_BATCH_ITEMS,
  MAX_MEDIA_DATA_URL_CHARS,
  readMediaForShareToken,
  readMediaForUser,
  saveMediaAsset,
} from "../media.ts";
import { ownedLesson } from "../store.ts";

const MEDIA_CACHE_CONTROL = "private, max-age=31536000, immutable";

const MediaItemBody = z.object({
  pageNo: z.number().int().min(1).max(3000).optional(),
  label: z.string().trim().max(80).optional(),
  caption: z.string().trim().max(200).optional(),
  image: z.string().min(20).max(MAX_MEDIA_DATA_URL_CHARS),
});

const UploadSingleBody = MediaItemBody.extend({
  documentId: z.string().trim().min(1).max(64).optional(),
  lessonId: z.string().trim().min(1).max(64).optional(),
});

const UploadBatchBody = z.object({
  documentId: z.string().trim().min(1).max(64).optional(),
  lessonId: z.string().trim().min(1).max(64).optional(),
  items: z.array(MediaItemBody).min(1).max(MAX_MEDIA_BATCH_ITEMS),
});

function parsePageList(raw: string | undefined): number[] | undefined {
  if (!raw?.trim()) return undefined;
  const nums = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 3000);
  return nums.length ? nums : undefined;
}

export const mediaRoutes = new Hono<AppBindings>()
  /** Binary image read: authenticated owner session OR valid `?share=<token>` for a figure cited in that shared deck. */
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const shareToken = c.req.query("share")?.trim();
    let found: { mime: string; data: Uint8Array };
    if (shareToken) {
      found = await readMediaForShareToken(c.env, shareToken, id);
    } else {
      const user = await loadSessionUser(c);
      if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Please log in · 请先登录");
      if (user.mustChangePassword) throw new HttpError(403, "PASSWORD_CHANGE_REQUIRED", "Please change your initial password · 请先修改初始密码");
      found = await readMediaForUser(c.env, user, id);
    }
    const body = found.data.buffer.slice(found.data.byteOffset, found.data.byteOffset + found.data.byteLength) as ArrayBuffer;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": found.mime,
        "Cache-Control": MEDIA_CACHE_CONTROL,
        "X-Content-Type-Options": "nosniff",
      },
    });
  })
  .get("/", requireUser(), async (c) => {
    const u = c.get("user");
    const lessonId = c.req.query("lessonId")?.trim();
    const documentId = c.req.query("documentId")?.trim();
    if (lessonId) {
      const lesson = await ownedLesson(c.env, u, lessonId);
      return c.json({ assets: await listLessonMedia(c.env, lesson) });
    }
    if (documentId) {
      const pages = parsePageList(c.req.query("pages") ?? c.req.query("pageNo"));
      return c.json({ assets: await listDocumentMedia(c.env, u, documentId, pages) });
    }
    throw new HttpError(400, "VALIDATION", "请提供 lessonId 或 documentId · Provide lessonId or documentId");
  })
  .post("/", requireUser(), async (c) => {
    if (Number(c.req.header("content-length") ?? 0) > MAX_MEDIA_DATA_URL_CHARS + 4_096) {
      throw new HttpError(413, "TOO_LARGE", "单张插图文件太大 · Image payload too large");
    }
    const body = await parseJson(c, UploadSingleBody);
    const res = await saveMediaAsset(c.env, c.get("user"), body);
    return c.json(res, res.reused ? 200 : 201);
  })
  .post("/batch", requireUser(), async (c) => {
    const body = await parseJson(c, UploadBatchBody);
    const u = c.get("user");
    const assets = [];
    let reusedCount = 0;
    for (const item of body.items) {
      const res = await saveMediaAsset(c.env, u, {
        ...(body.documentId ? { documentId: body.documentId } : {}),
        ...(body.lessonId ? { lessonId: body.lessonId } : {}),
        ...item,
      });
      assets.push(res.asset);
      if (res.reused) reusedCount++;
    }
    return c.json({ assets, reusedCount });
  })
  .delete("/:id", requireUser(), async (c) => {
    await deleteMediaAsset(c.env, c.get("user"), c.req.param("id"));
    return c.json({ ok: true });
  });
