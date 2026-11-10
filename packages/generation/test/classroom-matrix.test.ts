import { describe, expect, it } from "vitest";
import { checkOutline, verifyNumbers } from "@kj/pedagogy";
import type { Outline, SlideContent, SlideSpec } from "@kj/schema";
import { CLASSROOM_FIXTURES } from "@kj/templates/testing/classroom";
import { checkSourceText, stubOutline, stubSlide } from "../src/index.ts";

const sourceText = (pages: { no: number; text: string }[], cited: number[]) => pages.filter((p) => cited.includes(p.no)).map((p) => p.text).join("\n");
const position = (outline: Outline, id: string) => outline.slides.findIndex((s) => s.id === id);

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
