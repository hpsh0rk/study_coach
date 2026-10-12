import { describe, expect, it } from "vitest";
import { ParsedDocument } from "@kj/schema";
// @ts-expect-error plain JS helper script without types
import { makeFixturePdf } from "../../../scripts/make-fixture-pdf.mjs";
import { buildChapterTree, pageText, pdfLiteParser, probeParsed } from "../src/index.ts";

describe("pdf-lite parser", () => {
  it("reads bookmarks and text into the normalized ParsedDocument", async () => {
    const bytes: Uint8Array = await makeFixturePdf();
    const doc = await pdfLiteParser.parse(bytes);
    expect(ParsedDocument.safeParse(doc).success).toBe(true);
    expect(doc.pageCount).toBe(8);
    expect(doc.toc?.map((t) => [t.title, t.level, t.page])).toEqual([
      ["Chapter 1  Waves", 1, 1],
      ["1.1  Describing waves", 2, 2],
      ["1.2  Wave speed", 2, 3],
      ["1.3  The electromagnetic spectrum", 2, 5],
      ["Chapter 2  Sound", 1, 6],
      ["2.1  Sound waves", 2, 7],
      ["2.2  Echoes and ultrasound", 2, 8],
    ]);
    expect(pageText(doc, 2, 2)).toContain("amplitude");
    expect(probeParsed(doc)).toMatchObject({ pageCount: 8, hasOutline: true });

    const tree = buildChapterTree(doc);
    const byTitle = Object.fromEntries(tree.map((n) => [n.title, n]));
    expect(byTitle["Chapter 1  Waves"]).toMatchObject({ parentId: null, pageStart: 1, pageEnd: 5, level: 1 });
    expect(byTitle["1.2  Wave speed"]).toMatchObject({ pageStart: 3, pageEnd: 4, parentId: byTitle["Chapter 1  Waves"]!.id, level: 2 });
    expect(byTitle["2.2  Echoes and ultrasound"]).toMatchObject({ pageStart: 8, pageEnd: 8 });
    expect(byTitle["1.1  Describing waves"]!.wordCount).toBeGreaterThan(50);
  });

  it("falls back to page buckets when there are no bookmarks", () => {
    const doc = { parser: { id: "x", version: "1" }, pageCount: 23, pages: [], blocks: [] };
    const tree = buildChapterTree(doc, { bucketPages: 10 });
    expect(tree.map((n) => n.title)).toEqual(["Pages 1–10", "Pages 11–20", "Pages 21–23"]);
  });
});
