import { describe, expect, it } from "vitest";
import {
  decodeSourcePage,
  encodeSourcePage,
  LessonParams,
  LessonScope,
  LessonSource,
  MAX_FOCUS_CHARS,
  ParsedPdf,
  PdfInspection,
  shortSourceTitle,
  SOURCE_STRIDE,
} from "../src/index.ts";

describe("ParsedPdf sparse/partial and large pageCount validation", () => {
  it("accepts a 1,122-page textbook with sparse partial pages (693..726) and rejects out-of-range or duplicate page numbers", () => {
    const partial = ParsedPdf.parse({
      title: "Cambridge IGCSE Physics 3rd Edition Coursebook",
      pageCount: 1122,
      toc: [{ title: "Chapter 16 Magnetism", page: 693, pageEnd: 726, children: [] }],
      pages: [
        { no: 693, text: "Chapter 16 Magnetism intro" },
        { no: 726, text: "Self-evaluation checklist" },
      ],
    });
    expect(partial.pageCount).toBe(1122);
    expect(partial.pages.map((p) => p.no)).toEqual([693, 726]);

    expect(
      ParsedPdf.safeParse({
        title: "Out of bounds",
        pageCount: 1122,
        toc: [],
        pages: [{ no: 1123, text: "Beyond pageCount" }],
      }).success,
    ).toBe(false);

    expect(
      ParsedPdf.safeParse({
        title: "Duplicate page",
        pageCount: 10,
        toc: [],
        pages: [
          { no: 5, text: "first" },
          { no: 5, text: "duplicate" },
        ],
      }).success,
    ).toBe(false);
  });

  it("validates PdfInspection preflight metadata", () => {
    const info = PdfInspection.parse({
      title: "IGCSE Physics",
      pageCount: 2400,
      toc: [{ title: "16 Magnetism", page: 693, children: [] }],
      pageLabels: { "1": "i", "15": "1" },
    });
    expect(info.pageCount).toBe(2400);
    expect(info.pageLabels["15"]).toBe("1");
  });
});

describe("LessonParams 1500-char teaching brief & LessonSource multi-source schemas", () => {
  it("raises focus limit to 1500 chars so full natural-language teaching briefs are preserved", () => {
    expect(MAX_FOCUS_CHARS).toBe(1500);
    const brief =
      "我现在是一个G10的物理老师，给IG班学生上课，使用第16章p693-726页制作一份60分钟的英文课件（重要专业词汇配中文）。严格覆盖考纲所有知识点，重点知识用红色字体加粗，多用书本原图，文字精简30号字左右，知识点配真题，每15分钟有学生活动，产出PPT及配套讲义。";
    expect(brief.length).toBeGreaterThan(120);
    const parsed = LessonParams.parse({
      minutes: 60,
      level: "intermediate",
      lessonType: "new",
      language: "en+zh",
      focus: brief,
    });
    expect(parsed.focus).toBe(brief);

    expect(
      LessonParams.safeParse({
        minutes: 60,
        level: "intermediate",
        lessonType: "new",
        language: "en+zh",
        focus: "x".repeat(1500),
      }).success,
    ).toBe(true);

    expect(
      LessonParams.safeParse({
        minutes: 60,
        level: "intermediate",
        lessonType: "new",
        language: "en+zh",
        focus: "x".repeat(1501),
      }).success,
    ).toBe(false);
  });

  it("validates pdf (textbook / past_paper / workbook) and syllabus / note LessonSource variants", () => {
    const textbook = LessonSource.parse({
      id: "src_1",
      kind: "pdf",
      documentId: "doc_igcse",
      title: "Cambridge IGCSE Physics Coursebook",
      ranges: [{ start: 693, end: 726 }],
      role: "textbook",
    });
    expect(textbook).toMatchObject({ kind: "pdf", role: "textbook" });

    const pastPaper = LessonSource.parse({
      id: "src_2",
      kind: "pdf",
      documentId: "doc_pp42",
      title: "0625_s25_qp_42",
      ranges: [{ start: 4, end: 7 }],
      role: "past_paper",
    });
    expect(pastPaper).toMatchObject({ kind: "pdf", role: "past_paper" });

    const workbook = LessonSource.parse({
      id: "src_3",
      kind: "pdf",
      documentId: "doc_wb",
      title: "Physics Workbook",
      ranges: [{ start: 80, end: 84 }],
      role: "workbook",
    });
    expect(workbook).toMatchObject({ kind: "pdf", role: "workbook" });

    const syllabus = LessonSource.parse({
      id: "src_syl",
      kind: "syllabus",
      title: "Clipboard_Screenshot.png",
      text: "4.1 Simple phenomena of magnetism",
      items: [
        "Describe the forces between magnetic poles and between magnets and magnetic materials",
        "Differentiate between magnetic and non-magnetic materials",
        "Draw and describe the pattern and direction of magnetic field lines around a bar magnet",
      ],
    });
    expect(syllabus.kind).toBe("syllabus");
    if (syllabus.kind === "syllabus") expect(syllabus.items).toHaveLength(3);

    const note = LessonSource.parse({
      id: "src_note",
      kind: "note",
      title: "Class note",
      text: "Emphasize right-hand grip rule misconceptions",
    });
    expect(note.kind).toBe("note");

    expect(
      LessonSource.safeParse({
        id: "bad_pdf",
        kind: "pdf",
        documentId: "doc_1",
        title: "Empty ranges",
        ranges: [],
        role: "textbook",
      }).success,
    ).toBe(false);

    const scope = LessonScope.parse({
      chapterIds: ["c16"],
      ranges: [{ start: 693, end: 726 }],
      sources: [textbook, pastPaper, syllabus],
    });
    expect(scope.sources).toHaveLength(3);
  });

  it("bijectively encodes and decodes multi-PDF virtual source pages with SOURCE_STRIDE = 100_000", () => {
    expect(SOURCE_STRIDE).toBe(100_000);
    expect(encodeSourcePage(0, 693)).toBe(693);
    expect(decodeSourcePage(693)).toEqual({ pdfIndex: 0, pageNo: 693 });

    expect(encodeSourcePage(1, 5)).toBe(100_005);
    expect(decodeSourcePage(100_005)).toEqual({ pdfIndex: 1, pageNo: 5 });

    expect(encodeSourcePage(2, 1)).toBe(200_001);
    expect(decodeSourcePage(200_001)).toEqual({ pdfIndex: 2, pageNo: 1 });

    expect(shortSourceTitle("Cambridge IGCSE Physics 3rd Edition Coursebook.pdf")).toBe("Cambridge IGCSE Physics…");
    expect(shortSourceTitle("真题卷 Paper 4")).toBe("真题卷 Paper 4");
  });
});
