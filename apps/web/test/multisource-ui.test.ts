import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChapterNode, LessonSource, Outline, ParsedPdf } from "@kj/schema";
import { formatApiError } from "../src/api.ts";
import { ingestPdf, sha256Hex, type IngestDeps } from "../src/textbook/ingest.ts";
import { SourcePage } from "../src/textbook/SourcePage.tsx";
import { autoParseTargets, ChapterBadges } from "../src/pages/wizard/ChaptersStep.tsx";
import { evaluateSyllabusCoverage, SyllabusCoverageCard } from "../src/pages/wizard/OutlineStep.tsx";

describe("formatApiError readable Chinese validation details", () => {
  it("replaces bare 'Invalid request' with readable Chinese field summaries", () => {
    const msg = formatApiError("VALIDATION", "Invalid request", [{ path: "pageCount", message: "Too big: expected number to be <=2500" }]);
    expect(msg).not.toBe("Invalid request");
    expect(msg).toContain("页数");
    expect(msg).toContain("pageCount");

    const focusMsg = formatApiError("VALIDATION", "Invalid request", [{ path: "params.focus", message: "Too big: expected string to have <=1500 characters" }]);
    expect(focusMsg).toContain("1500");
  });
});

describe("ingestPdf partial range & incremental page upsert", () => {
  const file = {
    name: "igcse-physics.pdf",
    size: 39_106_792,
    type: "application/pdf",
    arrayBuffer: async () => new TextEncoder().encode("%PDF-1.7 igcse").buffer as ArrayBuffer,
  };

  it("imports only selected pageNumbers (693..694) on a new 1,122-page textbook while preserving full TOC and true page numbers", async () => {
    const createdBodies: unknown[] = [];
    const uploadedBatches: number[][] = [];
    let receivedPageNumbers: number[] | undefined;

    const deps: IngestDeps = {
      hash: sha256Hex,
      lookup: async () => ({ status: "none", pageBatch: 40 }),
      parse: async (_data, _title, onProgress, opts) => {
        receivedPageNumbers = opts?.pageNumbers;
        onProgress(2, 2);
        return {
          title: "Cambridge IGCSE Physics",
          pageCount: 1122,
          toc: [{ title: "16 Magnetism", page: 693, pageEnd: 726, children: [] }],
          pages: [
            { no: 693, text: "Chapter 16 Magnetism" },
            { no: 694, text: "16.1 Permanent magnets" },
          ],
        } satisfies ParsedPdf;
      },
      create: async (body) => {
        createdBodies.push(body);
        return { id: "doc_igcse", pageBatch: 40 };
      },
      putPages: async (_id, pages) => {
        uploadedBatches.push(pages.map((p) => p.no));
      },
      restore: async () => undefined,
      confirmRestore: () => true,
    };

    const res = await ingestPdf(file, deps, () => undefined, {
      pageNumbers: [693, 694],
      fullToc: [
        { title: "16 Magnetism", page: 693, children: [] },
        { title: "17 Static electricity", page: 727, children: [] },
      ],
    });

    expect(res).toEqual({ id: "doc_igcse", outcome: "new" });
    expect(receivedPageNumbers).toEqual([693, 694]);
    expect(uploadedBatches).toEqual([[693, 694]]);
    expect(createdBodies[0]).toMatchObject({
      pageCount: 1122,
      chapters: [
        expect.objectContaining({ title: "16 Magnetism", pageStart: 693, pageEnd: 726 }),
        expect.objectContaining({ title: "17 Static electricity", pageStart: 727, pageEnd: 1122 }),
      ],
    });
  });

  it("incrementally upserts only newly requested pages when a sparse textbook already exists in D1", async () => {
    const uploadedBatches: number[][] = [];
    let receivedPageNumbers: number[] | undefined;

    const deps: IngestDeps = {
      hash: sha256Hex,
      lookup: async () => ({
        status: "incomplete",
        document: {
          id: "doc_igcse",
          filename: "igcse-physics.pdf",
          title: "Cambridge IGCSE Physics",
          pageCount: 1122,
          pagesReceived: 2,
          hasBookmarks: true,
          createdAt: 1,
        },
        // 693..694 already uploaded; 1..692 and 695..1122 missing
        missing: [
          { start: 1, end: 692 },
          { start: 695, end: 1122 },
        ],
        pageBatch: 40,
      }),
      parse: async (_data, _title, onProgress, opts) => {
        receivedPageNumbers = opts?.pageNumbers;
        onProgress(2, 2);
        return {
          title: "Cambridge IGCSE Physics",
          pageCount: 1122,
          toc: [],
          pages: [
            { no: 695, text: "16.2 Magnetic fields" },
            { no: 696, text: "EXAM-STYLE QUESTIONS" },
          ],
        };
      },
      create: async () => {
        throw new Error("must not create a duplicate document");
      },
      putPages: async (_id, pages) => {
        uploadedBatches.push(pages.map((p) => p.no));
      },
      restore: async () => undefined,
      confirmRestore: () => true,
    };

    // Request 694..696 -> 694 is already in D1, so only 695..696 are parsed and upserted!
    const res = await ingestPdf(file, deps, () => undefined, { pageNumbers: [694, 695, 696] });
    expect(res).toEqual({ id: "doc_igcse", outcome: "resumed" });
    expect(receivedPageNumbers).toEqual([695, 696]);
    expect(uploadedBatches).toEqual([[695, 696]]);
  });
});

describe("ChaptersStep quota guard & sparse chapter badges", () => {
  it("prevents quota burn on large books by restricting auto external/vision parsing to selectedPages ∩ unfixedPages", () => {
    const unfixedAll = Array.from({ length: 800 }, (_, i) => i + 1);
    // Large book (1,122 pages) with nothing selected yet -> 0 pages sent!
    expect(autoParseTargets({ pageCount: 1122, selectedPages: [], unfixedPages: unfixedAll, alreadySent: new Set() })).toEqual([]);
    // Once p.693..696 is selected -> ONLY 693..696 sent!
    expect(autoParseTargets({ pageCount: 1122, selectedPages: [693, 694, 695, 696], unfixedPages: unfixedAll, alreadySent: new Set() })).toEqual([693, 694, 695, 696]);
    // Small 3-page PDF right after upload with nothing selected yet -> sends its unfixed page [2]
    expect(autoParseTargets({ pageCount: 3, selectedPages: [], unfixedPages: [2], alreadySent: new Set() })).toEqual([2]);
  });

  it("renders 未导入 badge instead of 无文字 on chapters whose pages were not imported yet", () => {
    const ch17: ChapterNode = { id: "c17", parentId: null, level: 1, ord: 1, title: "17 Static electricity", pageStart: 697, pageEnd: 700, words: 0 };
    const html = renderToStaticMarkup(
      createElement(ChapterBadges, {
        chapter: ch17,
        pageWords: new Array<number>(1122).fill(0),
        pageParsers: {},
        pageKinds: {},
        pageFlags: {},
        labels: new Map(),
        importedSet: new Set([693, 694, 695, 696]),
      }),
    );
    expect(html).toContain("4 页未导入");
    expect(html).not.toContain("页无文字");
  });
});

describe("OutlineStep syllabus checklist coverage & SourcePage multi-PDF switcher", () => {
  it("computes and renders syllabus checklist coverage against outline slides and notCovered", () => {
    const sources: LessonSource[] = [
      {
        id: "src_syl",
        kind: "syllabus",
        title: "Clipboard_Screenshot.png",
        text: "",
        items: [
          "Describe the forces between magnetic poles",
          "Plot magnetic field lines using a compass",
          "Magnetic screening with soft iron rings",
        ],
      },
    ];
    const outline: Outline = {
      objectives: ["Describe magnetic pole forces and plot magnetic field lines"],
      slides: [
        {
          id: "sp1",
          pageType: "concept",
          layout: "statement",
          title: "Like magnetic poles repel and unlike poles attract",
          purpose: "",
          keyPoints: ["Forces between magnetic poles"],
          visual: "table",
          minutes: 4,
          sourcePages: [693],
          loop: 1,
        },
        {
          id: "sp2",
          pageType: "process",
          layout: "statement",
          title: "Plotting magnetic field lines around a bar magnet with a compass",
          purpose: "",
          keyPoints: ["Mark compass needle tip positions"],
          visual: "flow",
          minutes: 4,
          sourcePages: [694],
          loop: 1,
        },
      ],
      glossary: [],
      notCovered: ["Magnetic screening with soft iron rings"],
    };

    const cov = evaluateSyllabusCoverage(sources, outline);
    expect(cov).toHaveLength(3);
    expect(cov[0]).toMatchObject({ covered: true, slides: [1] });
    expect(cov[1]).toMatchObject({ covered: true, slides: [2] });
    expect(cov[2]).toMatchObject({ covered: false, slides: [] });

    const html = renderToStaticMarkup(createElement(SyllabusCoverageCard, { sources, outline }));
    expect(html).toContain("2 / 3");
    expect(html).toContain("Magnetic screening with soft iron rings");
  });

  it("renders document switcher tabs in SourcePage when multiple PDFs are attached", () => {
    const html = renderToStaticMarkup(
      createElement(SourcePage, {
        page: { no: 5, text: "Past paper question 5 [3]", label: "5", parser: "pdfjs/1", documentId: "doc_pp" },
        sources: [
          { documentId: "doc_tb", title: "IGCSE Coursebook", role: "textbook" },
          { documentId: "doc_pp", title: "2025 Past Paper 42", role: "past_paper" },
        ],
        onClose: () => undefined,
      }),
    );
    expect(html).toContain('data-testid="source-doc-switcher"');
    expect(html).toContain("IGCSE Coursebook");
    expect(html).toContain("2025 Past Paper 42");
  });
});
