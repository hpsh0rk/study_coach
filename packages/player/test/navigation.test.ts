import { describe, expect, it } from "vitest";
import type { Slide } from "@kj/schema";
import { clampPosition, fitStage, nextPosition, prevPosition } from "../src/navigation.ts";

const slide = (id: string, builds = 0): Slide => ({
  id,
  outlineItemId: "oi_1",
  layoutId: "x",
  elements: [],
  builds: Array.from({ length: builds }, (_, i) => ({ id: `b_${id}${i}`, order: i + 1, elementIds: [`el_${i}`], effect: "appear" as const })),
  notes: { en: [], zhTerms: [] },
  status: "ready",
  provenance: { aiCallId: "x", specHash: "x" },
});

describe("navigation", () => {
  const slides = [slide("sl_a"), slide("sl_b", 2), slide("sl_c")];

  it("steps through builds before advancing", () => {
    let pos = { index: 0, step: 0 };
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      pos = nextPosition(slides, pos);
      seen.push(`${pos.index}.${pos.step}`);
    }
    expect(seen).toEqual(["1.0", "1.1", "1.2", "2.0", "2.0", "2.0"]);
  });

  it("going back lands on the fully-built previous slide", () => {
    expect(prevPosition(slides, { index: 2, step: 0 })).toEqual({ index: 1, step: 2 });
    expect(prevPosition(slides, { index: 0, step: 0 })).toEqual({ index: 0, step: 0 });
  });

  it("clamps out-of-range positions", () => {
    expect(clampPosition(slides, { index: 9, step: 9 })).toEqual({ index: 2, step: 0 });
    expect(clampPosition([], { index: 3, step: 1 })).toEqual({ index: 0, step: 0 });
  });
});

describe("fitStage", () => {
  it("letterboxes 16:9 into a 4:3 projector (1024x768)", () => {
    const { scale, offsetX, offsetY } = fitStage(1024, 768);
    expect(scale).toBeCloseTo(1024 / 960);
    expect(offsetX).toBe(0);
    expect(offsetY).toBeCloseTo((768 - 540 * scale) / 2);
  });
  it("pillarboxes ultra-wide screens", () => {
    const { scale, offsetX, offsetY } = fitStage(2560, 1080);
    expect(scale).toBe(2);
    expect(offsetY).toBe(0);
    expect(offsetX).toBe((2560 - 1920) / 2);
  });
});
