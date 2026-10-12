import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, Slide, CANVAS } from "@kj/schema";
import { detectLang, fitFontSize, layoutSlide, splitRuns, SlideSlots } from "../src/index.ts";

describe("splitRuns", () => {
  it("splits mixed English/Chinese into language runs", () => {
    const runs = splitRuns("Amplitude 振幅 is the max displacement");
    expect(runs.map((r) => [r.text, r.lang])).toEqual([
      ["Amplitude ", "en"],
      ["振幅 ", "zh"],
      ["is the max displacement", "en"],
    ]);
    expect(new Set(runs.map((r) => r.id)).size).toBe(runs.length);
  });

  it("detects language", () => {
    expect(detectLang("wave")).toBe("en");
    expect(detectLang("波长")).toBe("zh");
    expect(detectLang("wavelength 波长")).toBe("auto");
  });
});

describe("layoutSlide", () => {
  const slots = SlideSlots.parse({
    layout: "title-bullets-terms",
    title: "Describing waves 描述波",
    bullets: ["A wave transfers energy without transferring matter.", "Amplitude is the maximum displacement from rest."],
    terms: [
      { term: "amplitude", zh: "振幅" },
      { term: "wavelength", zh: "波长" },
    ],
    notes: { en: ["Start with a slinky demo."], zhTerms: [{ term: "amplitude", zh: "振幅" }] },
  });

  it("produces a schema-valid slide within the canvas", () => {
    const slide = layoutSlide({ slots, theme: DEFAULT_THEME, outlineItemId: "oi_1", aiCallId: "ai_x", specHash: "h" });
    expect(Slide.safeParse(slide).success).toBe(true);
    for (const el of slide.elements) {
      expect(el.frame.x).toBeGreaterThanOrEqual(0);
      expect(el.frame.y).toBeGreaterThanOrEqual(0);
      expect(el.frame.x + el.frame.w).toBeLessThanOrEqual(CANVAS.width);
      expect(el.frame.y + el.frame.h).toBeLessThanOrEqual(CANVAS.height);
    }
    expect(slide.builds?.[0]?.elementIds).toHaveLength(1);
    expect(slide.notes.zhTerms[0]?.zh).toBe("振幅");
  });

  it("shrinks long bullet lists but never below the theme minimum", () => {
    const long = Array.from({ length: 8 }, () => "A very long sentence about waves and their properties ".repeat(4));
    const size = fitFontSize(long, { w: 560, h: 380 }, DEFAULT_THEME, 24);
    expect(size).toBe(DEFAULT_THEME.typeScale.minimum);
    expect(fitFontSize(["short"], { w: 560, h: 380 }, DEFAULT_THEME, 24)).toBe(24);
  });
});
