import { and, asc, count, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  encodeSourcePage,
  newId,
  sha256Hex,
  type FigureCatalogEntry,
  type Slide,
  type SlideContent,
} from "@kj/schema";
import { db } from "./db/index.ts";
import { auditLog, lessons, mediaAssets, outlineVersions, shareLinks, slides as slidesTable, users } from "./db/schema.ts";
import type { Env, SessionUser } from "./env.ts";
import { HttpError } from "./http.ts";
import { effectiveSourcesForVersion, lessonScope, ownedLesson, pdfSourcesOf, sharedSlides, versionOf, versionScope, type LessonRow, type VersionRow } from "./store.ts";
import { multiLabelsFor, ownedTextbook } from "./textbook/index.ts";

/** Safely below Cloudflare D1's 1 MB SQL bound parameter limit. */
export const MAX_MEDIA_BYTES = 768 * 1024;
/** Base64 data URL character ceiling matching MAX_MEDIA_BYTES. */
export const MAX_MEDIA_DATA_URL_CHARS = Math.ceil((MAX_MEDIA_BYTES * 4) / 3) + 256;
export const MAX_FIGURES_PER_PAGE = 6;
export const MAX_MEDIA_PER_DOCUMENT = 120;
export const MAX_MEDIA_PER_LESSON = 40;
export const MAX_MEDIA_BATCH_ITEMS = 12;
/** Per-teacher total media quota (50 MB) protecting free-tier 500 MB D1 storage. */
export const MAX_TEACHER_MEDIA_BYTES = 50 * 1024 * 1024;

export type MediaMime = "image/png" | "image/webp" | "image/jpeg";

export interface MediaAssetMeta {
  id: string;
  documentId: string | null;
  lessonId: string | null;
  pageNo: number | null;
  virtualPageNo?: number | null;
  label: string;
  caption: string;
  mime: MediaMime;
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
  createdAt: number;
}

const META_COLS = {
  id: mediaAssets.id,
  documentId: mediaAssets.documentId,
  lessonId: mediaAssets.lessonId,
  pageNo: mediaAssets.pageNo,
  label: mediaAssets.label,
  caption: mediaAssets.caption,
  mime: mediaAssets.mime,
  width: mediaAssets.width,
  height: mediaAssets.height,
  sizeBytes: mediaAssets.sizeBytes,
  sha256: mediaAssets.sha256,
  createdAt: mediaAssets.createdAt,
};

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end && i < bytes.length; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

/** Verifies PNG / WebP / JPEG magic bytes and extracts exact pixel dimensions from the binary header. */
export function inspectImageBinary(bytes: Uint8Array): { mime: MediaMime; width: number; height: number } {
  if (bytes.byteLength < 16) {
    throw new HttpError(400, "VALIDATION", "无效的图片数据 · Invalid image binary");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 1. PNG: \x89PNG\r\n\x1a\n + IHDR
  if (
    bytes.byteLength >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a &&
    ascii(bytes, 12, 16) === "IHDR"
  ) {
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width >= 1 && width <= 8192 && height >= 1 && height <= 8192) {
      return { mime: "image/png", width, height };
    }
  }

  // 2. WebP: RIFF....WEBP + VP8X / VP8L / VP8
  if (bytes.byteLength >= 25 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    const chunk = ascii(bytes, 12, 16);
    let width = 0;
    let height = 0;
    if (chunk === "VP8X" && bytes.byteLength >= 30) {
      width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
      height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1;
    } else if (chunk === "VP8L" && bytes.byteLength >= 25 && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    } else if (chunk === "VP8 " && bytes.byteLength >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    }
    if (width >= 1 && width <= 8192 && height >= 1 && height <= 8192) {
      return { mime: "image/webp", width, height };
    }
  }

  // 3. JPEG: \xff\xd8\xff + SOF0..SOF15
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let off = 2;
    while (off + 9 < bytes.byteLength) {
      if (bytes[off] !== 0xff) {
        off++;
        continue;
      }
      while (off < bytes.byteLength && bytes[off] === 0xff) off++;
      if (off >= bytes.byteLength) break;
      const marker = bytes[off]!;
      off++;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
      if (off + 2 > bytes.byteLength) break;
      const segLen = view.getUint16(off, false);
      if (segLen < 2 || off + segLen > bytes.byteLength) break;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && segLen >= 7) {
        const height = view.getUint16(off + 3, false);
        const width = view.getUint16(off + 5, false);
        if (width >= 1 && width <= 8192 && height >= 1 && height <= 8192) {
          return { mime: "image/jpeg", width, height };
        }
      }
      off += segLen;
    }
  }

  throw new HttpError(400, "VALIDATION", "仅支持有效的 PNG、WebP 或 JPEG 图片 · Only valid PNG, WebP or JPEG images are supported");
}

export function decodeImageDataUrl(dataUrl: string): { bytes: Uint8Array; mime: MediaMime; width: number; height: number } {
  const m = /^data:image\/(?:png|webp|jpeg|jpg);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!m) {
    throw new HttpError(400, "VALIDATION", "图片格式不对（需要 PNG / WebP / JPEG data URL）· Expected a PNG/WebP/JPEG data URL");
  }
  let bin: string;
  try {
    bin = atob(m[1]!.replace(/\s+/g, ""));
  } catch {
    throw new HttpError(400, "VALIDATION", "Base64 图片编码无效 · Invalid base64 image data");
  }
  if (bin.length === 0) throw new HttpError(400, "VALIDATION", "图片内容为空 · Empty image");
  if (bin.length > MAX_MEDIA_BYTES) {
    throw new HttpError(413, "TOO_LARGE", `单张插图不能超过 ${Math.round(MAX_MEDIA_BYTES / 1024)} KB · Image exceeds ${Math.round(MAX_MEDIA_BYTES / 1024)} KB`);
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const info = inspectImageBinary(bytes);
  return { bytes, ...info };
}

async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SaveMediaInput {
  documentId?: string;
  lessonId?: string;
  pageNo?: number;
  label?: string;
  caption?: string;
  image: string;
}

async function findExistingMedia(
  env: Env,
  user: SessionUser,
  scope: { documentId: string | null; lessonId: string | null; pageNo: number | null; sha256: string },
): Promise<MediaAssetMeta | null> {
  const conds = [
    eq(mediaAssets.orgId, user.orgId),
    eq(mediaAssets.ownerId, user.id),
    scope.documentId === null ? isNull(mediaAssets.documentId) : eq(mediaAssets.documentId, scope.documentId),
    scope.lessonId === null ? isNull(mediaAssets.lessonId) : eq(mediaAssets.lessonId, scope.lessonId),
    scope.pageNo === null ? isNull(mediaAssets.pageNo) : eq(mediaAssets.pageNo, scope.pageNo),
    eq(mediaAssets.sha256, scope.sha256),
  ];
  const rows = await db(env).select(META_COLS).from(mediaAssets).where(and(...conds)).limit(1);
  return rows[0] ?? null;
}

async function assertMediaQuotas(
  env: Env,
  user: SessionUser,
  scope: { documentId: string | null; lessonId: string | null; pageNo: number | null; addBytes: number },
): Promise<void> {
  const d = db(env);
  if (scope.documentId !== null && scope.pageNo !== null) {
    const [pgCnt] = await d
      .select({ n: count() })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.documentId, scope.documentId), eq(mediaAssets.pageNo, scope.pageNo)));
    if ((pgCnt?.n ?? 0) >= MAX_FIGURES_PER_PAGE) {
      throw new HttpError(409, "MEDIA_QUOTA", `单页最多保存 ${MAX_FIGURES_PER_PAGE} 张插图 · At most ${MAX_FIGURES_PER_PAGE} figures per page`);
    }
  }
  if (scope.documentId !== null) {
    const [docCnt] = await d.select({ n: count() }).from(mediaAssets).where(eq(mediaAssets.documentId, scope.documentId));
    if ((docCnt?.n ?? 0) >= MAX_MEDIA_PER_DOCUMENT) {
      throw new HttpError(409, "MEDIA_QUOTA", `单本教材最多保存 ${MAX_MEDIA_PER_DOCUMENT} 张插图 · At most ${MAX_MEDIA_PER_DOCUMENT} figures per textbook`);
    }
  }
  if (scope.lessonId !== null) {
    const [lesCnt] = await d.select({ n: count() }).from(mediaAssets).where(eq(mediaAssets.lessonId, scope.lessonId));
    if ((lesCnt?.n ?? 0) >= MAX_MEDIA_PER_LESSON) {
      throw new HttpError(409, "MEDIA_QUOTA", `单节课最多上传 ${MAX_MEDIA_PER_LESSON} 张插图 · At most ${MAX_MEDIA_PER_LESSON} uploaded images per lesson`);
    }
  }
  const [ownerUsage] = await d
    .select({ bytes: sql<number>`COALESCE(SUM(${mediaAssets.sizeBytes}), 0)` })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.orgId, user.orgId), eq(mediaAssets.ownerId, user.id)));
  if ((ownerUsage?.bytes ?? 0) + scope.addBytes > MAX_TEACHER_MEDIA_BYTES) {
    throw new HttpError(409, "MEDIA_QUOTA", "插图总存储已达上限（50 MB），请删除不再使用的教材或插图 · Media storage limit reached");
  }
}

export async function saveMediaAsset(env: Env, user: SessionUser, input: SaveMediaInput): Promise<{ asset: MediaAssetMeta; reused: boolean }> {
  const documentId = input.documentId?.trim() || null;
  const lessonId = input.lessonId?.trim() || null;
  if (!documentId && !lessonId) {
    throw new HttpError(400, "VALIDATION", "请指定所属教材或课程 · Provide documentId or lessonId");
  }
  let pageNo = input.pageNo ?? null;
  if (documentId) {
    const doc = await ownedTextbook(env, user, documentId, { archived: true });
    if (pageNo !== null && (pageNo < 1 || pageNo > doc.pageCount)) {
      throw new HttpError(400, "VALIDATION", `页码超出范围（1–${doc.pageCount}）· Page number out of range`);
    }
  } else {
    pageNo = null;
  }
  if (lessonId) {
    await ownedLesson(env, user, lessonId);
  }

  const decoded = decodeImageDataUrl(input.image);
  const sha256 = await sha256BytesHex(decoded.bytes);
  // Textbook figures belong to `(documentId, pageNo)` so every lesson using that page can cite them.
  const storedLessonId = documentId ? null : lessonId;

  const existing = await findExistingMedia(env, user, { documentId, lessonId: storedLessonId, pageNo, sha256 });
  if (existing) return { asset: existing, reused: true };

  await assertMediaQuotas(env, user, { documentId, lessonId: storedLessonId, pageNo, addBytes: decoded.bytes.byteLength });

  const id = newId("med");
  const label = (input.label ?? "").trim().slice(0, 80);
  const caption = (input.caption ?? "").trim().slice(0, 200);
  const createdAt = Date.now();
  try {
    await db(env).insert(mediaAssets).values({
      id,
      orgId: user.orgId,
      ownerId: user.id,
      documentId,
      lessonId: storedLessonId,
      pageNo,
      label,
      caption,
      mime: decoded.mime,
      width: decoded.width,
      height: decoded.height,
      sizeBytes: decoded.bytes.byteLength,
      data: decoded.bytes,
      sha256,
      createdAt,
    });
  } catch (err) {
    const winner = await findExistingMedia(env, user, { documentId, lessonId: storedLessonId, pageNo, sha256 });
    if (winner) return { asset: winner, reused: true };
    throw err;
  }

  return {
    asset: {
      id,
      documentId,
      lessonId: storedLessonId,
      pageNo,
      label,
      caption,
      mime: decoded.mime,
      width: decoded.width,
      height: decoded.height,
      sizeBytes: decoded.bytes.byteLength,
      sha256,
      createdAt,
    },
    reused: false,
  };
}

export async function listDocumentMedia(env: Env, user: SessionUser, documentId: string, wantedPages?: number[]): Promise<MediaAssetMeta[]> {
  await ownedTextbook(env, user, documentId, { archived: true });
  const d = db(env);
  if (wantedPages && wantedPages.length > 0) {
    const out: MediaAssetMeta[] = [];
    const unique = [...new Set(wantedPages)].sort((a, b) => a - b);
    for (let i = 0; i < unique.length; i += 80) {
      const rows = await d
        .select(META_COLS)
        .from(mediaAssets)
        .where(and(eq(mediaAssets.documentId, documentId), inArray(mediaAssets.pageNo, unique.slice(i, i + 80))))
        .orderBy(asc(mediaAssets.pageNo), asc(mediaAssets.createdAt));
      out.push(...rows);
    }
    return out;
  }
  return d
    .select(META_COLS)
    .from(mediaAssets)
    .where(eq(mediaAssets.documentId, documentId))
    .orderBy(asc(mediaAssets.pageNo), asc(mediaAssets.createdAt));
}

/** Lists all figures available to a lesson (across primary + secondary PDF scopes + direct lesson uploads). */
export async function listLessonMedia(env: Env, lesson: LessonRow, version?: VersionRow | null): Promise<MediaAssetMeta[]> {
  const d = db(env);
  const scope = version ? versionScope(version) : lessonScope(lesson);
  const pdfSources = pdfSourcesOf(effectiveSourcesForVersion(lesson, version), lesson.documentId, scope);

  const perPdf = await Promise.all(
    pdfSources.map(async (src, idx) => {
      if (!src.ranges.length) return [];
      const inRanges = or(...src.ranges.map((r) => and(gte(mediaAssets.pageNo, r.start), lte(mediaAssets.pageNo, r.end))));
      const rows = await d
        .select(META_COLS)
        .from(mediaAssets)
        .where(and(eq(mediaAssets.documentId, src.documentId), inRanges))
        .orderBy(asc(mediaAssets.pageNo), asc(mediaAssets.createdAt));
      return rows.map((r) => ({
        ...r,
        virtualPageNo: r.pageNo !== null ? encodeSourcePage(idx, r.pageNo) : null,
      }));
    }),
  );

  const direct = await d
    .select(META_COLS)
    .from(mediaAssets)
    .where(and(eq(mediaAssets.orgId, lesson.orgId), eq(mediaAssets.ownerId, lesson.ownerId), eq(mediaAssets.lessonId, lesson.id)))
    .orderBy(asc(mediaAssets.createdAt));

  // Also include any figure assetIds already embedded in this lesson's slides (e.g., carried over by `duplicate` from a source lesson).
  const existingSlideRows = await d.select({ content: slidesTable.content }).from(slidesTable).where(eq(slidesTable.lessonId, lesson.id));
  const referencedIds = new Set<string>();
  for (const r of existingSlideRows) {
    try {
      for (const id of figureAssetIdsInContent(JSON.parse(r.content) as SlideContent)) referencedIds.add(id);
    } catch {}
  }
  const seen = new Set<string>([...perPdf.flat().map((a) => a.id), ...direct.map((a) => a.id)]);
  const missingReferenced = [...referencedIds].filter((id) => !seen.has(id));
  const inherited: MediaAssetMeta[] = [];
  if (missingReferenced.length > 0) {
    for (let i = 0; i < missingReferenced.length; i += 80) {
      const rows = await d
        .select(META_COLS)
        .from(mediaAssets)
        .where(and(eq(mediaAssets.orgId, lesson.orgId), eq(mediaAssets.ownerId, lesson.ownerId), inArray(mediaAssets.id, missingReferenced.slice(i, i + 80))));
      inherited.push(...rows);
    }
  }

  return [...perPdf.flat(), ...direct, ...inherited];
}

export async function figureCatalogForLesson(env: Env, lesson: LessonRow, version?: VersionRow | null): Promise<FigureCatalogEntry[]> {
  const assets = await listLessonMedia(env, lesson, version);
  if (!assets.length) return [];
  const scope = version ? versionScope(version) : lessonScope(lesson);
  const pdfSources = pdfSourcesOf(effectiveSourcesForVersion(lesson, version), lesson.documentId, scope);
  const vPages = assets.flatMap((a) => (a.virtualPageNo ? [a.virtualPageNo] : []));
  const labels = vPages.length ? await multiLabelsFor(env, pdfSources, vPages, { includeRanges: false }) : {};
  return assets.map((a) => {
    const vNo = a.virtualPageNo ?? a.pageNo ?? undefined;
    const pageLabel = vNo !== undefined ? (labels[vNo] ?? String(vNo)) : undefined;
    return {
      assetId: a.id,
      ...(vNo !== undefined ? { pageNo: vNo } : {}),
      ...(pageLabel ? { pageLabel } : {}),
      label: a.label,
      caption: a.caption,
    };
  });
}

export function figureAssetIdsInContent(content: SlideContent): string[] {
  const out: string[] = [];
  if (content.layout === "statement" && content.visual.kind === "figure") out.push(content.visual.assetId);
  if (content.layout === "chart" && content.chart.kind === "figure") out.push(content.chart.assetId);
  return out;
}

export function figureAssetIdsInSlides(slides: Pick<Slide, "content">[]): Set<string> {
  const out = new Set<string>();
  for (const s of slides) {
    for (const id of figureAssetIdsInContent(s.content)) out.add(id);
  }
  return out;
}

export async function readMediaForUser(env: Env, user: SessionUser, id: string): Promise<{ mime: MediaMime; data: Uint8Array }> {
  const row = (
    await db(env)
      .select({ mime: mediaAssets.mime, data: mediaAssets.data })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.id, id), eq(mediaAssets.orgId, user.orgId), eq(mediaAssets.ownerId, user.id)))
      .limit(1)
  )[0];
  if (!row) throw new HttpError(404, "NOT_FOUND", "Media asset not found · 找不到该插图");
  return row;
}

/** Verifies `?share=<token>` grants read access ONLY to figure assets actually cited on visible shared slides of that link. */
export async function readMediaForShareToken(env: Env, shareTokenRaw: string, assetId: string): Promise<{ mime: MediaMime; data: Uint8Array }> {
  const hash = await sha256Hex(shareTokenRaw);
  const d = db(env);
  const row = (
    await d
      .select({ link: shareLinks, lesson: lessons })
      .from(shareLinks)
      .innerJoin(lessons, eq(lessons.id, shareLinks.lessonId))
      .innerJoin(users, eq(users.id, lessons.ownerId))
      .where(and(eq(shareLinks.tokenHash, hash), isNull(shareLinks.revokedAt), isNull(lessons.archivedAt), isNull(users.disabledAt)))
      .limit(1)
  )[0];
  if (!row?.link.versionId) throw new HttpError(404, "NOT_FOUND", "This link is invalid or was revoked · 链接无效或已撤销");

  const version = await versionOf(env, row.lesson.id, row.link.versionId);
  const { slides } = await sharedSlides(env, version, row.link.reviewedAt);
  const allowedIds = figureAssetIdsInSlides(slides);
  if (!allowedIds.has(assetId)) {
    throw new HttpError(404, "NOT_FOUND", "Media asset not in shared deck · 该插图不属于分享课件");
  }

  const asset = (
    await d
      .select({ mime: mediaAssets.mime, data: mediaAssets.data })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.orgId, row.lesson.orgId), eq(mediaAssets.ownerId, row.lesson.ownerId)))
      .limit(1)
  )[0];
  if (!asset) throw new HttpError(404, "NOT_FOUND", "Media asset not found · 找不到该插图");
  return asset;
}

export async function deleteMediaAsset(env: Env, user: SessionUser, id: string): Promise<void> {
  const deleted = await db(env)
    .delete(mediaAssets)
    .where(and(eq(mediaAssets.id, id), eq(mediaAssets.orgId, user.orgId), eq(mediaAssets.ownerId, user.id)))
    .returning({ id: mediaAssets.id });
  if (!deleted.length) throw new HttpError(404, "NOT_FOUND", "Media asset not found · 找不到该插图");
}

/** Permanently purges a lesson's slides, share links, and direct lesson-owned media assets (keeping assets still used by a duplicated live lesson). */
export async function purgeLesson(env: Env, user: SessionUser, lesson: LessonRow): Promise<void> {
  const d = db(env);
  const at = Date.now();
  const lessonAssets = await d
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.orgId, user.orgId), eq(mediaAssets.ownerId, user.id), eq(mediaAssets.lessonId, lesson.id)));

  let deletableIds = lessonAssets.map((a) => a.id);
  if (deletableIds.length > 0) {
    const otherSlides = await d
      .select({ content: slidesTable.content })
      .from(slidesTable)
      .innerJoin(lessons, eq(lessons.id, slidesTable.lessonId))
      .where(and(eq(lessons.ownerId, user.id), isNull(lessons.archivedAt), sql`${lessons.id} <> ${lesson.id}`));
    const stillUsed = new Set<string>();
    for (const s of otherSlides) {
      try {
        for (const id of figureAssetIdsInContent(JSON.parse(s.content) as SlideContent)) stillUsed.add(id);
      } catch {}
    }
    deletableIds = deletableIds.filter((id) => !stillUsed.has(id));
  }

  const confirmedVers = await d
    .select({ id: outlineVersions.id })
    .from(outlineVersions)
    .where(and(eq(outlineVersions.lessonId, lesson.id), sql`${outlineVersions.confirmedAt} IS NOT NULL`))
    .limit(1);

  const writes: any[] = [
    d.update(shareLinks).set({ revokedAt: at }).where(and(eq(shareLinks.lessonId, lesson.id), isNull(shareLinks.revokedAt))),
    d.delete(slidesTable).where(eq(slidesTable.lessonId, lesson.id)),
  ];
  if (deletableIds.length > 0) {
    writes.push(d.delete(mediaAssets).where(inArray(mediaAssets.id, deletableIds)));
  }
  if (confirmedVers.length === 0) {
    writes.push(d.delete(lessons).where(eq(lessons.id, lesson.id)));
  } else {
    writes.push(d.update(lessons).set({ archivedAt: lesson.archivedAt ?? at, draftingUntil: null }).where(eq(lessons.id, lesson.id)));
  }
  writes.push(d.insert(auditLog).values({ orgId: lesson.orgId, actorId: user.id, action: "lesson.purged", target: lesson.id }));
  await d.batch(writes as [any, ...any[]]);
}
