import { describe, expect, it } from "vitest";
import { sha256Hex, Slide as SlideSchema, type Slide, type SlideContent } from "@kj/schema";
import { CLASSROOM_FIXTURES, type ClassroomSlide } from "@kj/templates/testing/classroom";
import { deckExport, studentSlide, type LessonRow, type VersionRow } from "../src/store.ts";

const fixture = CLASSROOM_FIXTURES[0]!;
const TEACHER_METADATA = ["TEACHER-NOTES-X", "TEACHER-WARNING-X", "TEACHER-VERIFY-X"];

function slide(content: SlideContent, pageType: Slide["pageType"], specId: string): Slide {
  return SlideSchema.parse({
    id: `slide-${specId}`,
    specId,
    outlineVersionId: "ov-frozen",
    layout: content.layout,
    pageType,
    minutes: 3,
    content,
    notes: TEACHER_METADATA[0],
    sources: [11],
    warnings: [TEACHER_METADATA[1]],
    unverified: [{ kind: "number", text: TEACHER_METADATA[2], detail: "teacher only" }],
  });
}

function fixtureSlide(value: ClassroomSlide): Slide {
  return slide(value.content, value.pageType, value.specId);
}

const order = slide(
  { layout: "order", title: "Put the wave calculation in order", mode: "order", items: ["Write equation", "Substitute values", "Calculate", "Add units"].map((text) => ({ text, match: "" })) },
  "sequence",
  "order",
);
const match = slide(
  {
    layout: "order",
    title: "Match quantities and units",
    mode: "match",
    items: [
      { text: "speed", match: "m/s" },
      { text: "frequency", match: "Hz" },
      { text: "wavelength", match: "m" },
      { text: "period", match: "s" },
    ],
  },
  "sequence",
  "match",
);
const experiment = slide(
  {
    layout: "experiment",
    title: "Predict the wavelength",
    predict: { question: "What changes?", options: ["Longer", "Shorter", "Same"] },
    sim: { kind: "sim", embedId: "wave-string" },
    observe: ["Increase frequency"],
    explain: "TEACHER-EXPERIMENT-X",
    outcome: 1,
  },
  "experiment",
  "experiment",
);
const malformedFaded = (() => {
  const original = fixture.slides.find((value) => value.pageType === "faded")!;
  if (original.content.layout !== "steps") throw new Error("fixture");
  const { fadeFrom: _missing, ...content } = original.content;
  return slide({ ...content, steps: [...content.steps.slice(0, -1), { text: "TEACHER-FINAL-X", why: "TEACHER-FINAL-WHY-X" }] }, "faded", "malformed-faded");
})();
const teacherSlides = [...fixture.slides.map(fixtureSlide), order, match, experiment, malformedFaded];

const lesson = {
  id: "lesson-frozen",
  orgId: "org",
  ownerId: "teacher",
  documentId: "document",
  title: fixture.title,
  scope: JSON.stringify({ chapterIds: [], ranges: [{ start: 11, end: 12 }] }),
  params: JSON.stringify(fixture.params),
  theme: "classic",
  draftingUntil: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
} as LessonRow;
const version = {
  id: "ov-frozen",
  lessonId: lesson.id,
  version: 3,
  outline: JSON.stringify(fixture.outline),
  params: JSON.stringify(fixture.params),
  scope: lesson.scope,
  specCount: fixture.outline.slides.length,
  rev: 0,
  ackOverBudget: false,
  confirmedAt: 123,
  createdAt: 1,
} as VersionRow;

const hash = (value: unknown) => sha256Hex(JSON.stringify(value));

describe("frozen student payloads", () => {
  it("has one stable preview payload/hash across repeated share and file serialization", async () => {
    const payloads = Array.from({ length: 100 }, () => deckExport(lesson, version, teacherSlides, { includeNotes: false, answers: "hidden", pageLabels: {} }));
    expect(new Set(payloads.map((payload) => JSON.stringify(payload))).size).toBe(1);
    expect(new Set(await Promise.all(payloads.map(hash))).size).toBe(1);
  });

  it("keeps review and teacher payloads stable without applying the preview shuffle", async () => {
    for (const config of [
      { includeNotes: false, answers: "shown" as const },
      { includeNotes: true, answers: "shown" as const },
    ]) {
      const hashes = new Set(await Promise.all(Array.from({ length: 20 }, () => hash(deckExport(lesson, version, teacherSlides, { ...config, pageLabels: {} })))));
      expect(hashes.size).toBe(1);
    }
  });

  it("removes teacher-only fields and answer-bearing canaries from preview JSON", () => {
    const preview = deckExport(lesson, version, teacherSlides, { includeNotes: false, answers: "hidden", pageLabels: {} });
    const json = JSON.stringify(preview);
    for (const canary of [...TEACHER_METADATA, ...fixture.oracle.teacherOnlyCanaries, "TEACHER-EXPERIMENT-X", "TEACHER-FINAL-X", "TEACHER-FINAL-WHY-X"]) expect(json).not.toContain(canary);

    const previewOrder = preview.slides.find((value) => value.specId === "order")!.content;
    const previewMatch = preview.slides.find((value) => value.specId === "match")!.content;
    const previewQuiz = preview.slides.find((value) => value.specId === "en-check")!.content;
    const previewQuestions = preview.slides.find((value) => value.specId === "en-exit")!.content;
    const previewExperiment = preview.slides.find((value) => value.specId === "experiment")!.content;
    const previewFaded = preview.slides.find((value) => value.specId === "malformed-faded")!.content;
    expect(previewOrder.layout).toBe("order");
    expect(previewMatch.layout).toBe("order");
    if (
      previewOrder.layout !== "order" ||
      previewMatch.layout !== "order" ||
      previewQuiz.layout !== "quiz" ||
      previewQuestions.layout !== "questions" ||
      previewExperiment.layout !== "experiment" ||
      previewFaded.layout !== "steps"
    )
      throw new Error("layout");
    previewOrder.items.forEach((item, i) => expect(item.text).not.toBe(order.content.layout === "order" ? order.content.items[i]!.text : ""));
    previewMatch.items.forEach((item, i) => {
      expect(item.text).toBe(match.content.layout === "order" ? match.content.items[i]!.text : "");
      expect(item.match).not.toBe(match.content.layout === "order" ? match.content.items[i]!.match : "");
    });
    expect(previewQuiz).toMatchObject({ answer: -1, explain: "" });
    expect(previewQuiz.options.every((option) => option.misconception === "")).toBe(true);
    expect(previewQuestions.items.every((item) => item.a === "")).toBe(true);
    expect(previewExperiment).not.toHaveProperty("outcome");
    expect(previewExperiment.explain).toBe("");
    expect(previewFaded.steps.at(-1)).toEqual({ text: "", why: "" });
  });

  it("review JSON restores student answers but never teacher metadata or misconception diagnostics", () => {
    const review = deckExport(lesson, version, teacherSlides, { includeNotes: false, answers: "shown", pageLabels: {} });
    const json = JSON.stringify(review);
    for (const canary of TEACHER_METADATA) expect(json).not.toContain(canary);
    expect(json).not.toContain("TEACHER-MISCONCEPTION");
    expect(json).toContain("TEACHER-KEY-EN");
    expect(json).toContain("TEACHER-EXPERIMENT-X");
    expect(json).toContain("TEACHER-FINAL-X");
  });

  it("fails closed for malformed faded preview content while leaving review content intact", () => {
    const preview = studentSlide(malformedFaded, "hidden");
    const review = studentSlide(malformedFaded, "shown");
    expect(JSON.stringify(preview)).not.toContain("TEACHER-FINAL");
    expect(preview.content).toMatchObject({ layout: "steps", fadeFrom: 2 });
    expect(JSON.stringify(review)).toContain("TEACHER-FINAL-X");
  });
});
