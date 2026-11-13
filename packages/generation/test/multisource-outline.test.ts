import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, encodeSourcePage, type LessonSource } from "@kj/schema";
import { fakeAi } from "../../ai/test/fake.ts";
import { buildMessages, draftOutline } from "../src/outline.ts";

describe("multi-source outline prompt, virtual page citations & syllabus checklist", () => {
  const sources: LessonSource[] = [
    {
      id: "src_1",
      kind: "pdf",
      documentId: "doc_tb",
      title: "Cambridge IGCSE Physics Coursebook",
      ranges: [{ start: 693, end: 694 }],
      role: "textbook",
    },
    {
      id: "src_2",
      kind: "pdf",
      documentId: "doc_pp",
      title: "0625_s25_qp_42 Past Paper",
      ranges: [{ start: 5, end: 6 }],
      role: "past_paper",
    },
    {
      id: "src_syl",
      kind: "syllabus",
      title: "Clipboard_Screenshot.png",
      text: "4.1 Simple phenomena of magnetism",
      items: [
        "State the properties of magnets and distinguish magnetic vs non-magnetic materials",
        "Describe how to plot magnetic field lines with a plotting compass",
      ],
    },
  ];

  const multiPages = [
    { no: 693, text: "Chapter 16 Magnetism: Like poles repel and unlike poles attract. Iron, steel, nickel and cobalt are magnetic." },
    { no: 694, text: "16.2 Magnetic fields: Plotting compasses show field direction from North pole to South pole." },
    { no: encodeSourcePage(1, 5), label: "0625_s25_qp_42 p.5", text: "Question 5 [3 marks]: A bar magnet is placed near a soft-iron rod. Explain why the rod is attracted." },
    { no: encodeSourcePage(1, 6), label: "0625_s25_qp_42 p.6", text: "Question 6 [2 marks]: Sketch magnetic field lines around a solenoid carrying direct current." },
  ];

  it("formats [S1 p.693] and [S2 p.5] source boundaries, past-paper guidance, 1500-char focus, and syllabus checklist", () => {
    const longFocus = "重点知识用红色字体加粗，文字精简30号字左右，知识点配真题，每隔15分钟左右学生有做题或者活动时间。".repeat(8);
    expect(longFocus.length).toBeGreaterThan(200);

    const [sys, usr] = buildMessages({
      lessonTitle: "Chapter 16 Magnetism",
      params: { ...DEFAULT_PARAMS, minutes: 60, focus: longFocus },
      sections: [{ title: "16 Magnetism", pageStart: 693, pageEnd: 694 }],
      pages: multiPages,
      sources,
      ctx: { orgId: "org_1", userId: "usr_1" },
    });

    expect(sys!.content).toContain(longFocus);
    expect(sys!.content).toContain("past_paper");
    expect(usr!.content).toContain("Syllabus checklist");
    expect(usr!.content).toContain("State the properties of magnets");
    expect(usr!.content).toContain("Describe how to plot magnetic field lines");
    expect(usr!.content).toContain("[S1 p.693]");
    expect(usr!.content).toContain("[S2 p.5");
    expect(usr!.content.trimEnd().endsWith("</source>")).toBe(true);
  });

  it("validates sourcePages across all attached PDFs, resolves unambiguous secondary page numbers, and flags invalid ones", async () => {
    const modelOutput = {
      objectives: ["State magnet properties and plot magnetic field lines"],
      slides: [
        { pageType: "cover", title: "Magnetism and Magnetic Fields", minutes: 1, visual: "none", loop: 0, sourcePages: [] },
        { pageType: "retrieval", title: "Forces Recap", minutes: 4, visual: "none", loop: 0, sourcePages: [693] },
        { pageType: "concept", title: "Like poles repel and unlike poles attract", minutes: 5, visual: "table", loop: 1, keyPoints: ["Iron steel magnetic"], sourcePages: [693] },
        { pageType: "check", title: "Check magnetic materials", minutes: 3, visual: "none", loop: 1, keyPoints: ["Iron vs copper"], sourcePages: [693] },
        { pageType: "concept", title: "Compasses trace field lines from N to S", minutes: 5, visual: "flow", loop: 2, keyPoints: ["Compass needle aligns"], sourcePages: [694] },
        // Model cites virtual page 100005 directly on one slide and shorthand 6 on the next:
        { pageType: "practice", title: "Past-paper induced magnetism question", minutes: 8, visual: "none", loop: 2, keyPoints: ["Soft-iron rod attraction [3]"], sourcePages: [100_005] },
        { pageType: "practice", title: "Solenoid field exam question", minutes: 8, visual: "none", loop: 2, keyPoints: ["Solenoid field sketch [2]"], sourcePages: [6] },
        // Model cites out-of-range page 999:
        { pageType: "summary", title: "Magnetism key ideas", minutes: 3, visual: "none", loop: 0, keyPoints: ["Poles and fields"], sourcePages: [999] },
        { pageType: "exit", title: "Exit ticket", minutes: 3, visual: "none", loop: 0, keyPoints: ["Final check"], sourcePages: [694, 100_006] },
      ],
      glossary: [{ term: "magnetic field", zh: "磁场" }],
      notCovered: [],
    };

    const fake = fakeAi([modelOutput]);
    const res = await draftOutline(fake.ai, {
      lessonTitle: "Chapter 16 Magnetism",
      params: { ...DEFAULT_PARAMS, minutes: 40 },
      sections: [{ title: "16 Magnetism", pageStart: 693, pageEnd: 694 }],
      pages: multiPages,
      sources,
      ctx: { orgId: "org_1", userId: "usr_1" },
      options: { outlineCheckRetry: false },
    });

    const p1 = res.outline.slides.find((s) => s.title.includes("Past-paper induced"))!;
    expect(p1.sourcePages).toEqual([100_005]);
    expect(p1.sourceIssue).toBeUndefined();

    const p2 = res.outline.slides.find((s) => s.title.includes("Solenoid field"))!;
    expect(p2.sourcePages).toEqual([100_006]);
    expect(p2.sourceIssue).toBeUndefined();

    const bad = res.outline.slides.find((s) => s.title.includes("Magnetism key ideas"))!;
    expect(bad.sourceIssue).toMatchObject({ kind: "out-of-range", cited: [999] });
  });
});
