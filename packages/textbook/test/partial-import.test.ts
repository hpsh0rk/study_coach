import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { GlobalWorkerOptions, inspectPdf, parsePdf } from "../src/browser.ts";
import { buildChapterTree, MAX_TREE_DEPTH, sourceForPages } from "../src/index.ts";

const pdfjsDir = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

beforeAll(() => {
  GlobalWorkerOptions.workerSrc = resolve(pdfjsDir, "legacy/build/pdf.worker.mjs");
});

/** Builds a synthetic multi-chapter PDF with a 4-level outline bookmark tree in pdf-lib. */
async function makeBookWithDeepToc(pageCount: number, textOnPages: Record<number, string>): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  doc.setTitle("Cambridge IGCSE Physics Synthetic");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([400, 500]);
    const content = textOnPages[i];
    if (content) page.drawText(content, { x: 40, y: 420, size: 12, font });
  }

  // Build 4-level PDF outline: Part 4 (p.690) -> Unit B (p.692) -> Ch 16 Magnetism (p.693) -> 16.1 Magnets (p.694) & Exam Questions (p.695), then Ch 17 Static Electricity (p.697)
  const ctx = doc.context;
  const pages = doc.getPages();
  const destFor = (oneBased: number) => ctx.obj([pages[Math.min(pageCount, Math.max(1, oneBased)) - 1]!.ref, PDFName.of("XYZ"), null, null, null]);

  const outlinesRef = ctx.nextRef();
  const part4Ref = ctx.nextRef();
  const unitBRef = ctx.nextRef();
  const ch16Ref = ctx.nextRef();
  const sec161Ref = ctx.nextRef();
  const exam16Ref = ctx.nextRef();
  const ch17Ref = ctx.nextRef();

  ctx.assign(
    sec161Ref,
    ctx.obj({
      Title: PDFString.of("16.1 Permanent magnets"),
      Parent: ch16Ref,
      Next: exam16Ref,
      Dest: destFor(694),
    }),
  );
  ctx.assign(
    exam16Ref,
    ctx.obj({
      Title: PDFString.of("EXAM-STYLE QUESTIONS"),
      Parent: ch16Ref,
      Prev: sec161Ref,
      Dest: destFor(695),
    }),
  );
  ctx.assign(
    ch16Ref,
    ctx.obj({
      Title: PDFString.of("16 Magnetism"),
      Parent: unitBRef,
      First: sec161Ref,
      Last: exam16Ref,
      Count: PDFNumber.of(2),
      Next: ch17Ref,
      Dest: destFor(693),
    }),
  );
  ctx.assign(
    ch17Ref,
    ctx.obj({
      Title: PDFString.of("17 Static electricity"),
      Parent: unitBRef,
      Prev: ch16Ref,
      Dest: destFor(697),
    }),
  );
  ctx.assign(
    unitBRef,
    ctx.obj({
      Title: PDFString.of("Block B Electricity and magnetism"),
      Parent: part4Ref,
      First: ch16Ref,
      Last: ch17Ref,
      Count: PDFNumber.of(4),
      Dest: destFor(692),
    }),
  );
  ctx.assign(
    part4Ref,
    ctx.obj({
      Title: PDFString.of("Part 4 Physics"),
      Parent: outlinesRef,
      First: unitBRef,
      Last: unitBRef,
      Count: PDFNumber.of(5),
      Dest: destFor(690),
    }),
  );
  ctx.assign(
    outlinesRef,
    ctx.obj({
      Type: PDFName.of("Outlines"),
      First: part4Ref,
      Last: part4Ref,
      Count: PDFNumber.of(6),
    }),
  );
  doc.catalog.set(PDFName.of("Outlines"), outlinesRef);

  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("P0 large-PDF inspectPdf, 4-level TOC, partial pageNumbers & pageOffset", () => {
  it("supports MAX_TREE_DEPTH = 4 and fast inspectPdf without full-book text extraction", async () => {
    expect(MAX_TREE_DEPTH).toBe(4);
    const data = await makeBookWithDeepToc(710, {
      1: "Cover page ignored during partial import",
      693: "Chapter 16 Magnetism: Poles attract and repel.",
      694: "16.1 Permanent magnets: Steel is hard; soft iron is temporary.",
      695: "EXAM-STYLE QUESTIONS: [2] State what happens between two N poles.",
      696: "SELF-EVALUATION CHECKLIST",
      697: "Chapter 17 Static electricity starts here.",
    });

    const info = await inspectPdf(data, "Fallback", { assets: `${pdfjsDir}/` });
    expect(info.title).toBe("Cambridge IGCSE Physics Synthetic");
    expect(info.pageCount).toBe(710);
    expect(info.toc[0]?.title).toBe("Part 4 Physics");
    const level4 = info.toc[0]?.children[0]?.children[0]?.children.map((c) => c.title);
    expect(level4).toEqual(["16.1 Permanent magnets", "EXAM-STYLE QUESTIONS"]);

    const fullTree = buildChapterTree(info.toc, info.pageCount);
    const ch16 = fullTree.find((c) => c.title === "16 Magnetism")!;
    expect({ level: ch16.level, start: ch16.pageStart, end: ch16.pageEnd }).toEqual({ level: 3, start: 693, end: 696 });
    const exam = fullTree.find((c) => c.title === "EXAM-STYLE QUESTIONS")!;
    expect({ level: exam.level, start: exam.pageStart, end: exam.pageEnd }).toEqual({ level: 4, start: 695, end: 696 });
  });

  it("parsePdf with pageNumbers extracts ONLY selected pages while keeping true 1-based page numbers and bounded TOC subtree", async () => {
    const data = await makeBookWithDeepToc(710, {
      1: "Unselected cover page",
      693: "Chapter 16 Magnetism intro text with enough words",
      694: "16.1 Permanent magnets soft iron vs steel",
      695: "EXAM-STYLE QUESTIONS question 1 [2]",
      696: "SELF-EVALUATION CHECKLIST magnetism",
      697: "Chapter 17 Static electricity unselected",
    });

    const progress: [number, number][] = [];
    const parsed = await parsePdf(data, {
      assets: `${pdfjsDir}/`,
      pageNumbers: [696, 693, 694, 695],
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(parsed.pageCount).toBe(710);
    expect(parsed.pages.map((p) => p.no)).toEqual([693, 694, 695, 696]);
    expect(parsed.pages[0]!.text).toContain("Chapter 16 Magnetism");
    expect(parsed.pages.some((p) => p.text.includes("Static electricity"))).toBe(false);
    expect(progress).toEqual([
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ]);

    // Matching TOC subtree excludes Chapter 17 (697..710) while preserving Chapter 16's true pageEnd = 696!
    const subTree = buildChapterTree(parsed.toc, parsed.pageCount, parsed.pages);
    expect(subTree.some((c) => c.title.includes("17 Static"))).toBe(false);
    const ch16 = subTree.find((c) => c.title === "16 Magnetism")!;
    expect({ start: ch16.pageStart, end: ch16.pageEnd }).toEqual({ start: 693, end: 696 });
    expect(ch16.words).toBeGreaterThan(15);
  });

  it("parsePdf with pageOffset maps a pre-sliced PDF (1..4) onto true textbook page numbers (693..696)", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 4; i++) {
      const p = doc.addPage([400, 500]);
      p.drawText(`Sliced Magnetism page ${693 + i}: B field lines point from N to S.`, { x: 40, y: 420, size: 12, font });
    }
    const bytes = await doc.save();
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    const parsed = await parsePdf(buf, "Chapter 16 Sliced", { assets: `${pdfjsDir}/`, pageOffset: 693 });
    expect(parsed.pageCount).toBe(696);
    expect(parsed.pages.map((p) => p.no)).toEqual([693, 694, 695, 696]);
    expect(parsed.pages[0]!.text).toContain("693");
  });

  it("sourceForPages cuts sparse and multi-PDF virtual pages cleanly without allocating 100k gaps", () => {
    const res = sourceForPages(
      [
        { no: 693, text: "Primary textbook magnetism page" },
        { no: 100_005, text: "Past paper question 5 [3]" },
      ],
      10_000,
    );
    expect(res.included).toEqual([693, 100_005]);
    expect(res.omitted).toEqual([]);
    expect(res.text).toContain("[p.693] Primary textbook magnetism page");
    expect(res.text).toContain("[p.100005] Past paper question 5 [3]");
  });
});
