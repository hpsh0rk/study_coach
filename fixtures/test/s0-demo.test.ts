import { describe, expect, it } from "vitest";
import { validateDeck, walkElements, type Element } from "@kj/schema";
import { s0DemoDeck } from "../decks/index.ts";

describe("S0 demo deck", () => {
  it("is valid against deck schema v2", () => {
    const res = validateDeck(s0DemoDeck);
    if (!res.ok) throw new Error(res.errors.join("\n"));
    expect(s0DemoDeck.slides).toHaveLength(10);
  });

  it("covers every element type the spike needs", () => {
    const types = new Set<string>();
    for (const s of s0DemoDeck.slides) walkElements(s.elements, (el: Element) => types.add(el.type));
    expect([...types].sort()).toEqual(["experiment", "formula", "image", "reveal", "shape", "table", "text"]);
    expect(s0DemoDeck.slides.some((s) => (s.builds ?? []).length > 1)).toBe(true);
    expect(s0DemoDeck.slides.every((s) => s.notes.en.length > 0)).toBe(true);
  });
});
