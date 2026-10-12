import { maxBuildStep } from "@kj/renderer";
import type { Slide } from "@kj/schema";

export interface Position {
  index: number;
  step: number;
}

/** Pure navigation model: builds are stepped through before moving to the next slide. */
export function nextPosition(slides: Slide[], pos: Position): Position {
  const slide = slides[pos.index];
  if (!slide) return pos;
  if (pos.step < maxBuildStep(slide)) return { index: pos.index, step: pos.step + 1 };
  if (pos.index < slides.length - 1) return { index: pos.index + 1, step: 0 };
  return pos;
}

export function prevPosition(slides: Slide[], pos: Position): Position {
  if (pos.step > 0) return { index: pos.index, step: pos.step - 1 };
  if (pos.index > 0) {
    const prev = slides[pos.index - 1]!;
    return { index: pos.index - 1, step: maxBuildStep(prev) };
  }
  return pos;
}

export function clampPosition(slides: Slide[], pos: Position): Position {
  const index = Math.min(Math.max(0, pos.index), Math.max(0, slides.length - 1));
  const slide = slides[index];
  const step = slide ? Math.min(Math.max(0, pos.step), maxBuildStep(slide)) : 0;
  return { index, step };
}

/** Scale and letterbox offsets for fitting the 16:9 logical stage into any viewport (e.g. 4:3 projectors). */
export function fitStage(viewW: number, viewH: number, stageW = 960, stageH = 540): { scale: number; offsetX: number; offsetY: number } {
  const scale = Math.max(0.01, Math.min(viewW / stageW, viewH / stageH));
  return { scale, offsetX: (viewW - stageW * scale) / 2, offsetY: (viewH - stageH * scale) / 2 };
}

export type SyncMessage =
  | { type: "state"; index: number; step: number; total: number; startedAt: number }
  | { type: "command"; action: "next" | "prev" | "goto"; index?: number; step?: number }
  | { type: "hello" };

export function channelName(deckKey: string): string {
  return `kj-deck-${deckKey}`;
}
