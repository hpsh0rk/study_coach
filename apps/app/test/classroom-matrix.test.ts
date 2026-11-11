import { describe, expect, it } from "vitest";
import type { Slide } from "@kj/schema";
import { CLASSROOM_FIXTURES, type ClassroomSlide } from "@kj/templates/testing/classroom";
import { studentSlide } from "../src/store.ts";

function row(slide: ClassroomSlide, i: number): Slide {
  return {
    id: `slide-${i}`,
    specId: slide.specId,
    outlineVersionId: "ov-fixture",
    layout: slide.content.layout,
    pageType: slide.pageType,
    minutes: 3,
    content: slide.content,
    notes: slide.notes,
    sources: slide.sources,
    warnings: [],
    unverified: [],
  };
}

describe.each(CLASSROOM_FIXTURES)("$id student answer boundary", (fixture) => {
  it("removes every teacher-only canary from the hidden-answer payload", () => {
    const teacher = fixture.slides.map(row);
    const student = teacher.map((slide) => studentSlide(slide, "hidden"));
    const teacherJson = JSON.stringify(teacher);
    const studentJson = JSON.stringify(student);
    for (const canary of fixture.oracle.teacherOnlyCanaries) {
      expect(teacherJson).toContain(canary);
      expect(studentJson).not.toContain(canary);
    }
    expect(student.every((slide) => slide.notes === "" && slide.warnings.length === 0 && slide.unverified?.length === 0)).toBe(true);
  });
});

it("fails closed when a faded activity is missing fadeFrom", () => {
  const base = CLASSROOM_FIXTURES[0]!.slides.find((slide) => slide.pageType === "faded")!;
  if (base.content.layout !== "steps") throw new Error("fixture");
  const { fadeFrom: _missing, ...content } = base.content;
  const adversarial = row({ ...base, content }, 0);
  expect(JSON.stringify(studentSlide(adversarial, "hidden"))).not.toContain("KEY-EN");
});
