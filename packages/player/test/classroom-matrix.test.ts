import { describe, expect, it } from "vitest";
import { CLASSROOM_FIXTURES } from "@kj/templates/testing/classroom";
import { applyStep, renderSlide } from "@kj/templates/render";

describe.each(CLASSROOM_FIXTURES)("$id classroom interactions", (fixture) => {
  it("renders every replay to its final step with no hidden content or speaker notes", () => {
    for (const slide of fixture.slides) {
      const rendered = renderSlide({ content: slide.content, sources: slide.sources }, { theme: "classic", interactive: true, language: fixture.params.language });
      applyStep(rendered.el, rendered.steps);
      expect(rendered.el.querySelectorAll(".kj-step-hidden"), slide.specId).toHaveLength(0);
      expect(rendered.el.textContent, slide.specId).not.toContain(slide.notes);
      rendered.dispose();
    }
  });

  it("gives every hinge poll a tally step before its valid answer", () => {
    const polls = fixture.slides.filter((slide) => slide.content.layout === "quiz" && slide.content.poll);
    expect(polls.length).toBeGreaterThan(0);
    for (const slide of polls) {
      if (slide.content.layout !== "quiz") throw new Error("fixture");
      expect(slide.content.answer).toBeGreaterThanOrEqual(0);
      expect(slide.content.answer).toBeLessThan(slide.content.options.length);
      const rendered = renderSlide({ content: slide.content, sources: slide.sources }, { theme: "classic", interactive: true, tally: slide.content.options.map((_, i) => i + 1) });
      expect(rendered.steps).toBe(2);
      applyStep(rendered.el, 1);
      expect(rendered.el.querySelector(".kj-tally")!.classList.contains("kj-step-hidden")).toBe(false);
      expect(rendered.el.querySelector(".kj-answer")!.classList.contains("kj-step-hidden")).toBe(true);
      applyStep(rendered.el, 2);
      expect(rendered.el.querySelector(".kj-answer")!.classList.contains("kj-step-hidden")).toBe(false);
      rendered.dispose();
    }
  });
});
