import { describe, expect, it } from "vitest";
import type { SlideContent } from "@kj/schema";
import { withoutAnswers } from "@kj/templates";
import { galleryCells, sampleContent } from "@kj/templates/testing";
import { applyStep, renderSlide } from "@kj/templates/render";

describe("render safety", () => {
  it("a visual whose expression does not compile renders the 图示待补 placeholder instead of throwing", () => {
    const content: SlideContent = {
      layout: "statement",
      title: "Waves carry energy",
      bullets: ["Energy moves along the rope"],
      visual: { kind: "function", expr: "sin(2*pi*x", x: [0, 4], xLabel: "x", yLabel: "y", params: [] },
      terms: [],
    };
    const r = renderSlide({ content, sources: [] }, { theme: "classic", interactive: true });
    const host = r.el.querySelector(".kj-widget-failed");
    expect(host).not.toBeNull();
    expect(host!.textContent).toContain("图示");
    r.dispose();
  });

  it.each(galleryCells().map((c) => [c.id, c] as const))("%s: the last reveal step shows every element", (_id, cell) => {
    const r = renderSlide({ content: cell.content, sources: [] }, { theme: "classic", interactive: false });
    applyStep(r.el, r.steps);
    expect(r.el.querySelectorAll(".kj-step-hidden").length).toBe(0);
    r.dispose();
  });

  it("a flow longer than the bullet list reveals one step per click, first step shown at once", () => {
    const cell = galleryCells().find((c) => c.id === "statement-flow-en")!;
    const r = renderSlide({ content: cell.content, sources: [] }, { theme: "classic", interactive: false });
    expect(r.steps).toBe(4);
    applyStep(r.el, 0);
    expect(r.el.querySelectorAll(".kj-flow-step:not(.kj-step-hidden)").length).toBe(1);
    applyStep(r.el, 2);
    expect(r.el.querySelectorAll(".kj-flow-step:not(.kj-step-hidden)").length).toBe(3);
    r.dispose();
  });
});

describe("built-in labels", () => {
  it("follow the teaching language (bilingual by default)", () => {
    const content: SlideContent = { layout: "title", title: "力与运动", subtitle: "", objectives: ["说出牛顿第一定律"] };
    const labelOf = (language?: "en" | "zh" | "en+zh") => {
      const r = renderSlide({ content, sources: [3] }, { theme: "classic", interactive: false, language });
      const out = [r.el.querySelector(".kj-objectives-label")!.textContent, r.el.querySelector(".kj-sources-label")!.textContent];
      r.dispose();
      return out;
    };
    expect(labelOf("zh")).toEqual(["学习目标", "教材"]);
    expect(labelOf("en")).toEqual(["Learning objectives", "Source"]);
    expect(labelOf()).toEqual(["Learning objectives · 学习目标", "Source · 教材"]);
  });

  it("a 课前预习 deck shows 答案课后公布 where answers would be revealed and marks nothing correct", () => {
    for (const layout of ["quiz", "experiment", "questions", "order"] as const) {
      const r = renderSlide({ content: withoutAnswers(sampleContent(layout)), sources: [] }, { theme: "classic", interactive: true, hideAnswers: true, language: "zh" });
      applyStep(r.el, r.steps);
      expect(r.el.querySelector(".kj-after-class")?.textContent, layout).toBe("答案课后公布");
      expect(r.el.querySelector("[data-correct='true'], [data-outcome='true'], .kj-card-n, .kj-order-reveal"), layout).toBeNull();
      if (layout === "quiz") {
        r.el.querySelector<HTMLButtonElement>(".kj-option")!.click();
        expect(r.el.querySelector(".kj-quiz-feedback")!.textContent).toBe("答案课后公布");
        expect(r.el.classList.contains("kj-answered")).toBe(false);
      }
      r.dispose();
    }
  });
});
