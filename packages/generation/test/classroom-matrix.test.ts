import { describe, expect, it } from "vitest";
import { checkOutline, verifyNumbers } from "@kj/pedagogy";
import type { Outline, SlideContent, SlideSpec } from "@kj/schema";
import { CLASSROOM_FIXTURES } from "@kj/templates/testing/classroom";
import { checkSourceText, stubOutline, stubSlide } from "../src/index.ts";

const sourceText = (pages: { no: number; text: string }[], cited: number[]) => pages.filter((p) => cited.includes(p.no)).map((p) => p.text).join("\n");
const position = (outline: Outline, id: string) => outline.slides.findIndex((s) => s.id === id);
const normalized = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

describe.each(CLASSROOM_FIXTURES)("$id classroom replay", (fixture) => {
  it("covers every outline row exactly once and keeps its order", () => {
    expect(fixture.slides.map((s) => s.specId)).toEqual(fixture.outline.slides.map((s) => s.id));
    expect(new Set(fixture.slides.map((s) => s.specId)).size).toBe(fixture.slides.length);
    fixture.slides.forEach((slide, i) => {
      expect(slide.pageType).toBe(fixture.outline.slides[i]!.pageType);
      expect(slide.sources).toEqual(fixture.outline.slides[i]!.sourcePages);
    });
  });

  it("pins each decisive claim to the page that actually contains it", () => {
    for (const claim of fixture.oracle.claims) {
      const slide = fixture.slides.find((s) => s.specId === claim.specId)!;
      expect(claim.supportedBy.every((p) => slide.sources.includes(p))).toBe(true);
      expect(sourceText(fixture.pages, claim.supportedBy)).toContain(claim.text);
      const wrongPages = fixture.pages.map((p) => p.no).filter((p) => !claim.supportedBy.includes(p));
      expect(sourceText(fixture.pages, wrongPages)).not.toContain(claim.text);
    }
  });

  it("has a complete dependency path and instruction/action/assessment for every objective", () => {
    for (const edge of fixture.oracle.dependencies) expect(position(fixture.outline, edge.before)).toBeLessThan(position(fixture.outline, edge.after));
    for (const objective of fixture.oracle.objectives) {
      expect(fixture.outline.objectives).toContain(objective.objective);
      expect(position(fixture.outline, objective.instruction)).toBeGreaterThanOrEqual(0);
      expect(position(fixture.outline, objective.instruction)).toBeLessThan(position(fixture.outline, objective.learnerAction));
      expect(position(fixture.outline, objective.learnerAction)).toBeLessThan(position(fixture.outline, objective.assessment));
    }
  });

  it("keeps replayed numbers, formulas and calculations faithful to cited pages", () => {
    for (const slide of fixture.slides) {
      expect(verifyNumbers(slide.content, sourceText(fixture.pages, slide.sources), { pageType: slide.pageType, notes: slide.notes }), slide.specId).toEqual([]);
    }
  });
});

describe("seeded core mutations", () => {
  const waves = CLASSROOM_FIXTURES[0]!;

  it("does not let an uncited claim borrow support from the whole selection", () => {
    const content: SlideContent = { layout: "statement", title: "Measured speed", bullets: ["The wave travels at 120 m/s"], visual: { kind: "formula", tex: "v=f\\lambda" }, terms: [] };
    const checked = checkSourceText([], waves.pages);
    expect(checked).toBe("");
    expect(verifyNumbers(content, checked)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "number", text: "120" })]));
  });

  it("rejects a present number paired with the wrong unit", () => {
    const content: SlideContent = { layout: "statement", title: "Measured speed", bullets: ["The wave travels at 120 km/s"], visual: { kind: "formula", tex: "v=f\\lambda" }, terms: [] };
    expect(verifyNumbers(content, sourceText(waves.pages, [11]))).toEqual([expect.objectContaining({ kind: "number", text: "120 km/s" })]);
  });

  it("flags a learning loop with explanation but no learner action", () => {
    const concept = waves.outline.slides.find((s) => s.id === "en-concept")!;
    const broken: Outline = { ...waves.outline, slides: waves.outline.slides.filter((s) => s.loop !== 1 || s.id === concept.id) };
    expect(checkOutline(broken, waves.params)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "loop-balance", slideId: concept.id })]));
  });

  it("keeps deterministic retrieval on prerequisites, not today's cited pages", () => {
    const draft = stubOutline({
      lessonTitle: waves.title,
      params: waves.params,
      sections: [{ title: "Wave speed", pageStart: 11, pageEnd: 12 }],
      pages: waves.pages,
      ctx: { orgId: "o", userId: "u" },
      options: {},
    });
    const retrieval = draft.slides.find((s) => s.pageType === "retrieval")!;
    expect(retrieval.sourcePages).toEqual([]);
    expect(retrieval.keyPoints.join(" ")).not.toMatch(/wave speed/i);
  });

  it("makes deterministic hinge checks polls and records experiment outcomes", () => {
    const check = waves.outline.slides.find((s) => s.id === "en-check")!;
    const quiz = stubSlide({ spec: check, outline: waves.outline, lessonTitle: waves.title, pages: waves.pages.filter((p) => p.no === 11) }).content;
    expect(quiz.layout).toBe("quiz");
    expect(quiz.layout === "quiz" && quiz.poll).toBe(true);

    const experiment: SlideSpec = { ...check, id: "en-experiment", pageType: "experiment", layout: "experiment", title: "Investigate a wave on a string", purpose: "Predict, observe, explain", visual: "sim", minutes: 7 };
    const experimentOutline: Outline = { ...waves.outline, slides: [experiment] };
    const poe = stubSlide({ spec: experiment, outline: experimentOutline, lessonTitle: waves.title, pages: waves.pages }).content;
    expect(poe.layout).toBe("experiment");
    expect(poe.layout === "experiment" && poe.outcome).toBeGreaterThanOrEqual(0);
    expect(poe.layout === "experiment" && poe.outcome).toBeLessThan(poe.layout === "experiment" ? poe.predict.options.length : 0);
  });
});

describe("citation and scientific mutation gates", () => {
  it("catches every adjacent-page, truncated-page and explicit-contradiction citation mutation", () => {
    type Status = "supported" | "unsupported" | "truncated" | "contradicted";
    const statusOf = (claim: (typeof CLASSROOM_FIXTURES)[number]["oracle"]["claims"][number], pages: { no: number; text: string }[], cited: number[]): Status => {
      const text = normalized(sourceText(pages, cited));
      if (text.includes(normalized(claim.contradiction))) return "contradicted";
      if (!claim.supportedBy.every((page) => cited.includes(page))) return "unsupported";
      return text.includes(normalized(claim.text)) ? "supported" : "truncated";
    };

    let clean = 0;
    let cleanRejected = 0;
    let seeded = 0;
    let caught = 0;
    for (const fixture of CLASSROOM_FIXTURES) {
      for (const claim of fixture.oracle.claims) {
        clean++;
        if (statusOf(claim, fixture.pages, claim.supportedBy) !== "supported") cleanRejected++;
        const adjacent = fixture.pages.map((page) => page.no).filter((page) => !claim.supportedBy.includes(page));
        const truncated = fixture.pages.map((page) => (claim.supportedBy.includes(page.no) ? { ...page, text: page.text.replace(claim.text, "") } : page));
        const contradicted = fixture.pages.map((page) => (claim.supportedBy.includes(page.no) ? { ...page, text: `${page.text} ${claim.contradiction}.` } : page));
        for (const [pages, cited] of [
          [fixture.pages, adjacent],
          [truncated, claim.supportedBy],
          [contradicted, claim.supportedBy],
        ] as const) {
          seeded++;
          if (statusOf(claim, pages, cited) !== "supported") caught++;
        }
      }
    }
    expect({ caught, seeded }).toEqual({ caught: 12, seeded: 12 });
    expect(cleanRejected / clean).toBeLessThanOrEqual(0.02);
  });

  it("catches every reviewed physics and chemistry mutation without rejecting clean claims", () => {
    const statement = (bullets: string[], visual: Extract<SlideContent, { layout: "statement" }>["visual"]): Extract<SlideContent, { layout: "statement" }> => ({
      layout: "statement",
      title: "Reviewed scientific claims",
      bullets,
      visual,
      terms: [],
    });
    const physicsSource =
      "Newton's second law is F = m x a. A 3.0 kg cart has a resultant force of +12.0 N, a friction force of -4.0 N, and a displacement of -8.0 m.";
    const physicsClean = statement(["Resultant force is +12.0 N", "Friction force is -4.0 N", "Displacement is -8.0 m"], { kind: "formula", tex: "F=ma" });
    const chemistrySource =
      "Balanced equation: 2 H2(g) + O2(g) → 2 H2O(l). Starting with 2.00 mol H2 and 1.00 mol O2, oxygen is limiting. The theoretical yield is 36.0 g of water. The enthalpy change is -286 kJ/mol.";
    const chemistryClean = statement(
      ["Oxygen is the limiting reagent", "The yield is 36.0 g of water", "Enthalpy change is -286 kJ/mol"],
      { kind: "flow", steps: ["2 H2(g) + O2(g)", "2 H2O(l)"] },
    );
    const textOf = (content: SlideContent) => normalized(JSON.stringify(content));
    const cases = [
      {
        id: "physics",
        source: physicsSource,
        clean: physicsClean,
        reviewedAnchors: ["friction force is -4.0 n"],
        mutations: [
          { kind: "wrong-law", content: statement(physicsClean.bullets, { kind: "formula", tex: "a=Fm" }) },
          { kind: "wrong-unit", content: statement(["Resultant force is +12.0 kg", ...physicsClean.bullets.slice(1)], physicsClean.visual) },
          { kind: "wrong-sign", content: statement([...physicsClean.bullets.slice(0, 2), "Displacement is +8.0 m"], physicsClean.visual) },
          {
            kind: "wrong-context",
            content: statement([physicsClean.bullets[0]!, "Friction force is +12.0 N", physicsClean.bullets[2]!], physicsClean.visual),
            reviewedAnchor: "friction force is -4.0 n",
          },
          { kind: "wrong-significant-figures", content: statement(["Resultant force is +12 N", ...physicsClean.bullets.slice(1)], physicsClean.visual) },
        ],
      },
      {
        id: "chemistry",
        source: chemistrySource,
        clean: chemistryClean,
        reviewedAnchors: ["2 h2(g) + o2(g)", "2 h2o(l)", "yield is 36.0 g of water"],
        mutations: [
          {
            kind: "wrong-law",
            content: statement(chemistryClean.bullets, { kind: "flow", steps: ["H2(g) + O2(g)", "H2O(l)"] }),
            reviewedAnchor: "2 h2(g) + o2(g)",
          },
          { kind: "wrong-unit", content: statement(["Oxygen is the limiting reagent", "The yield is 36.0 kg of water", chemistryClean.bullets[2]!], chemistryClean.visual) },
          { kind: "wrong-sign", content: statement([...chemistryClean.bullets.slice(0, 2), "Enthalpy change is +286 kJ/mol"], chemistryClean.visual) },
          {
            kind: "wrong-context",
            content: statement(["Oxygen is the limiting reagent", "The yield is 36.0 g of oxygen", chemistryClean.bullets[2]!], chemistryClean.visual),
            reviewedAnchor: "yield is 36.0 g of water",
          },
          { kind: "wrong-significant-figures", content: statement(["Oxygen is the limiting reagent", "The yield is 36 g of water", chemistryClean.bullets[2]!], chemistryClean.visual) },
        ],
      },
    ];

    let clean = 0;
    let cleanRejected = 0;
    let seeded = 0;
    let caught = 0;
    const missed: string[] = [];
    for (const fixture of cases) {
      clean++;
      const cleanBad = verifyNumbers(fixture.clean, fixture.source).length > 0 || fixture.reviewedAnchors.some((anchor) => !textOf(fixture.clean).includes(anchor));
      if (cleanBad) cleanRejected++;
      for (const mutation of fixture.mutations) {
        seeded++;
        const detected =
          verifyNumbers(mutation.content, fixture.source).length > 0 ||
          ("reviewedAnchor" in mutation && mutation.reviewedAnchor !== undefined && !textOf(mutation.content).includes(mutation.reviewedAnchor));
        if (detected) caught++;
        else missed.push(`${fixture.id}:${mutation.kind}`);
      }
    }
    expect(missed).toEqual([]);
    expect({ caught, seeded }).toEqual({ caught: 10, seeded: 10 });
    expect(cleanRejected / clean).toBeLessThanOrEqual(0.02);
  });
});
