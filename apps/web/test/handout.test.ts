import { describe, expect, it } from "vitest";
import type { Outline, Slide } from "@kj/schema";
import { CLASSROOM_FIXTURES } from "@kj/templates/testing/classroom";
import { buildHandoutDoc, compileHandoutDocx, compileHandoutHtml, readZip } from "../src/offline/handout/index.ts";

function makeIgcseMagnetismFixture(): {
  lesson: {
    title: string;
    grade: string;
    subject: string;
    minutes: number;
    level: "intermediate";
    lessonType: "new";
    language: "en+zh";
    pageRanges: [number, number][];
    pageLabels: Record<number, string>;
  };
  outline: Outline;
  slides: Slide[];
} {
  const outline: Outline = {
    objectives: [
      "Distinguish **hard** and **soft** magnetic materials using ==coercivity== concepts",
      "Use $\\Phi = B A$ and right-hand grip rule for **solenoids**",
      "Interpret electromagnet coil-turn data and solve exam-style problems",
    ],
    glossary: [
      { term: "solenoid", zh: "螺线管" },
      { term: "magnetic field lines", zh: "磁感线" },
      { term: "soft iron", zh: "软铁" },
    ],
    notCovered: [],
    slides: [
      {
        id: "s-cover",
        pageType: "cover",
        layout: "title",
        title: "Chapter 16: Magnetism 磁学",
        purpose: "Introduce syllabus goals",
        keyPoints: [],
        visual: "none",
        minutes: 1,
        sourcePages: [],
        loop: 0,
      },
      {
        id: "s-retrieval",
        pageType: "retrieval",
        layout: "questions",
        title: "Prior Knowledge Recall",
        purpose: "Activate prior knowledge",
        keyPoints: ["Magnetic poles"],
        visual: "none",
        minutes: 4,
        sourcePages: [694],
        loop: 0,
      },
      {
        id: "s-concept-1",
        pageType: "concept",
        layout: "statement",
        title: "Permanent Magnets vs Induced Magnetism",
        purpose: "Compare hard and soft magnetic materials",
        keyPoints: ["Steel vs soft iron"],
        visual: "table",
        minutes: 4,
        sourcePages: [698, 699],
        loop: 1,
      },
      {
        id: "s-process-1",
        pageType: "process",
        layout: "statement",
        title: "Field Around a Solenoid",
        purpose: "Explain solenoid field",
        keyPoints: ["Uniform internal field"],
        visual: "formula",
        minutes: 4,
        sourcePages: [708],
        loop: 1,
      },
      {
        id: "s-data-1",
        pageType: "data",
        layout: "chart",
        title: "Electromagnet Turns vs Paperclips Attracted",
        purpose: "Read experimental trend",
        keyPoints: ["Linear rise before saturation"],
        visual: "chart",
        minutes: 3,
        sourcePages: [712],
        loop: 1,
      },
      {
        id: "s-check-1",
        pageType: "check",
        layout: "quiz",
        title: "Check: Core Material Choice",
        purpose: "Diagnose steel vs soft iron misconception",
        keyPoints: ["Scrapyard crane core"],
        visual: "none",
        minutes: 2,
        sourcePages: [700],
        loop: 1,
      },
      {
        id: "s-worked",
        pageType: "worked",
        layout: "steps",
        title: "Worked Example: Magnetic Flux Calculation",
        purpose: "Model flux calculation",
        keyPoints: ["Use Phi = B A"],
        visual: "formula",
        minutes: 4,
        sourcePages: [714],
        loop: 2,
      },
      {
        id: "s-faded",
        pageType: "faded",
        layout: "steps",
        title: "Faded Practice: Double the Coil Area",
        purpose: "Student completes final calculation",
        keyPoints: ["Calculate new flux"],
        visual: "formula",
        minutes: 4,
        sourcePages: [715],
        loop: 2,
      },
      {
        id: "s-sequence",
        pageType: "sequence",
        layout: "order",
        title: "Match Magnetic Devices to Materials",
        purpose: "Match each application",
        keyPoints: ["Match pairs"],
        visual: "none",
        minutes: 3,
        sourcePages: [701],
        loop: 2,
      },
      {
        id: "s-practice",
        pageType: "practice",
        layout: "questions",
        title: "Exam-Style Questions",
        purpose: "Past-paper practice",
        keyPoints: ["Marks [1] and [2]"],
        visual: "none",
        minutes: 6,
        sourcePages: [720, 721],
        loop: 2,
      },
      {
        id: "s-summary",
        pageType: "summary",
        layout: "summary",
        title: "Chapter 16 Structure Summary",
        purpose: "Synthesize loops",
        keyPoints: ["Materials, fields, electromagnets"],
        visual: "none",
        minutes: 2.5,
        sourcePages: [718],
        loop: 0,
      },
      {
        id: "s-exit",
        pageType: "exit",
        layout: "questions",
        title: "Exit Ticket",
        purpose: "Check lesson objectives",
        keyPoints: [" Core & field direction"],
        visual: "none",
        minutes: 3,
        sourcePages: [724],
        loop: 0,
      },
    ],
  };

  const slides: Slide[] = [
    {
      id: "sl-cover",
      specId: "s-cover",
      outlineVersionId: "ov-1",
      layout: "title",
      pageType: "cover",
      minutes: 1,
      sources: [],
      notes: "Welcome G10 students and preview the practical crane video.",
      warnings: [],
      content: {
        layout: "title",
        title: "Chapter 16: Magnetism 磁学",
        subtitle: "IGCSE Physics 0625",
        objectives: outline.objectives,
      },
    },
    {
      id: "sl-retrieval",
      specId: "s-retrieval",
      outlineVersionId: "ov-1",
      layout: "questions",
      pageType: "retrieval",
      minutes: 4,
      sources: [694],
      notes: "Cold-call two students on pole interactions.",
      warnings: [],
      content: {
        layout: "questions",
        title: "Prior Knowledge Recall",
        items: [
          { q: "State the law of magnetic poles when two north poles approach. [1]", a: "RET-ANS-1: Like poles repel each other." },
        ],
      },
    },
    {
      id: "sl-concept-1",
      specId: "s-concept-1",
      outlineVersionId: "ov-1",
      layout: "statement",
      pageType: "concept",
      minutes: 4,
      sources: [698, 699],
      notes: "TEACHER-SCRIPT-CONCEPT: Emphasize that steel keeps magnetism permanently.",
      warnings: [],
      content: {
        layout: "statement",
        title: "Permanent Magnets vs Induced Magnetism",
        bullets: [
          "Steel is a ==hard magnetic material== used for permanent bar magnets.",
          "An iron nail placed near a pole becomes an **induced** magnet with **soft iron** behaviour.",
          "Field direction points from **North** to **South** along magnetic field lines outside the magnet.",
        ],
        visual: {
          kind: "table",
          caption: "Table 16.1 Magnetic materials comparison",
          columns: ["Material 材料", "Property 性质", "Typical Use 用途"],
          rows: [
            ["Steel 钢", "Hard magnetic", "==Permanent magnet=="],
            ["Soft iron 软铁", "Loses magnetism quickly", "==Electromagnet core=="],
          ],
        },
        terms: [
          { term: "hard magnetic material", zh: "硬磁性材料" },
          { term: "soft iron", zh: "软铁" },
        ],
      },
    },
    {
      id: "sl-process-1",
      specId: "s-process-1",
      outlineVersionId: "ov-1",
      layout: "statement",
      pageType: "process",
      minutes: 4,
      sources: [708],
      notes: "Demonstrate right-hand grip with $I$ and $B$.",
      warnings: [],
      content: {
        layout: "statement",
        title: "Field Around a Solenoid",
        bullets: [
          "Current $I$ flowing through a solenoid produces a uniform internal field $B$.",
          "Reversing current reverses the ==magnetic poles== of the coil.",
        ],
        visual: {
          kind: "formula",
          tex: "\\Phi = B A \\cos\\theta",
          caption: "Magnetic flux through area $A$",
        },
        terms: [{ term: "solenoid", zh: "螺线管" }],
      },
    },
    {
      id: "sl-data-1",
      specId: "s-data-1",
      outlineVersionId: "ov-1",
      layout: "chart",
      pageType: "data",
      minutes: 3,
      sources: [712],
      notes: "Point out saturation above 60 turns.",
      warnings: [],
      content: {
        layout: "chart",
        title: "Electromagnet Turns vs Paperclips Attracted",
        chart: {
          kind: "chart",
          type: "line",
          xLabel: "Number of turns N",
          yLabel: "Mass attracted m / g",
          categories: ["20", "40", "60"],
          series: [{ name: "Attracted mass / g", data: [12, 24, 35] }],
        },
        takeaways: [
          "Doubling turns from 20 to 40 doubles attracted mass to ==24 g==.",
        ],
        source: "Table 16.3 (p.712)",
      },
    },
    {
      id: "sl-check-1",
      specId: "s-check-1",
      outlineVersionId: "ov-1",
      layout: "quiz",
      pageType: "check",
      minutes: 2,
      sources: [700],
      notes: "Vote before revealing option B.",
      warnings: [],
      content: {
        layout: "quiz",
        question: "Why is soft iron used instead of steel for a scrapyard electromagnet core? [1]",
        options: [
          { text: "Steel cannot be magnetized by a current", misconception: "MISCONCEPTION-STEEL: Steel can be magnetized, it just stays magnetized when current stops." },
          { text: "Soft iron loses its magnetism as soon as current is switched off", misconception: "" },
          { text: "Soft iron conducts $I^2 R$ heat faster", misconception: "MISCONCEPTION-HEAT: Core choice is magnetic, not thermal." },
        ],
        answer: 1,
        explain: "QUIZ-RATIONALE-B: A scrapyard crane must release scrap steel when current $I = 0$ A.",
        poll: true,
      },
    },
    {
      id: "sl-worked",
      specId: "s-worked",
      outlineVersionId: "ov-1",
      layout: "steps",
      pageType: "worked",
      minutes: 4,
      sources: [714],
      notes: "Keep SI units $\\text{Wb}$ explicit.",
      warnings: [],
      content: {
        layout: "steps",
        title: "Worked Example: Magnetic Flux Calculation",
        problem: "A uniform field $B = 0.25\\text{ T}$ passes perpendicularly through a coil of area $A = 0.04\\text{ m}^2$. Calculate $\\Phi$.",
        steps: [
          { text: "Write the flux equation $\\Phi = B A$", why: "Field is perpendicular ($\\cos 0^\\circ = 1$)" },
          { text: "Substitute $\\Phi = 0.25 \\times 0.04$", why: "Insert SI values" },
          { text: "State $\\Phi = 0.01\\text{ Wb}$", why: "Include unit weber" },
        ],
      },
    },
    {
      id: "sl-faded",
      specId: "s-faded",
      outlineVersionId: "ov-1",
      layout: "steps",
      pageType: "faded",
      minutes: 4,
      sources: [715],
      notes: "Walk around checking unit conversion.",
      warnings: [],
      content: {
        layout: "steps",
        title: "Faded Practice: Double the Coil Area",
        problem: "For the same field $B = 0.25\\text{ T}$, the area increases to $A = 0.08\\text{ m}^2$. Find $\\Phi$.",
        steps: [
          { text: "Write $\\Phi = B A$", why: "Same perpendicular relation" },
          { text: "FADED-SECRET-STEP-2: $\\Phi = 0.25 \\times 0.08 = 0.02\\text{ Wb}$", why: "FADED-SECRET-WHY: Multiply and attach Wb" },
        ],
        fadeFrom: 1,
      },
    },
    {
      id: "sl-sequence",
      specId: "s-sequence",
      outlineVersionId: "ov-1",
      layout: "order",
      pageType: "sequence",
      minutes: 3,
      sources: [701],
      notes: "Have pairs compare match choices.",
      warnings: [],
      content: {
        layout: "order",
        title: "Match Magnetic Devices to Materials",
        mode: "match",
        items: [
          { text: "Compass needle 指南针", match: "Permanent steel 永磁钢" },
          { text: "Electric bell core 电铃铁芯", match: "Soft iron 软铁" },
          { text: "Magnetic shielding 磁屏蔽", match: "Soft ferromagnetic ring 软磁环" },
        ],
      },
    },
    {
      id: "sl-practice",
      specId: "s-practice",
      outlineVersionId: "ov-1",
      layout: "questions",
      pageType: "practice",
      minutes: 6,
      sources: [720, 721],
      notes: "Award 1 mark per distinct way of strengthening field.",
      warnings: [],
      content: {
        layout: "questions",
        title: "Exam-Style Questions",
        items: [
          {
            q: "State two ways to increase the magnetic field strength of a solenoid. [2]",
            a: "EXAM-ANS-Q1: (1) Increase current $I$; (2) Increase number of turns $N$ / insert a soft iron core.",
          },
          {
            q: "Describe how to plot magnetic field lines around a bar magnet using a plotting compass. [3]",
            a: "EXAM-ANS-Q2: Mark tip-to-tail dots from N to S and join with smooth curves.",
          },
        ],
      },
    },
    {
      id: "sl-summary",
      specId: "s-summary",
      outlineVersionId: "ov-1",
      layout: "summary",
      pageType: "summary",
      minutes: 2.5,
      sources: [718],
      notes: "Wrap up key contrasts.",
      warnings: [],
      content: {
        layout: "summary",
        title: "Chapter 16 Structure Summary",
        nodes: [
          { head: "Materials", detail: "Steel stays magnetized; ==soft iron== demagnetizes cleanly" },
          { head: "Electromagnets", detail: "Strength grows with $I$, turns $N$, and soft iron core" },
        ],
      },
    },
    {
      id: "sl-exit",
      specId: "s-exit",
      outlineVersionId: "ov-1",
      layout: "questions",
      pageType: "exit",
      minutes: 3,
      sources: [724],
      notes: "Collect exit slips at the door.",
      warnings: [],
      content: {
        layout: "questions",
        title: "Exit Ticket",
        items: [
          { q: "What happens to the poles of an electromagnet if battery terminals are reversed? [1]", a: "EXIT-ANS-1: North and South poles swap." },
        ],
      },
    },
  ];

  return {
    lesson: {
      title: "Chapter 16: Magnetism 磁学",
      grade: "G10 IGCSE",
      subject: "Physics 物理",
      minutes: 60,
      level: "intermediate",
      lessonType: "new",
      language: "en+zh",
      pageRanges: [[693, 726]],
      pageLabels: {},
    },
    outline,
    slides,
  };
}

function hasIllegalXmlControlChars(xml: string): boolean {
  for (let i = 0; i < xml.length; i++) {
    const c = xml.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return true;
  }
  return false;
}

/** Minimal strict XML well-formedness & tag balance checker for Node Vitest without external deps. */
function assertWellFormedXml(xml: string, label: string): void {
  expect(xml.startsWith("<?xml"), `${label}: XML declaration`).toBe(true);
  // No illegal XML 1.0 control characters or unescaped ampersands
  expect(hasIllegalXmlControlChars(xml), `${label}: illegal control chars`).toBe(false);
  expect(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(xml), `${label}: unescaped &`).toBe(false);

  const withoutDecl = xml.replace(/^<\?xml[^?]*\?>\s*/, "").replace(/<!--[\s\S]*?-->/g, "");
  const tagRe = /<\/?([A-Za-z_][\w:.-]*)(\s[^<>]*?)?(\/?)>/g;
  const stack: string[] = [];
  let cursor = 0;
  for (const m of withoutDecl.matchAll(tagRe)) {
    const between = withoutDecl.slice(cursor, m.index);
    expect(between.includes("<") || between.includes(">"), `${label}: stray < or > near ${between.slice(0, 40)}`).toBe(false);
    cursor = m.index! + m[0].length;
    const [, name, , selfClose] = m;
    if (m[0].startsWith("</")) {
      const top = stack.pop();
      expect(top, `${label}: closing </${name}> matches <${top}>`).toBe(name);
    } else if (!selfClose) {
      stack.push(name!);
    }
  }
  const trailing = withoutDecl.slice(cursor);
  expect(trailing.includes("<") || trailing.includes(">"), `${label}: trailing < or >`).toBe(false);
  expect(stack, `${label}: unclosed tags`).toEqual([]);
}

function extractDocxText(documentXml: string): string {
  return [...documentXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((m) =>
      m[1]!
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&"),
    )
    .join("");
}

describe("Handout deterministic model (`model.ts`)", () => {
  it("builds all 5 sections for teacher copy and omits Teacher Answer Key + blanks highlights/glossary terms in student copy", () => {
    const fixture = makeIgcseMagnetismFixture();
    const studentDoc = buildHandoutDoc({ ...fixture, copy: "student" });
    const teacherDoc = buildHandoutDoc({ ...fixture, copy: "teacher" });

    // 1. Header & Syllabus / Learning Objectives Checklist + bilingual glossary
    expect(studentDoc.header.title).toBe("Chapter 16: Magnetism 磁学");
    expect(studentDoc.header.grade).toBe("G10 IGCSE");
    expect(studentDoc.header.subject).toBe("Physics 物理");
    expect(studentDoc.header.duration).toContain("60");
    expect(studentDoc.header.objectives).toHaveLength(3);
    expect(studentDoc.header.glossary).toEqual(fixture.outline.glossary);

    // 2. Guided Notes: student blanks both explicit ==...== and fallback glossary terms when no ==...== exists
    expect(studentDoc.guidedNotes.length).toBeGreaterThanOrEqual(2);
    const loop1Student = studentDoc.guidedNotes.find((g) => g.loop === 1)!;
    const loop1Teacher = teacherDoc.guidedNotes.find((g) => g.loop === 1)!;
    expect(loop1Student).toBeDefined();
    expect(loop1Teacher).toBeDefined();

    // Explicit ==hard magnetic material== becomes blank in student, red-bold highlight in teacher
    const firstBulletStudent = loop1Student.blocks[0]!.bullets[0]!;
    expect(firstBulletStudent.some((r) => r.kind === "blank")).toBe(true);
    expect(firstBulletStudent.map((r) => (r.kind === "text" ? r.text : "")).join("")).not.toContain("hard magnetic material");

    const firstBulletTeacher = loop1Teacher.blocks[0]!.bullets[0]!;
    expect(firstBulletTeacher.some((r) => r.kind === "text" && r.text === "hard magnetic material" && r.bold && r.highlight)).toBe(true);

    // Fallback glossary blanking when bullet has NO ==...== (e.g. "magnetic field lines" or "solenoid")
    const thirdBulletStudent = loop1Student.blocks[0]!.bullets[2]!;
    expect(thirdBulletStudent.some((r) => r.kind === "blank")).toBe(true);
    const solenoidBulletStudent = loop1Student.blocks[1]!.bullets[0]!;
    expect(solenoidBulletStudent.some((r) => r.kind === "blank")).toBe(true);

    // Misconception explanations included in teacher Guided Notes only, never in student
    expect(loop1Student.misconceptions).toEqual([]);
    expect(loop1Teacher.misconceptions.length).toBeGreaterThan(0);

    // Table widget & Chart data table both extracted cleanly
    expect(loop1Student.blocks[0]!.tables).toHaveLength(1);
    const chartBlock = loop1Student.blocks.find((b) => b.titleText.includes("Electromagnet Turns"))!;
    expect(chartBlock.tables).toHaveLength(1);
    expect(chartBlock.tables[0]!.rows).toHaveLength(3);

    // 3. Worked & Faded Examples
    expect(studentDoc.examples).toHaveLength(2);
    const studentFaded = studentDoc.examples.find((e) => e.kind === "faded")!;
    const teacherFaded = teacherDoc.examples.find((e) => e.kind === "faded")!;
    expect(studentFaded.steps[0]!.hiddenInStudent).toBe(false);
    expect(studentFaded.steps[1]!.hiddenInStudent).toBe(true);
    expect(teacherFaded.steps[1]!.runs.some((r) => r.kind !== "blank" && r.highlight)).toBe(true);

    // 4. Check & Exam-Style Practice: retrieval + check + sequence(match) + practice + exit
    expect(studentDoc.practices.length).toBeGreaterThanOrEqual(6);
    const examQ1 = studentDoc.practices.find((q) => q.marks === "[2]")!;
    expect(examQ1).toBeDefined();
    expect(examQ1.ruledLines).toBeGreaterThanOrEqual(2);
    const matchQ = studentDoc.practices.find((q) => q.kind === "match")!;
    expect(matchQ.matchPairs).toHaveLength(3);
    // Right-hand match column is deterministically shuffled so student copy doesn't leak 1-to-1 order
    expect(matchQ.matchRightOrder).not.toEqual([0, 1, 2]);

    // 5. Teacher Answer Key & Notes
    expect(studentDoc.answerKey).toBeNull();
    expect(teacherDoc.answerKey).not.toBeNull();
    expect(teacherDoc.answerKey!.length).toBeGreaterThanOrEqual(5);
  });
});

describe("Handout A4 Print HTML compiler (`html.ts`)", () => {
  it("renders standalone A4 print HTML with KaTeX math, print button, zero raw markdown/math leaks, and strict student/teacher separation", () => {
    const fixture = makeIgcseMagnetismFixture();
    const studentHtml = compileHandoutHtml(buildHandoutDoc({ ...fixture, copy: "student" }));
    const teacherHtml = compileHandoutHtml(buildHandoutDoc({ ...fixture, copy: "teacher" }));

    for (const [label, html] of [
      ["student", studentHtml],
      ["teacher", teacherHtml],
    ] as const) {
      expect(html, label).toContain("@page { size: A4; margin: 16mm");
      expect(html, label).toContain("@media print");
      expect(html, label).toContain("window.print()");
      expect(html, label).toContain("打印 / 另存为 PDF · Print / Save PDF");
      expect(html, label).toContain('class="katex"');
      // Standalone: zero external scripts/stylesheets/images
      expect(html, label).not.toMatch(/<(script|link|img|iframe)[^>]+(src|href)=["']?https?:/i);
      expect(html, label).not.toContain("url(fonts/KaTeX_");
      // Checkboxes & all core sections
      expect(html, label).toContain("☐");
      expect(html, label).toContain("导学笔记 · Guided Notes");
      expect(html, label).toContain("例题示范与演练 · Worked Examples");
      expect(html, label).toContain("随堂测验与配套真题 · Practice Questions");
      // Mark badges preserved
      expect(html, label).toContain("[1]");
      expect(html, label).toContain("[2]");
      // Zero raw == / ** / $...$ leaks in visible body markup
      const bodyOnly = html.split("<body>")[1]!;
      expect(bodyOnly, `${label} raw ==`).not.toContain("==");
      expect(bodyOnly, `${label} raw **`).not.toContain("**");
      expect(bodyOnly, `${label} raw $`).not.toContain("$");
    }

    // Student copy: blanks present, zero teacher answers/rationales/misconceptions/notes
    expect(studentHtml).toContain("____________");
    expect(studentHtml).not.toContain("教师参考答案与讲评要点");
    for (const secret of [
      "hard magnetic material",
      "Permanent magnet",
      "Electromagnet core",
      "RET-ANS-1",
      "TEACHER-SCRIPT-CONCEPT",
      "MISCONCEPTION-STEEL",
      "MISCONCEPTION-HEAT",
      "QUIZ-RATIONALE-B",
      "FADED-SECRET-STEP-2",
      "FADED-SECRET-WHY",
      "EXAM-ANS-Q1",
      "EXAM-ANS-Q2",
      "EXIT-ANS-1",
    ]) {
      expect(studentHtml).not.toContain(secret);
    }

    // Teacher copy: red-bold #C81E1E highlights, dedicated page-break Answer Key, all answers & notes present
    expect(teacherHtml.toUpperCase()).toContain("#C81E1E");
    expect(teacherHtml).toContain("教师参考答案与讲评要点");
    expect(teacherHtml).toContain("ho-page-break");
    for (const expected of [
      "hard magnetic material",
      "RET-ANS-1",
      "TEACHER-SCRIPT-CONCEPT",
      "MISCONCEPTION-STEEL",
      "QUIZ-RATIONALE-B",
      "FADED-SECRET-STEP-2",
      "EXAM-ANS-Q1",
      "EXIT-ANS-1",
    ]) {
      expect(teacherHtml).toContain(expected);
    }
  });
});

describe("Handout Editable OOXML `.docx` compiler (`docx.ts` + `zip.ts`)", () => {
  it("builds a valid A4 .docx zip with clean XML, bordered tables, Unicode math, student blanks vs teacher #C81E1E red-bold runs, and page break before Answer Key", () => {
    const fixture = makeIgcseMagnetismFixture();
    const studentBytes = compileHandoutDocx(buildHandoutDoc({ ...fixture, copy: "student" }));
    const teacherBytes = compileHandoutDocx(buildHandoutDoc({ ...fixture, copy: "teacher" }));

    for (const [label, bytes] of [
      ["student", studentBytes],
      ["teacher", teacherBytes],
    ] as const) {
      expect(bytes[0]).toBe(0x50); // 'P'
      expect(bytes[1]).toBe(0x4b); // 'K'
      const entries = readZip(bytes);
      for (const required of [
        "[Content_Types].xml",
        "_rels/.rels",
        "word/document.xml",
        "word/_rels/document.xml.rels",
        "word/styles.xml",
      ]) {
        expect(entries.has(required), `${label} missing ${required}`).toBe(true);
        const xml = new TextDecoder().decode(entries.get(required)!);
        assertWellFormedXml(xml, `${label}:${required}`);
      }

      const docXml = new TextDecoder().decode(entries.get("word/document.xml")!);
      // A4 page size (11906 x 16838 twips)
      expect(docXml).toContain('<w:pgSz w:w="11906" w:h="16838"');
      // Bordered tables
      expect(docXml).toContain("<w:tbl>");
      expect(docXml).toContain("<w:tblBorders>");
      // Unicode math conversion (Phi = B A cos theta, m^2, I^2 R) and zero raw $ / == / ** leaks
      const plainText = extractDocxText(docXml);
      expect(plainText, `${label} Unicode Phi`).toContain("Φ");
      expect(plainText, `${label} Unicode superscript`).toContain("m²");
      expect(plainText, `${label} checkbox`).toContain("☐");
      expect(plainText, `${label} Guided Notes`).toContain("导学笔记 · Guided Notes");
      expect(plainText, `${label} Worked Examples`).toContain("例题示范与演练 · Worked Examples");
      expect(plainText, `${label} Practice Questions`).toContain("随堂测验与配套真题 · Practice Questions");
      expect(plainText, `${label} mark [1]`).toContain("[1]");
      expect(plainText, `${label} mark [2]`).toContain("[2]");
      expect(plainText, `${label} raw $`).not.toContain("$");
      expect(plainText, `${label} raw ==`).not.toContain("==");
      expect(plainText, `${label} raw **`).not.toContain("**");
    }

    const studentXml = new TextDecoder().decode(readZip(studentBytes).get("word/document.xml")!);
    const studentText = extractDocxText(studentXml);
    expect(studentText).toContain("____________");
    expect(studentText).not.toContain("教师参考答案与讲评要点");
    expect(studentXml).not.toContain('w:val="C81E1E"');
    for (const secret of [
      "RET-ANS-1",
      "TEACHER-SCRIPT-CONCEPT",
      "MISCONCEPTION-STEEL",
      "QUIZ-RATIONALE-B",
      "FADED-SECRET-STEP-2",
      "FADED-SECRET-WHY",
      "EXAM-ANS-Q1",
      "EXIT-ANS-1",
    ]) {
      expect(studentText).not.toContain(secret);
    }

    const teacherXml = new TextDecoder().decode(readZip(teacherBytes).get("word/document.xml")!);
    const teacherText = extractDocxText(teacherXml);
    // Teacher red-bold runs: w:b + w:color w:val="C81E1E"
    expect(teacherXml).toContain("<w:b/>");
    expect(teacherXml).toContain('<w:color w:val="C81E1E"/>');
    // Dedicated page break before Teacher Answer Key
    const answerHeadingIdx = teacherXml.indexOf("教师参考答案与讲评要点");
    expect(answerHeadingIdx).toBeGreaterThan(0);
    const beforeHeading = teacherXml.slice(Math.max(0, answerHeadingIdx - 400), answerHeadingIdx);
    expect(beforeHeading).toContain('<w:br w:type="page"/>');
    for (const expected of [
      "hard magnetic material",
      "RET-ANS-1",
      "TEACHER-SCRIPT-CONCEPT",
      "MISCONCEPTION-STEEL",
      "QUIZ-RATIONALE-B",
      "FADED-SECRET-STEP-2",
      "EXAM-ANS-Q1",
      "EXIT-ANS-1",
    ]) {
      expect(teacherText).toContain(expected);
    }
  });

  it("never leaks any CLASSROOM_FIXTURES teacher-only canary into student HTML or .docx across EN and ZH lessons", () => {
    for (const fixture of CLASSROOM_FIXTURES) {
      const slides: Slide[] = fixture.slides.map((s) => ({
        id: `sl-${s.specId}`,
        specId: s.specId,
        outlineVersionId: "ov-fixture",
        layout: s.content.layout,
        pageType: s.pageType,
        minutes: 3,
        content: s.content,
        notes: s.notes,
        sources: s.sources,
        warnings: [],
      }));
      const studentDoc = buildHandoutDoc({
        lesson: { title: fixture.title, params: fixture.params },
        outline: fixture.outline,
        slides,
        copy: "student",
      });
      const teacherDoc = buildHandoutDoc({
        lesson: { title: fixture.title, params: fixture.params },
        outline: fixture.outline,
        slides,
        copy: "teacher",
      });

      const studentHtml = compileHandoutHtml(studentDoc);
      const studentDocxText = extractDocxText(new TextDecoder().decode(readZip(compileHandoutDocx(studentDoc)).get("word/document.xml")!));
      const teacherHtml = compileHandoutHtml(teacherDoc);
      const teacherDocxText = extractDocxText(new TextDecoder().decode(readZip(compileHandoutDocx(teacherDoc)).get("word/document.xml")!));

      for (const canary of fixture.oracle.teacherOnlyCanaries) {
        expect(studentHtml, `${fixture.id} student HTML canary ${canary}`).not.toContain(canary);
        expect(studentDocxText, `${fixture.id} student DOCX canary ${canary}`).not.toContain(canary);
        expect(teacherHtml, `${fixture.id} teacher HTML canary ${canary}`).toContain(canary);
        expect(teacherDocxText, `${fixture.id} teacher DOCX canary ${canary}`).toContain(canary);
      }
    }
  });

  it("sanitizes XML entities, stray markdown/math delimiters, flow/function widgets, and order-mode slides cleanly", () => {
    const outline: Outline = {
      objectives: ["Analyze $y = A\\sin(kx) < 5$ & **energy**"],
      glossary: [],
      notCovered: [],
      slides: [
        { id: "p1", pageType: "concept", layout: "statement", title: "Flow & <Angles> \"Test\"", purpose: "", keyPoints: [], visual: "flow", minutes: 3, sourcePages: [1], loop: 1 },
        { id: "p2", pageType: "sequence", layout: "order", title: "Put wave steps in order", purpose: "", keyPoints: [], visual: "none", minutes: 3, sourcePages: [1], loop: 1 },
      ],
    };
    const slides: Slide[] = [
      {
        id: "sl-p1",
        specId: "p1",
        outlineVersionId: "ov-x",
        layout: "statement",
        pageType: "concept",
        minutes: 3,
        sources: [1],
        notes: "Check stray ** and == and $ symbols & <tags>.",
        warnings: [],
        content: {
          layout: "statement",
          title: "Flow & <Angles> \"Test\"",
          bullets: ["Unmatched **star and ==eq with $x < y & z > 0$"],
          visual: { kind: "flow", steps: ["Source **vibrates**", "Medium ==oscillates==", "Energy $E_k$ transfers"] },
          terms: [],
        },
      },
      {
        id: "sl-p2",
        specId: "p2",
        outlineVersionId: "ov-x",
        layout: "order",
        pageType: "sequence",
        minutes: 3,
        sources: [1],
        notes: "",
        warnings: [],
        content: {
          layout: "order",
          title: "Put wave steps in order",
          mode: "order",
          items: [
            { text: "Pluck string", match: "" },
            { text: "Pulse travels", match: "" },
            { text: "Fixed end reflects", match: "" },
          ],
        },
      },
    ];

    for (const copy of ["student", "teacher"] as const) {
      const doc = buildHandoutDoc({ lesson: { title: "Edge & <XML> Test", minutes: 40 }, outline, slides, copy });
      const html = compileHandoutHtml(doc);
      const bodyOnly = html.split("<body>")[1]!;
      expect(bodyOnly).not.toContain("==");
      expect(bodyOnly).not.toContain("**");
      expect(bodyOnly).not.toContain("$");

      const entries = readZip(compileHandoutDocx(doc));
      const docXml = new TextDecoder().decode(entries.get("word/document.xml")!);
      const stylesXml = new TextDecoder().decode(entries.get("word/styles.xml")!);
      assertWellFormedXml(docXml, `${copy}:edge:document.xml`);
      assertWellFormedXml(stylesXml, `${copy}:edge:styles.xml`);
      const text = extractDocxText(docXml);
      expect(text).not.toContain("$");
      expect(text).not.toContain("==");
      expect(text).not.toContain("**");
      expect(text).toContain("Flow & <Angles> \"Test\"");
    }
  });
});
