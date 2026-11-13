import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Slide } from "@kj/schema";
import { seededRandom, withoutAnswers } from "@kj/templates";
import { CLASSROOM_FIXTURES } from "@kj/templates/testing/classroom";
import { offlineDeckData, serializeOfflineDeck, figureAssetIdsOf } from "../src/offline/exportDeck.ts";

const fixture = CLASSROOM_FIXTURES[0]!;
const slide = (value: (typeof fixture.slides)[number], content = value.content): Slide => ({
  id: `slide-${value.specId}`,
  specId: value.specId,
  outlineVersionId: "ov-frozen",
  layout: content.layout,
  pageType: value.pageType,
  minutes: 3,
  content,
  notes: `TEACHER-OFFLINE-NOTE-X <${value.specId}>`,
  sources: value.sources,
  warnings: [],
  unverified: [],
});
const lesson = (answers: "hidden" | "shown") => ({ title: fixture.title, theme: "classic" as const, pageLabels: {}, language: fixture.params.language, answers });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("offline student payload boundary", () => {
  it("embeds stable preview JSON with no teacher-only or answer canaries", () => {
    const slides = fixture.slides.map((value) => slide(value, withoutAnswers(value.content, seededRandom(`ov-frozen\0${value.specId}`), value.pageType)));
    const serialized = Array.from({ length: 20 }, () => serializeOfflineDeck(offlineDeckData({ lesson: lesson("hidden"), slides }, "student")));
    expect(new Set(serialized).size).toBe(1);
    expect(new Set(serialized.map(hash)).size).toBe(1);
    const json = serialized[0]!;
    expect(json).not.toContain("TEACHER-OFFLINE-NOTE-X");
    for (const canary of fixture.oracle.teacherOnlyCanaries) expect(json).not.toContain(canary);
    expect(JSON.parse(json)).toEqual(offlineDeckData({ lesson: lesson("hidden"), slides }, "student"));
  });

  it("escapes script-closing text and keeps student review answers but not notes", () => {
    const slides = fixture.slides.map((value) =>
      slide(value, value.content.layout === "quiz" ? { ...value.content, options: value.content.options.map((option) => ({ ...option, misconception: "" })) } : value.content),
    );
    const json = serializeOfflineDeck(offlineDeckData({ lesson: { ...lesson("shown"), title: "Wave <en-cover> speed" }, slides }, "student"));
    expect(json).not.toContain("<en-cover>");
    expect(json).toContain("\\u003cen-cover>");
    expect(json).not.toContain("TEACHER-OFFLINE-NOTE-X");
    expect(json).not.toContain("TEACHER-MISCONCEPTION");
    expect(json).toContain("TEACHER-KEY-EN");
    expect(json).toContain("TEACHER-EXIT-EN");
  });

  it("extracts referenced figure assetIds and embeds pre-fetched data URLs into OfflineDeck.media", () => {
    const figSlide: Slide = {
      id: "sl-fig",
      specId: "sp-fig",
      outlineVersionId: "ov-frozen",
      layout: "statement",
      pageType: "concept",
      minutes: 3,
      content: {
        layout: "statement",
        title: "Solenoid magnetic field",
        bullets: ["Field lines are parallel inside"],
        visual: { kind: "figure", assetId: "med_solenoid704", caption: "Fig 16.8" },
        terms: [],
      },
      notes: "",
      sources: [704],
      warnings: [],
      unverified: [],
    };
    expect(figureAssetIdsOf([figSlide])).toEqual(["med_solenoid704"]);
    const media = { med_solenoid704: "data:image/png;base64,iVBORw0KGgo=" };
    const data = offlineDeckData({ lesson: lesson("shown"), slides: [figSlide] }, "teacher", {}, media);
    expect(data.media).toEqual(media);
  });
});
