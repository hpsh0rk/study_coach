import { describe, expect, it } from "vitest";
import type { TocEntry } from "@kj/schema";
import { buildChapterTree, countPages, detectTextLayer, normalizeRanges, rangesForChapters, subtreeIds, textForRanges } from "../src/index.ts";

const toc: TocEntry[] = [
  {
    title: "Chapter 1  Waves",
    page: 1,
    children: [
      { title: "1.1 Describing waves", page: 2, children: [] },
      { title: "1.2 Wave speed", page: 3, children: [] },
      { title: "1.3 EM spectrum", page: 5, children: [] },
    ],
  },
  { title: "Chapter 2 Sound", page: 6, children: [{ title: "2.1 Sound waves", page: 7, children: [] }] },
];
const pages = Array.from({ length: 8 }, (_, i) => ({ no: i + 1, text: "word ".repeat(10 * (i + 1)) }));

describe("buildChapterTree", () => {
  const tree = buildChapterTree(toc, 8, pages);

  it("derives page ranges from the next sibling or shallower node", () => {
    expect(tree.map((c) => [c.title, c.pageStart, c.pageEnd, c.level])).toEqual([
      ["Chapter 1 Waves", 1, 5, 1],
      ["1.1 Describing waves", 2, 2, 2],
      ["1.2 Wave speed", 3, 4, 2],
      ["1.3 EM spectrum", 5, 5, 2],
      ["Chapter 2 Sound", 6, 8, 1],
      ["2.1 Sound waves", 7, 8, 2],
    ]);
  });

  it("links parents and counts words per range", () => {
    expect(tree[1]!.parentId).toBe(tree[0]!.id);
    expect(tree[0]!.parentId).toBeNull();
    expect(tree[2]!.words).toBe(30 + 40);
    expect(subtreeIds(tree, tree[0]!.id)).toHaveLength(4);
  });

  it("returns an empty tree without bookmarks", () => {
    expect(buildChapterTree([], 8, pages)).toEqual([]);
  });

  it("never ends before it starts when bookmarks share a page or are out of order", () => {
    const t = buildChapterTree(
      [
        { title: "A", page: 3, children: [] },
        { title: "B", page: 3, children: [] },
        { title: "C", page: 99, children: [] },
      ],
      5,
    );
    expect(t.map((c) => [c.pageStart, c.pageEnd])).toEqual([
      [3, 3],
      [3, 5],
      [5, 5],
    ]);
  });
});

describe("ranges", () => {
  it("merges overlapping and adjacent ranges and clamps to the document", () => {
    expect(normalizeRanges([{ start: 5, end: 9 }, { start: 1, end: 2 }, { start: 3, end: 4 }, { start: 8, end: 50 }], 12)).toEqual([{ start: 1, end: 12 }]);
    expect(normalizeRanges([{ start: 4, end: 2 }], 12)).toEqual([{ start: 2, end: 4 }]);
  });

  it("maps chapter selections to ranges", () => {
    const tree = buildChapterTree(toc, 8, pages);
    const r = rangesForChapters(tree, [tree[1]!.id, tree[2]!.id, tree[5]!.id], 8);
    expect(r).toEqual([
      { start: 2, end: 4 },
      { start: 7, end: 8 },
    ]);
    expect(countPages(r)).toBe(5);
  });
});

describe("textForRanges", () => {
  it("prefixes page markers and trims proportionally", () => {
    const text = textForRanges(pages, [{ start: 2, end: 3 }], 10_000);
    expect(text.split("\n")[0]).toMatch(/^\[p\.2\] word/);
    expect(text).toContain("[p.3]");
    const short = textForRanges(pages, [{ start: 1, end: 8 }], 400);
    expect(short.split("\n")).toHaveLength(8);
    expect(short.length).toBeLessThan(1400);
  });
});

describe("detectTextLayer", () => {
  it("flags scanned PDFs", () => {
    expect(detectTextLayer(pages, 8)).toBe(true);
    expect(detectTextLayer([{ no: 1, text: "12" }], 10)).toBe(false);
  });
});
