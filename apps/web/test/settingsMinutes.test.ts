import { describe, expect, it } from "vitest";
import { LessonParams } from "@kj/schema";
import { clampLessonMinutes, parseTypedLessonMinutes } from "../src/pages/wizard/SettingsStep.tsx";

describe("SettingsStep custom lesson minutes input", () => {
  it("does not prematurely clamp intermediate keystrokes like '5' on the way to '50', and clamps/rounds to valid integers [10, 120] on blur", () => {
    expect(parseTypedLessonMinutes("")).toBeNull();
    expect(parseTypedLessonMinutes("5")).toBeNull();
    expect(parseTypedLessonMinutes("50")).toBe(50);
    expect(parseTypedLessonMinutes("42.5")).toBeNull();
    expect(parseTypedLessonMinutes("150")).toBeNull();

    for (const [raw, expected] of [
      ["", 40],
      ["5", 10],
      ["50", 50],
      ["42.4", 42],
      ["42.6", 43],
      ["180", 120],
      ["abc", 40],
    ] as const) {
      const minutes = clampLessonMinutes(raw);
      expect(minutes).toBe(expected);
      expect(LessonParams.shape.minutes.safeParse(minutes).success).toBe(true);
    }
  });
});
