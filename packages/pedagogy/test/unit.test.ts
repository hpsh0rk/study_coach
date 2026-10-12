import { describe, expect, it } from "vitest";
import { planUnit, scopeAdvice, type UnitPiece } from "../src/index.ts";

const chapter = (id: string, first: number, pages: number, words: number): UnitPiece => ({
  title: `Chapter ${id}`,
  chapterId: id,
  pages: Array.from({ length: pages }, (_, i) => ({ no: first + i, words })),
});

describe("planUnit (整单元规划)", () => {
  it("splits by the minutes estimate and keeps chapters whole when they fit", () => {
    // 4 chapters × 3000 words ≈ 72 min of teaching: two 40-minute lessons.
    const pieces = [chapter("a", 1, 4, 750), chapter("b", 5, 4, 750), chapter("c", 9, 4, 750), chapter("d", 13, 4, 750)];
    expect(scopeAdvice(12000, 40).lessons).toBe(2);
    const groups = planUnit(pieces, 40);
    expect(groups.map((g) => g.map((p) => p.chapterId))).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("cuts a chapter longer than a lesson at page boundaries, in reading order", () => {
    const groups = planUnit([chapter("big", 1, 12, 1000)], 40, 3);
    expect(groups).toHaveLength(3);
    const pages = groups.map((g) => g.flatMap((p) => p.pages.map((x) => x.no)));
    expect(pages.flat()).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(pages.map((p) => p.length)).toEqual([4, 4, 4]);
    expect(groups[1]![0]!.title).toBe("Chapter big (2)");
  });

  it("never plans more lessons than there are pieces, and a short selection stays one lesson", () => {
    expect(planUnit([chapter("a", 1, 1, 9000)], 40)).toHaveLength(1);
    expect(planUnit([chapter("a", 1, 2, 100)], 40)).toHaveLength(1);
  });
});
