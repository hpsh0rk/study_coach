import { describe, expect, it } from "vitest";
import { planUnit, scopeAdvice, unitGroupLabel, unitGroupMinutes, type UnitPiece } from "../src/index.ts";

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

  it("without a count, plans enough lessons that none exceeds 115% of the lesson (R3-M4)", () => {
    // Review #3: 4.1–4.4 plus 10 pages of chapter-end material, about 87 minutes, used to come out as 37 + 50.
    const sec = (n: string, first: number, pages: number, words: number): UnitPiece => ({ title: `4.${n} Section`, chapterId: n, pages: Array.from({ length: pages }, (_, i) => ({ no: first + i, words })) });
    const pieces = [sec("1", 1, 4, 420), sec("2", 5, 4, 420), sec("3", 9, 5, 400), sec("4", 14, 7, 460), { title: "Key Terms, Summary, Review", chapterId: "end", pages: Array.from({ length: 10 }, (_, i) => ({ no: 21 + i, words: 560 })) }];
    const total = pieces.flatMap((p) => p.pages).reduce((n, p) => n + p.words, 0);
    expect(scopeAdvice(total, 40).estimatedMinutes).toBeGreaterThan(80);
    const groups = planUnit(pieces, 40);
    expect(groups.length).toBeGreaterThanOrEqual(3);
    for (const g of groups) expect(unitGroupMinutes(g, 40)).toBeLessThanOrEqual(46);
    expect(groups.flatMap((g) => g.flatMap((p) => p.pages.map((x) => x.no)))).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it("labels a lesson by its section range", () => {
    const s = (t: string): UnitPiece => ({ title: t, pages: [{ no: 1, words: 1 }] });
    expect(unitGroupLabel([s("4.1 Force"), s("4.2 Newton's First Law"), s("4.3 Newton's Second Law")])).toBe("4.1–4.3");
    expect(unitGroupLabel([s("4.4 Newton's Third Law")])).toBe("4.4 Newton's Third Law");
    expect(unitGroupLabel([s("Intro"), s("Review")])).toBe("Intro – Review");
  });
});
