import { describe, expect, it } from "vitest";
import type { PageText, TocEntry } from "@kj/schema";
import {
  buildChapterTree,
  chapterRunsOf,
  leafSections,
  missingRanges,
  normalizeRanges,
  pageForLabel,
  pagesInRanges,
  rangesForChapters,
  sourceCut,
  topSections,
} from "../src/index.ts";

const toc: TocEntry[] = [
  { title: "前言", page: 1, children: [] },
  {
    title: "第1章   力与运动",
    page: 3,
    children: [
      {
        title: "1.1 Force",
        page: 4,
        children: [
          { title: "基础概念 Concepts", page: 5, children: [] },
          { title: "进阶概念 Concepts", page: 6, children: [] },
        ],
      },
      { title: "1.2 运动 Motion", page: 7, children: [] },
    ],
  },
  {
    title: "Chapter 2 Energy",
    page: 9,
    children: [
      { title: "2.1 Work", page: 10, children: [] },
      { title: "2.1 Work", page: 12, children: [] },
    ],
  },
];

const text = (no: number): PageText => ({ no, text: `page ${no} has six useful words here` });
const pages = [1, 3, 4, 6, 7, 9, 10, 11, 12, 13, 14].map(text).concat({ no: 2, text: "" }).sort((a, b) => a.no - b.no);
const tree = buildChapterTree(toc, 14, pages);
const ids = Object.fromEntries(tree.map((chapter) => [chapter.title, chapter.id]));

describe("chapter and scope fixture matrix", () => {
  it("builds the exact bilingual tree, preserving repeated headings and physical ranges", () => {
    expect(tree.map(({ id, parentId, level, title, pageStart, pageEnd }) => ({ id, parentId, level, title, pageStart, pageEnd }))).toEqual([
      { id: "c0", parentId: null, level: 1, title: "前言", pageStart: 1, pageEnd: 2 },
      { id: "c1", parentId: null, level: 1, title: "第1章 力与运动", pageStart: 3, pageEnd: 8 },
      { id: "c2", parentId: "c1", level: 2, title: "1.1 Force", pageStart: 4, pageEnd: 6 },
      { id: "c3", parentId: "c2", level: 3, title: "基础概念 Concepts", pageStart: 5, pageEnd: 5 },
      { id: "c4", parentId: "c2", level: 3, title: "进阶概念 Concepts", pageStart: 6, pageEnd: 6 },
      { id: "c5", parentId: "c1", level: 2, title: "1.2 运动 Motion", pageStart: 7, pageEnd: 8 },
      { id: "c6", parentId: null, level: 1, title: "Chapter 2 Energy", pageStart: 9, pageEnd: 14 },
      { id: "c7", parentId: "c6", level: 2, title: "2.1 Work", pageStart: 10, pageEnd: 11 },
      { id: "c8", parentId: "c6", level: 2, title: "2.1 Work", pageStart: 12, pageEnd: 14 },
    ]);
    expect(tree.filter((chapter) => chapter.title === "2.1 Work").map((chapter) => chapter.id)).toEqual(["c7", "c8"]);
  });

  it("distinguishes missing pages, blank front matter and roman printed labels", () => {
    expect(missingRanges(pages.map((page) => page.no), 14)).toEqual([
      { start: 5, end: 5 },
      { start: 8, end: 8 },
    ]);
    const labels = new Map([
      [1, "i"],
      [2, "ii"],
      [3, "1"],
    ]);
    expect(pageForLabel(labels, "II", 14)).toBe(2);
    expect(pageForLabel(labels, "3", 14)).toBe(3);
  });

  it("uses the deepest selected descendant and topmost selected ancestor even for sparse nested selections", () => {
    const selected = [ids["第1章 力与运动"]!, ids["基础概念 Concepts"]!];
    expect(topSections(tree, selected).map((chapter) => chapter.title)).toEqual(["第1章 力与运动"]);
    expect(leafSections(tree, selected).map((chapter) => chapter.title)).toEqual(["基础概念 Concepts"]);
    expect(rangesForChapters(tree, selected, 14)).toEqual([{ start: 3, end: 8 }]);

    const words = new Map(Array.from({ length: 14 }, (_, i) => [i + 1, 100]));
    expect(chapterRunsOf(tree, { chapterIds: selected, ranges: [{ start: 3, end: 8 }] }, words).map((run) => [run.title, run.pages.map((page) => page.no)])).toEqual([
      ["第1章 力与运动", [3, 4]],
      ["基础概念 Concepts", [5]],
      ["第1章 力与运动", [6, 7, 8]],
    ]);
  });

  it("normalizes chapter and overlapping manual ranges to one exact selected page set", () => {
    const ranges = rangesForChapters(tree, [ids["基础概念 Concepts"]!], 14);
    const combined = [
      ...ranges,
      { start: 4, end: 6 },
      { start: 6, end: 8 },
    ];
    expect(normalizeRanges(combined, 14)).toEqual([{ start: 4, end: 8 }]);
    expect(pagesInRanges(normalizeRanges(combined, 14))).toEqual([4, 5, 6, 7, 8]);
  });

  it("cuts source at whole-page boundaries in physical page order", () => {
    const cut = sourceCut(
      [
        { no: 3, chars: 20 },
        { no: 4, chars: 20 },
        { no: 6, chars: 20 },
        { no: 7, chars: 20 },
      ],
      53,
    );
    expect(cut).toEqual({ included: [3, 4], omitted: [6, 7] });
  });
});
