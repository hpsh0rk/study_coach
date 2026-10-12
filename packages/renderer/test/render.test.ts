import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, type Slide } from "@kj/schema";
import { applyBuildStep, renderSlide, resolveColor, textContentOf } from "../src/index.ts";

const slide: Slide = {
  id: "sl_1",
  outlineItemId: "oi_1",
  layoutId: "test",
  elements: [
    {
      id: "el_title",
      type: "text",
      role: "title",
      frame: { x: 48, y: 36, w: 864, h: 64 },
      fit: { mode: "shrinkOnOverflow", minSize: 20 },
      body: [
        {
          id: "p_1",
          level: 0,
          runs: [
            { id: "r_1", text: "Wave speed ", lang: "en" },
            { id: "r_2", text: "波速", lang: "zh" },
          ],
        },
      ],
    },
    { id: "el_f", type: "formula", latex: "v = f\\lambda", display: true, sizePt: 28, frame: { x: 100, y: 200, w: 300, h: 80 } },
    { id: "el_answer", type: "text", frame: { x: 500, y: 200, w: 300, h: 80 }, fit: { mode: "fixed", minSize: 14 }, body: [{ id: "p_2", level: 0, runs: [{ id: "r_3", text: "340 m/s" }] }] },
    { id: "el_rev", type: "reveal", frame: { x: 500, y: 300, w: 200, h: 40 }, trigger: { kind: "click" }, revealIds: ["el_answer"] },
    {
      id: "el_tbl",
      type: "table",
      frame: { x: 48, y: 360, w: 400, h: 120 },
      columns: [
        { id: "col_1", width: 1 },
        { id: "col_2", width: 2 },
      ],
      rows: [
        { id: "row_1", height: 40, header: true, cells: [{ id: "cell_1", body: [{ id: "p_3", level: 0, runs: [{ id: "r_4", text: "Medium" }] }] }, { id: "cell_2", body: [{ id: "p_4", level: 0, runs: [{ id: "r_5", text: "Speed" }] }] }] },
      ],
    },
    { id: "el_exp", type: "experiment", provider: "phet", componentId: "wave-on-a-string", params: { locale: "en" }, frame: { x: 500, y: 360, w: 400, h: 150 }, fallback: { shortCode: "WAVE01", caption: { en: "Wave on a String", zh: "弦上的波" } }, attribution: "PhET" },
    { id: "el_hidden", type: "shape", geometry: "rect", hidden: true, frame: { x: 0, y: 0, w: 10, h: 10 } },
  ],
  builds: [{ id: "b_1", order: 1, elementIds: ["el_f"], effect: "fade" }],
  notes: { en: [], zhTerms: [] },
  status: "ready",
  provenance: { aiCallId: "x", specHash: "x" },
};

const ctx = { theme: DEFAULT_THEME, mode: "present" as const, resolveAsset: (id: string) => `/assets/${id}` };

describe("renderSlide", () => {
  it("renders positioned elements with stable ids and language-tagged runs", () => {
    const root = renderSlide(slide, ctx);
    expect(root.style.width).toBe("960px");
    const title = root.querySelector<HTMLElement>('[data-id="el_title"]')!;
    expect(title.style.left).toBe("48px");
    expect(root.querySelector('[data-id="r_2"]')!.getAttribute("lang")).toBe("zh-CN");
    expect(textContentOf(root, "el_title")).toBe("Wave speed 波速");
    expect(root.querySelector('[data-id="el_hidden"]')).toBeNull();
    expect(root.querySelector('[data-id="cell_1"]')!.tagName).toBe("TH");
    expect(root.querySelector('[data-id="el_f"] .katex')).not.toBeNull();
    expect(root.style.getPropertyValue("--kj-color-primary")).toBe(DEFAULT_THEME.color.primary);
  });

  it("hides build targets until their step", () => {
    const root = renderSlide(slide, ctx);
    expect(applyBuildStep(root, 0)).toBe(1);
    expect(root.querySelector('[data-id="el_f"]')!.classList.contains("kj-build-pending")).toBe(true);
    applyBuildStep(root, 1);
    expect(root.querySelector('[data-id="el_f"]')!.classList.contains("kj-build-pending")).toBe(false);
  });

  it("toggles reveal targets on click in present mode, shows all in thumbnails", () => {
    const root = renderSlide(slide, ctx);
    const answer = root.querySelector('[data-id="el_answer"]')!;
    expect(answer.classList.contains("kj-reveal-hidden")).toBe(true);
    (root.querySelector('[data-id="el_rev"]') as HTMLButtonElement).click();
    expect(answer.classList.contains("kj-reveal-hidden")).toBe(false);
    const thumb = renderSlide(slide, { ...ctx, mode: "thumbnail" });
    expect(thumb.querySelector('[data-id="el_answer"]')!.classList.contains("kj-reveal-hidden")).toBe(false);
  });

  it("renders experiments as a fallback card with provider data (no URL in the deck)", () => {
    const root = renderSlide(slide, ctx);
    const exp = root.querySelector<HTMLElement>('[data-id="el_exp"]')!;
    expect(exp.dataset.provider).toBe("phet");
    expect(exp.dataset.component).toBe("wave-on-a-string");
    expect(exp.textContent).toContain("弦上的波");
    expect(exp.querySelector("iframe")).toBeNull();
  });

  it("resolves theme tokens to CSS variables", () => {
    expect(resolveColor("token:accent")).toBe("var(--kj-color-accent)");
    expect(resolveColor("#fff")).toBe("#fff");
  });
});
