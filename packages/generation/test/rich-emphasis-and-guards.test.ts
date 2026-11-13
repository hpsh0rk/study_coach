import { describe, expect, it } from "vitest";
import { countHighlightedWords, countWords, DEFAULT_PARAMS, type Outline, type SlideContent, type SlideSpec } from "@kj/schema";
import { SLOT_SCHEMAS } from "@kj/templates";
import { fakeAi } from "../../ai/test/fake.ts";
import { applyGlossary, buildSlideMessages, clipToBudgets, problemsOf, sanitizeWidgets, writeSlide, type WriteInput } from "../src/index.ts";

const spec: SlideSpec = {
  id: "sp13",
  pageType: "data",
  layout: "chart",
  title: "Electromagnet strength increases with coil turns",
  purpose: "Analyse Table 16.3 turns vs attracted mass",
  keyPoints: ["20 turns attracts 12 g", "80 turns attracts 48 g"],
  visual: "chart",
  minutes: 3,
  sourcePages: [16],
  loop: 2,
};

const outline: Outline = {
  objectives: ["Describe magnetic fields and electromagnets"],
  slides: [spec],
  glossary: [
    { term: "magnetic field lines", zh: "磁感线" },
    { term: "Newton's second law", zh: "牛顿第二定律" },
  ],
  notCovered: [],
};

const pages = [{ no: 16, text: "Table 16.3: 20 turns attracts 12 g, 40 turns attracts 24 g, 60 turns attracts 36 g, 80 turns attracts 48 g." }];
const makeInput = (overrides: Partial<WriteInput> = {}): WriteInput => ({
  lessonTitle: "Chapter 16 Magnetism",
  params: DEFAULT_PARAMS,
  pages,
  ctx: { orgId: "o", userId: "u" },
  ...overrides,
});

function assertBalancedRichMarkers(text: string): void {
  const withoutMath = text.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+\$/g, "");
  const eqPairs = withoutMath.match(/==/g)?.length ?? 0;
  const boldPairs = withoutMath.match(/\*\*/g)?.length ?? 0;
  expect(eqPairs % 2, `unbalanced == in "${text}"`).toBe(0);
  expect(boldPairs % 2, `unbalanced ** in "${text}"`).toBe(0);
  expect(withoutMath).not.toMatch(/(?<!=)=(?:$|\s)|(?:^|\s)=(?!=)/);
}

describe("clipToBudgets rich-marker & en+zh safety", () => {
  it("never slices mid-marker leaving unclosed == or ** across English, Chinese, clause cuts, and math", () => {
    const slide: SlideContent = {
      layout: "statement",
      title: "Permanent magnets and ==magnetic field lines==",
      bullets: [
        "Steel is a ==hard magnetic material that retains magnetism permanently after magnetisation==",
        "合力决定 ==加速度大小，并且方向始终与合外力完全一致==",
        "物体加速度方向始终保持==合外力方向完全一致==",
      ],
      visual: { kind: "formula", tex: "F = ma", caption: "" },
      terms: [{ term: "**magnetic field**", zh: "磁场" }],
    };

    const clipped = clipToBudgets(slide);
    expect(SLOT_SCHEMAS.statement.safeParse(clipped).success).toBe(true);
    if (clipped.layout !== "statement") throw new Error("layout");
    assertBalancedRichMarkers(clipped.title);
    for (const b of clipped.bullets) {
      assertBalancedRichMarkers(b);
      expect(b).toContain("==");
    }
  });

  it("drops redundant trailing Chinese clause translations in en+zh instead of leaving chopped fragments like '钢是'", () => {
    const bilingualOverBudget: SlideContent = {
      layout: "statement",
      title: "Hard vs soft magnetic materials",
      bullets: [
        "Steel is a hard magnetic material 钢是一种硬磁性材料移开后仍保持磁性",
        "Field arrows point north to south 箭头指向从北极到南极",
      ],
      visual: { kind: "placeholder", hint: "Bar magnet field lines" },
      terms: [{ term: "magnetic field lines", zh: "磁感线" }],
    };
    const clipped = clipToBudgets(bilingualOverBudget);
    expect(SLOT_SCHEMAS.statement.safeParse(clipped).success).toBe(true);
    if (clipped.layout !== "statement") throw new Error("layout");
    expect(clipped.bullets[0]).toBe("Steel is a hard magnetic material");
    expect(clipped.bullets[1]).toBe("Field arrows point north to south");
    for (const b of clipped.bullets) {
      expect(b).not.toMatch(/钢是$|箭头指$/);
    }
  });

  it("accepts 6-char Chinese physics terms like '牛顿第二定律' without deadlocking BROKEN_PHYSICS_COMPOUND", () => {
    const statementSpec: SlideSpec = { ...spec, id: "sp2", pageType: "concept", layout: "statement", visual: "formula" };
    const raw: SlideContent = {
      layout: "statement",
      title: "牛顿第二定律揭示力与加速度关系",
      bullets: ["加速度与合外力成正比"],
      visual: { kind: "formula", tex: "F = ma", caption: "" },
      terms: [{ term: "Newton's second law", zh: "牛顿第二定律" }],
    };
    const withGlossary = applyGlossary(raw, outline.glossary, "zh");
    expect(withGlossary.layout === "statement" && withGlossary.terms).toEqual([{ term: "牛顿第二定律", zh: "" }]);
    const clipped = clipToBudgets(withGlossary);
    expect(SLOT_SCHEMAS.statement.safeParse(clipped).success).toBe(true);
    expect(clipped.layout === "statement" && clipped.terms[0]!.term).toBe("牛顿第二定律");

    // Also ensure 3-word slots like steps[].why never deadlock if they end in 牛顿第二定律
    const stepsSlide: SlideContent = {
      layout: "steps",
      title: "求物体加速度",
      problem: "质量 2 kg 受 10 N 合力，求加速度。",
      steps: [
        { text: "写出 $F = ma$", why: "根据牛顿第二定律" },
        { text: "$a = 5$ m/s²", why: "代入计算" },
      ],
    };
    const clippedSteps = clipToBudgets(stepsSlide);
    expect(SLOT_SCHEMAS.steps.safeParse(clippedSteps).success).toBe(true);
    void statementSpec;
  });
});

describe("chart.focus self-healing & slide prompt guards", () => {
  it("deletes out-of-range chart.focus (< 0 or >= series.length) in sanitizeWidgets and writeSlide instead of replacing with 图示待补", async () => {
    const table163Chart: SlideContent = {
      layout: "chart",
      title: "More turns attract greater mass of pins",
      chart: {
        kind: "chart",
        type: "bar",
        xLabel: "Number of turns",
        yLabel: "Mass attracted / g",
        categories: ["20", "40", "60", "80"],
        series: [{ name: "Mass / g", data: [12, 24, 36, 48] }],
        focus: 3,
      },
      takeaways: ["==Mass doubles== when turns double", "Linear trend from 20 to 80 turns"],
      source: "Table 16.3 (p.16)",
    };

    const sanitized = sanitizeWidgets(table163Chart);
    expect(sanitized.replaced).toEqual([]);
    expect(sanitized.content.layout === "chart" && sanitized.content.chart.kind).toBe("chart");
    if (sanitized.content.layout !== "chart" || sanitized.content.chart.kind !== "chart") throw new Error("expected chart");
    expect("focus" in sanitized.content.chart).toBe(false);
    expect(problemsOf(sanitized.content).errors).toEqual([]);

    // Negative focus on statement chart visual also heals cleanly
    const negFocusStatement: SlideContent = {
      layout: "statement",
      title: "Turns vs mass",
      bullets: ["Proportional increase"],
      visual: {
        kind: "chart",
        type: "line",
        xLabel: "Turns",
        yLabel: "Mass / g",
        categories: ["20", "40"],
        series: [{ name: "Mass", data: [12, 24] }],
        focus: -1,
      },
      terms: [],
    };
    const healedNeg = sanitizeWidgets(negFocusStatement);
    expect(healedNeg.replaced).toEqual([]);
    expect(healedNeg.content.layout === "statement" && healedNeg.content.visual.kind === "chart" && healedNeg.content.visual.focus).toBeUndefined();

    // End-to-end writeSlide preserves the chart in 1 turn without wasting retry or falling back to 图示待补
    const ai = fakeAi([{ content: table163Chart, notes: "Point out the linear relationship in Table 16.3. Ask: what mass at 100 turns? (~60 g). 3 min." }]);
    const written = await writeSlide(ai.ai, outline, "sp13", makeInput());
    expect(ai.requests).toHaveLength(1);
    expect(written.content.layout === "chart" && written.content.chart.kind).toBe("chart");
    expect(written.warnings.some((w) => w.includes("图示待补"))).toBe(false);
    expect(written.unverified).toEqual([]);
  });

  it("steers ==...== emphasis and en+zh concise English + noun parentheses in buildMessages, and trims red walls in writeSlide", async () => {
    const enZhSys = buildSlideMessages(
      spec,
      makeInput({ params: { ...DEFAULT_PARAMS, language: "en+zh", focus: "重点知识用红色字体加粗，文字精简" } }),
      outline,
    )[0]!.content;
    expect(enZhSys).toContain("==");
    expect(enZhSys).toContain("(磁感线)");
    expect(enZhSys).toMatch(/never append whole-clause Chinese/i);
    expect(enZhSys).toMatch(/Teacher emphasis preference/i);

    // Whole-slide red wall from model gets toned down so <= 25% (or <= 4 words) stay highlighted
    const statementSpec: SlideSpec = { ...spec, id: "sp2", pageType: "concept", layout: "statement", visual: "none" };
    const redWallReply = {
      content: {
        layout: "statement" as const,
        title: "==Magnetic fields surround permanent magnets==",
        bullets: [
          "==Field lines run north to south==",
          "==Closer lines mean stronger field==",
          "==Steel stays magnetised permanently==",
        ],
        visual: { kind: "placeholder" as const, hint: "Bar magnet field lines" },
        terms: [],
      },
      notes: "Ask students which pole a compass points toward. 3 min.",
    };
    const res = await writeSlide(fakeAi([redWallReply]).ai, { ...outline, slides: [statementSpec] }, "sp2", makeInput());
    if (res.content.layout !== "statement") throw new Error("layout");
    const allTexts = [res.content.title, ...res.content.bullets];
    const total = allTexts.reduce((n, s) => n + countWords(s), 0);
    const highlighted = allTexts.reduce((n, s) => n + countHighlightedWords(s), 0);
    expect(highlighted).toBeGreaterThan(0);
    expect(highlighted).toBeLessThanOrEqual(Math.max(4, Math.ceil(total * 0.25)));
  });
});
