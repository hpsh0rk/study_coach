import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChapterNode } from "@kj/schema";
import { ChapterBadges } from "../src/pages/wizard/ChaptersStep.tsx";

const scanChapter: ChapterNode = {
  id: "c-scan",
  parentId: "c-root",
  level: 2,
  ord: 3,
  title: "4.4 习题（扫描页）",
  pageStart: 5,
  pageEnd: 6,
  words: 0,
};

describe("ChaptersStep chapter badges", () => {
  it("does not render N 页外部解析 on blank/figure-only scanned pages where MinerU returned 0 words", () => {
    const html = renderToStaticMarkup(
      createElement(ChapterBadges, {
        chapter: scanChapter,
        pageWords: [40, 55, 62, 70, 0, 0],
        pageParsers: { 5: "mineru-agent/1", 6: "mineru-agent/1" },
        pageKinds: { 5: "scanned", 6: "scanned" },
        pageFlags: {},
        labels: new Map(),
      }),
    );
    expect(html).toContain("2 页无文字");
    expect(html).not.toContain("页外部解析");
  });

  it("counts only non-empty pages in N 页外部解析 and N 页看图识别 when a chapter mixes text-bearing and empty scans", () => {
    const mixedHtml = renderToStaticMarkup(
      createElement(ChapterBadges, {
        chapter: scanChapter,
        pageWords: [40, 55, 62, 70, 32, 0],
        pageParsers: { 5: "mineru-agent/1", 6: "mineru-agent/1" },
        pageKinds: { 5: "scanned", 6: "scanned" },
        pageFlags: {},
        labels: new Map(),
      }),
    );
    expect(mixedHtml).toContain("1 页无文字");
    expect(mixedHtml).toContain("1 页外部解析");

    const visionEmptyHtml = renderToStaticMarkup(
      createElement(ChapterBadges, {
        chapter: scanChapter,
        pageWords: [40, 55, 62, 70, 28, 0],
        pageParsers: { 5: "vlm:mock-vl/1", 6: "vlm:mock-vl/1" },
        pageKinds: { 5: "scanned", 6: "scanned" },
        pageFlags: {},
        labels: new Map(),
      }),
    );
    expect(visionEmptyHtml).toContain("1 页无文字");
    expect(visionEmptyHtml).toContain("1 页看图识别");
  });
});
