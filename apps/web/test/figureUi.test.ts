import { describe, expect, it } from "vitest";
import { describeIssue, slotIssues, widgetIssues } from "@kj/templates/issues";
import { normalizeDragRect } from "../src/textbook/PageCropper.tsx";
import { rememberedFile, rememberedPageOffset, rememberFile } from "../src/textbook/external.ts";

describe("PageCropper drag normalization & SlotEditor figure validation", () => {
  it("normalizes drag coordinates in any pointer direction and clamps to [0..1]", () => {
    const rect = normalizeDragRect({ x: 0.85, y: 1.2 }, { x: 0.25, y: -0.1 });
    expect(rect.x).toBeCloseTo(0.25, 5);
    expect(rect.y).toBeCloseTo(0, 5);
    expect(rect.w).toBeCloseTo(0.6, 5);
    expect(rect.h).toBeCloseTo(1, 5);
  });

  it("remembers PDF blob and pageOffset per documentId for manual page cropping", () => {
    const fakeBlob = new Blob(["%PDF-1.7"]);
    rememberFile("doc_test_offset", fakeBlob, 693);
    expect(rememberedFile("doc_test_offset")).toBe(fakeBlob);
    expect(rememberedPageOffset("doc_test_offset")).toBe(693);
    expect(rememberedPageOffset("doc_unknown")).toBe(1);
  });

  it("validates figure slot in statement and chart layouts and emits Chinese error messages for invalid assetIds", () => {
    const goodStatement = {
      layout: "statement" as const,
      title: "Magnetic field around a solenoid",
      bullets: ["Parallel field lines inside"],
      visual: { kind: "figure" as const, assetId: "med_solenoid704", caption: "Fig 16.8: Solenoid field" },
      terms: [],
    };
    expect(slotIssues(goodStatement)).toEqual([]);
    expect(widgetIssues(goodStatement, { knownAssetIds: new Set(["med_solenoid704"]) })).toEqual([]);

    const badFigure = {
      ...goodStatement,
      visual: { kind: "figure" as const, assetId: "med_missing", caption: "Fig 16.8" },
    };
    const wIssues = widgetIssues(badFigure, { knownAssetIds: new Set(["med_solenoid704"]) });
    expect(wIssues).toHaveLength(1);
    expect(describeIssue(wIssues[0]!)).toContain("插图");
  });
});
