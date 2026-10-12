import { describe, expect, it } from "vitest";
import { Outline, PageText } from "../src/index.ts";

const spec = { id: "s1", pageType: "concept", layout: "statement", title: "Waves carry energy", minutes: 3 };

describe("outline", () => {
  it("defaults glossary and notCovered for outlines saved before they existed", () => {
    const o = Outline.parse({ objectives: ["Describe waves"], slides: [spec] });
    expect(o.glossary).toEqual([]);
    expect(o.notCovered).toEqual([]);
    expect(o.slides[0]).toMatchObject({ keyPoints: [], sourcePages: [], visual: "none", loop: 0 });
  });

  it("caps glossary and notCovered", () => {
    const base = { objectives: ["Describe waves"], slides: [spec] };
    expect(Outline.safeParse({ ...base, glossary: Array.from({ length: 31 }, (_, i) => ({ term: `t${i}` })) }).success).toBe(false);
    expect(Outline.safeParse({ ...base, notCovered: ["x".repeat(201)] }).success).toBe(false);
    expect(Outline.parse({ ...base, glossary: [{ term: "wavelength" }] }).glossary).toEqual([{ term: "wavelength", zh: "" }]);
  });
});

describe("page text", () => {
  it("keeps an optional printed label", () => {
    expect(PageText.parse({ no: 3, text: "a" }).label).toBeUndefined();
    expect(PageText.parse({ no: 3, text: "a", label: "xiv" }).label).toBe("xiv");
    expect(PageText.safeParse({ no: 3, text: "a", label: "x".repeat(21) }).success).toBe(false);
  });
});
