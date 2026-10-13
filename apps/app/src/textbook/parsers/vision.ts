import { and, eq } from "drizzle-orm";
import { ProviderError, type AiLayer } from "@kj/ai";
import { cleanVisionText, pageFacts, visionParserId } from "@kj/textbook";
import { newId } from "@kj/schema";
import { db } from "../../db/index.ts";
import type { Env, SessionUser } from "../../env.ts";
import { HttpError } from "../../http.ts";
import type { TextbookRow } from "../index.ts";
import { pages, parseUsage } from "../tables.ts";
import { eligible, reuseParsed, writeParsed, type ParseReason, type Saved } from "./jobs.ts";
import { chinaDay, parseAllowance, parserSettingsOf, parseUsed, refusalMessage, visionPriceOf, type ParserSettings } from "./settings.ts";

/**
 * The fallback when the external parser is off or could not read a page: the browser renders the page to
 * a JPEG and the configured provider's vision model transcribes it. Its text is marked (`vlm:<model>/1`)
 * so the teacher is asked to check the numbers: a vision model can misread or invent digits.
 */
export interface VisionParserInfo {
  parser: string;
  model: string;
  microYuanPerPage: number;
}

/** Usable now: a vision model is set on the enabled provider, and it is free or paid parsing is allowed. */
export function visionParserInfo(settings: ParserSettings, visionModel: string | null): VisionParserInfo | null {
  if (!visionModel) return null;
  const price = visionPriceOf(visionModel, settings);
  if (price.microYuanPerPage > 0 && !settings.paidEnabled) return null;
  return { parser: visionParserId(visionModel), model: visionModel, microYuanPerPage: price.microYuanPerPage };
}

/** About 1600 px on the long side at JPEG quality 0.8 is 200–400 KB; anything far beyond is not a page render. */
export const MAX_IMAGE_CHARS = 4_000_000;
/** Only the prefix is checked: scanning the whole base64 would cost CPU (10 ms per request), and the provider rejects bad data anyway. */
const IMAGE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]{16}/;

export const PAGE_READ_PROMPT_VERSION = "page.read@1";
const PAGE_READ_PROMPT = [
  "这是一页教材的图片。把页面上的全部内容按阅读顺序转写成 Markdown：",
  "- 标题用 ##；公式写成 LaTeX（行内用 $…$，单独成行用 $$…$$）；表格写成 Markdown 表格；插图只写图注。",
  "- 数字、单位、符号必须和图片上一模一样。看不清的字写 [?]，不要猜，不要补充、解释或总结。",
  "- 不要页眉、页脚和页码。只输出转写的内容。",
  "Transcribe this textbook page as Markdown in reading order: LaTeX for formulas, Markdown tables, figure captions only. Copy every number exactly; write [?] for anything unreadable. Output the transcription only.",
].join("\n");

function failure(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ProviderError && err.status === 429) return new HttpError(503, "PARSER_BUSY", "看图模型正忙（限流），稍后再试 · The vision model is rate-limited; try again later");
  if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) return new HttpError(502, "VISION_FAILED", "看图模型拒绝了请求，请管理员检查模型配置 · The vision model refused the request");
  return new HttpError(502, "VISION_FAILED", "看图模型没有读出这一页 · The vision model could not read this page");
}

/**
 * Reads one must-fix page (or a refine page the teacher asked for) from its image. A copy of the same file
 * already read by this model is copied instead; otherwise the guardrails apply and the call is counted.
 */
export async function readPageImage(
  env: Env,
  user: SessionUser,
  doc: TextbookRow,
  ai: AiLayer,
  visionModel: string | null,
  req: { no: number; image: string; reason: ParseReason },
): Promise<{ page: Saved; reused: boolean }> {
  const settings = await parserSettingsOf(env, user.orgId);
  if (!visionModel) throw new HttpError(403, "VISION_OFF", "没有配置看图模型，请管理员在后台给模型加上“看图模型” · No vision model is configured");
  const parser = visionParserId(visionModel);
  if (req.image.length > MAX_IMAGE_CHARS || !IMAGE.test(req.image)) throw new HttpError(400, "VALIDATION", "Expected a page image as a data: URL (JPEG, PNG or WebP)");

  const row = (await db(env).select({ kind: pages.kind, parser: pages.parser }).from(pages).where(and(eq(pages.documentId, doc.id), eq(pages.no, req.no))).limit(1))[0];
  if (!row || !eligible(req.reason, row)) throw new HttpError(409, "PAGES_NOT_ELIGIBLE", "这一页不需要重新读 · This page does not need re-reading", { pages: [req.no] });

  const [reused] = await reuseParsed(env, doc, parser, [req.no]);
  if (reused) return { page: reused, reused: true };

  const cost = visionPriceOf(visionModel, settings).microYuanPerPage;
  const refusal = parseAllowance(await parseUsed(env, user, doc.id), { pages: 1, reason: req.reason, costMicroYuan: cost, mineru: false }, settings);
  if (refusal) throw new HttpError(refusal.status, refusal.code, refusalMessage(refusal, "看图模型识别"), { scope: refusal.scope, remaining: refusal.remaining });

  const id = newId("pjob");
  const d = db(env);
  await d.insert(parseUsage).values({ id, orgId: user.orgId, userId: user.id, documentId: doc.id, parser, reason: req.reason, pages: [req.no], pageCount: 1, costMicroYuan: cost, taskId: "", uploadUrl: "", day: chinaDay() });
  try {
    const res = await ai.callVision({ capability: "page.read", promptVersion: PAGE_READ_PROMPT_VERSION, instructions: PAGE_READ_PROMPT, image: req.image, timeoutMs: 90_000, ctx: { orgId: user.orgId, userId: user.id } });
    const text = cleanVisionText(res.text);
    if (!text) throw new HttpError(502, "VISION_FAILED", "看图模型没有读出文字 · The vision model returned no text");
    const page = { no: req.no, ...pageFacts(text), parser };
    await writeParsed(env, doc.id, [{ ...page, text }]);
    await d.update(parseUsage).set({ state: "done" }).where(eq(parseUsage.id, id));
    return { page, reused: false };
  } catch (err) {
    await d.update(parseUsage).set({ state: "failed", error: (err as Error).message.slice(0, 300) }).where(eq(parseUsage.id, id));
    throw failure(err);
  }
}
