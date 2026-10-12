import type { Slide, ThemeId } from "@kj/schema";
import { overflowingSlots, PALETTES, planSlide, type ImageItem, type SlidePlan } from "./plan.ts";
import { writePptx } from "./write.ts";

export * from "./plan.ts";
export { texToText, plain, lineCount, textEm } from "./text.ts";
export { writePptx, type WriteOptions } from "./write.ts";

/**
 * Typeface for every run (latin and East Asian). PingFang SC ships with macOS, so WPS and Keynote on a
 * Mac render it without anything embedded; elsewhere the app substitutes its own CJK sans.
 */
export const PPTX_FONT = "PingFang SC";

export const FONT_NOTE =
  "字体：PingFang SC（苹方，macOS 自带，Mac 上的 WPS / Keynote / PowerPoint 直接显示）。文件里没有嵌入字体；在 Windows 上会自动换成微软雅黑等中文黑体，行宽可能略有变化。· Font: PingFang SC, built into macOS; not embedded. Windows substitutes a similar CJK sans.";

export interface PptxDeck {
  title: string;
  theme: ThemeId;
  pageLabels?: Record<number, string>;
  slides: Pick<Slide, "content" | "notes" | "sources" | "unverified" | "pageType">[];
}

export interface PptxExport {
  data: Uint8Array;
  filename: string;
  plans: SlidePlan[];
  /** Slides (1-based) with an interaction or visual that became a static version, with the reason codes. */
  degraded: { slide: number; what: string[] }[];
  /** Text boxes the size estimate could not fit even at the minimum font size (expected empty for in-budget content). */
  overflow: { slide: number; slots: string[] }[];
}

export function planDeck(deck: PptxDeck): SlidePlan[] {
  const plans = deck.slides.map((s) => planSlide(s, { theme: deck.theme, pageLabels: deck.pageLabels ?? {} }));
  if (plans[0]) plans[0].notes = [plans[0].notes, FONT_NOTE].filter(Boolean).join("\n\n");
  return plans;
}

export const pptxFilename = (title: string) => `${title.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) || "lesson"}.pptx`;

/** Deck → editable .pptx: one 16:9 slide per deck slide, native text / tables / charts, notes in speaker notes. */
export async function exportPptx(deck: PptxDeck, opts: { chartImage?: (item: ImageItem) => Promise<string | null> } = {}): Promise<PptxExport> {
  const plans = planDeck(deck);
  const data = await writePptx(plans, { title: deck.title, fontFace: PPTX_FONT, palette: PALETTES[deck.theme] ?? PALETTES.classic, ...opts });
  return {
    data,
    filename: pptxFilename(deck.title),
    plans,
    degraded: plans.map((p, i) => ({ slide: i + 1, what: p.degraded })).filter((d) => d.what.length),
    overflow: plans.map((p, i) => ({ slide: i + 1, slots: overflowingSlots(p) })).filter((d) => d.slots.length),
  };
}
