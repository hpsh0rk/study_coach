import { describe, expect, it } from "vitest";
import type { SlideContent } from "@kj/schema";
import { galleryCells } from "@kj/templates";
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
