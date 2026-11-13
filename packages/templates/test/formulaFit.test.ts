import { describe, expect, it } from "vitest";
import * as templateRender from "../src/render/index.ts";

describe("display formula scale calculation & renderRichText export", () => {
  it("computes proportional scale for wide display formulas while clamping at the 48px floor", () => {
    const formulaScaleFor = (templateRender as Record<string, unknown>).formulaScaleFor as
      | ((neededWidth: number, availWidth: number, basePx?: number, minPx?: number) => number)
      | undefined;
    expect(typeof formulaScaleFor).toBe("function");

    // Fits comfortably -> scale 1
    expect(formulaScaleFor!(480, 720)).toBe(1);
    // Slightly wider (1120px into 700px) -> scales down to fit (~0.625, i.e. 65px >= 48px)
    const mid = formulaScaleFor!(1120, 700);
    expect(mid).toBeLessThanOrEqual(700 / 1120 + 0.001);
    expect(mid * 104).toBeGreaterThanOrEqual(48);
    // Very wide (3000px into 700px) -> clamps at 48px floor (48 / 104)
    const clamped = formulaScaleFor!(3000, 700);
    expect(clamped * 104).toBeCloseTo(48, 1);
  });

  it("re-exports renderRichText from @kj/templates/render", () => {
    const renderRich = (templateRender as Record<string, unknown>).renderRichText;
    expect(typeof renderRich).toBe("function");
  });
});
