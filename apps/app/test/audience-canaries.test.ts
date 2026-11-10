import { describe, expect, it } from "vitest";
import { Slide as SlideSchema, type PageType, type SlideContent } from "@kj/schema";
import { studentSlide } from "../src/store.ts";

const slide = (pageType: PageType, content: SlideContent, notes = "TEACHER-NOTES-CANARY") =>
  SlideSchema.parse({
    id: `s-${pageType}`,
    specId: `sp-${pageType}`,
    outlineVersionId: "ov1",
    layout: content.layout,
    pageType,
    minutes: 3,
    content,
    notes,
    sources: [2],
    warnings: ["TEACHER-WARNING-CANARY"],
    unverified: [{ kind: "number", text: "TEACHER-VERIFY-CANARY", detail: "teacher only" }],
  });

describe("student audience canaries", () => {
  it("removes answer-bearing content and teacher metadata from the canonical preview payload", () => {
    const cases = [
      slide("check", {
        layout: "quiz",
        question: "Which statement is correct?",
        options: [
          { text: "A", misconception: "TEACHER-MISCONCEPTION-CANARY" },
          { text: "B", misconception: "" },
        ],
        answer: 1,
        explain: "TEACHER-EXPLANATION-CANARY",
      }),
      slide("experiment", {
        layout: "experiment",
        title: "Predict the result",
        predict: { question: "What changes?", options: ["A", "B"] },
        sim: { kind: "sim", embedId: "wave-string" },
        observe: ["Observe the string"],
        explain: "TEACHER-EXPERIMENT-CANARY",
        outcome: 1,
      }),
      slide("practice", {
        layout: "questions",
        title: "Practice",
        items: [{ q: "What is transferred?", a: "TEACHER-ANSWER-CANARY" }],
      }),
    ];

    const preview = cases.map((s) => studentSlide(s, "hidden"));
    expect(JSON.stringify(preview)).not.toMatch(/TEACHER-(?:NOTES|WARNING|VERIFY|MISCONCEPTION|EXPLANATION|EXPERIMENT|ANSWER)-CANARY/);
    expect(preview[0]!.content).toMatchObject({ answer: -1, explain: "" });
    expect(preview[1]!.content).not.toHaveProperty("outcome");
  });

  it("fails closed when a faded example lost fadeFrom: the final answer step is not serialized", () => {
    const malformed = slide("faded", {
      layout: "steps",
      title: "Your turn",
      problem: "Find the wave speed.",
      steps: [
        { text: "Write v = fλ", why: "Choose the relationship" },
        { text: "Substitute the values", why: "Use the source" },
        { text: "TEACHER-FINAL-ANSWER-CANARY", why: "TEACHER-FINAL-WHY-CANARY" },
      ],
    });

    const preview = studentSlide(malformed, "hidden");
    expect(preview.content).toMatchObject({
      layout: "steps",
      fadeFrom: 2,
      steps: [{ text: "Write v = fλ" }, { text: "Substitute the values" }, { text: "", why: "" }],
    });
    expect(JSON.stringify(preview)).not.toContain("TEACHER-FINAL");
    expect(studentSlide(malformed, "shown").content).toEqual(malformed.content);
  });

  it("review mode shows the answer but still removes misconceptions and teacher metadata", () => {
    const teacher = slide("check", {
      layout: "quiz",
      question: "Which statement is correct?",
      options: [
        { text: "A", misconception: "TEACHER-MISCONCEPTION-CANARY" },
        { text: "B", misconception: "" },
      ],
      answer: 1,
      explain: "The supported answer is B.",
    });
    const review = studentSlide(teacher, "shown");
    expect(review.content).toMatchObject({ answer: 1, explain: "The supported answer is B." });
    expect(JSON.stringify(review)).not.toMatch(/TEACHER-(?:NOTES|WARNING|VERIFY|MISCONCEPTION)-CANARY/);
  });
});
