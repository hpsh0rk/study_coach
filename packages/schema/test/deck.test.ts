import { describe, expect, it } from "vitest";
import { canonicalJson, outlineContentHash, stripNotes, validateDeck, type Deck } from "../src/index.ts";

const minimal: Deck = {
  id: "deck_1",
  schemaVersion: 2,
  projectId: "prj_1",
  version: 1,
  theme: { themeId: "classic-blue", themeVersion: 1 },
  outlineVersionId: "ol_1",
  slides: [
    {
      id: "sl_1",
      outlineItemId: "oi_1",
      layoutId: "title-bullets",
      elements: [
        {
          id: "el_t",
          type: "text",
          frame: { x: 48, y: 40, w: 864, h: 60 },
          fit: { mode: "fixed", minSize: 14 },
          body: [{ id: "p_1", level: 0, runs: [{ id: "r_1", text: "Waves 波", lang: "auto" }] }],
        },
        { id: "el_s", type: "shape", geometry: "arrow", frame: { x: 100, y: 200, w: 200, h: 0 }, stroke: { width: 3, color: "token:primary" } },
      ],
      builds: [{ id: "b_1", order: 1, elementIds: ["el_s"], effect: "fade" }],
      notes: { en: ["Say hello"], zhTerms: [{ term: "wave", zh: "波" }] },
      status: "ready",
      provenance: { aiCallId: "manual", specHash: "x" },
    },
  ],
};

describe("deck schema", () => {
  it("accepts a valid deck", () => {
    expect(validateDeck(minimal)).toMatchObject({ ok: true });
  });

  it("rejects duplicate ids", () => {
    const bad = structuredClone(minimal);
    bad.slides[0]!.elements[1]!.id = "el_t";
    const res = validateDeck(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join()).toContain("duplicate id: el_t");
  });

  it("rejects builds pointing to other slides' elements", () => {
    const bad = structuredClone(minimal);
    bad.slides[0]!.builds = [{ id: "b_1", order: 1, elementIds: ["el_missing"], effect: "appear" }];
    const res = validateDeck(bad);
    expect(res.ok).toBe(false);
  });

  it("rejects untyped ids and bad colors", () => {
    const bad = structuredClone(minimal) as unknown as { slides: { elements: { stroke?: { color: string } }[] }[]; id: string };
    bad.id = "nope";
    bad.slides[0]!.elements[1]!.stroke = { color: "red" } as never;
    expect(validateDeck(bad).ok).toBe(false);
  });

  it("strips notes for the student view", () => {
    expect(stripNotes(minimal).slides[0]!.notes).toEqual({ en: [], zhTerms: [] });
  });
});

describe("outline hash", () => {
  it("is independent of key order", async () => {
    const a = [{ id: "oi_1", kind: "content" as const, title: "A", points: ["x"], chapterIds: [] }];
    const b = [{ chapterIds: [], points: ["x"], title: "A", kind: "content" as const, id: "oi_1" }];
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(await outlineContentHash(a)).toBe(await outlineContentHash(b));
  });
});
