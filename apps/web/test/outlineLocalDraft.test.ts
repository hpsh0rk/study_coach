import { afterEach, describe, expect, it, vi } from "vitest";
import type { Outline } from "@kj/schema";
import { clearOutlineDraft, loadOutlineDraft, saveOutlineDraft } from "../src/pages/wizard/outlineLocalDraft.ts";

const outline: Outline = {
  objectives: ["Understand forces"],
  slides: [
    {
      id: "s1",
      pageType: "concept",
      layout: "statement",
      title: "Force changes motion",
      purpose: "",
      keyPoints: ["A net force causes acceleration"],
      visual: "none",
      minutes: 3,
      sourcePages: [1],
      loop: 1,
    },
  ],
  glossary: [],
  notCovered: [],
};

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  };
}

describe("outline conflict drafts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("scopes a saved draft to its lesson and outline version", () => {
    vi.spyOn(Date, "now").mockReturnValue(123);
    const s = storage();
    saveOutlineDraft(s, "lesson-a", "version-a", outline);

    expect(loadOutlineDraft(s, "lesson-a", "version-a")).toEqual(outline);
    expect(loadOutlineDraft(s, "lesson-b", "version-a")).toBeNull();
    expect(loadOutlineDraft(s, "lesson-a", "version-b")).toBeNull();
    expect([...s.values.values()][0]).toContain('"savedAt":123');
  });

  it("ignores malformed drafts and clears valid ones", () => {
    const s = storage();
    s.setItem("kj:outline-draft:lesson:version", '{"outline":{"bad":true}}');
    expect(loadOutlineDraft(s, "lesson", "version")).toBeNull();

    saveOutlineDraft(s, "lesson", "version", outline);
    clearOutlineDraft(s, "lesson", "version");
    expect(loadOutlineDraft(s, "lesson", "version")).toBeNull();
  });
});
