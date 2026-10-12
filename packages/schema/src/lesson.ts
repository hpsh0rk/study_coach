import { z } from "zod";
import { PageRange } from "./pdf.ts";

export const Level = z.enum(["basic", "intermediate", "advanced"]);
export type Level = z.infer<typeof Level>;

export const LessonType = z.enum(["new", "review", "lab"]);
export type LessonType = z.infer<typeof LessonType>;

export const TeachingLanguage = z.enum(["en", "zh", "en+zh"]);
export type TeachingLanguage = z.infer<typeof TeachingLanguage>;

export const LessonParams = z.object({
  minutes: z.number().int().min(10).max(120),
  level: Level,
  lessonType: LessonType,
  language: TeachingLanguage,
  focus: z.string().trim().max(200).default(""),
});
export type LessonParams = z.infer<typeof LessonParams>;

export const DEFAULT_PARAMS: LessonParams = { minutes: 40, level: "intermediate", lessonType: "new", language: "en+zh", focus: "" };

/** A lesson planned as part of a unit ("整单元规划"): lesson `index` (1-based) of `count`. */
export const UnitRef = z.object({
  id: z.string().max(40),
  title: z.string().max(200),
  index: z.number().int().min(1).max(20),
  count: z.number().int().min(1).max(20),
});
export type UnitRef = z.infer<typeof UnitRef>;

export const LessonScope = z.object({
  chapterIds: z.array(z.string()).max(200),
  ranges: z.array(PageRange).min(1).max(50),
  unit: UnitRef.optional(),
});
export type LessonScope = z.infer<typeof LessonScope>;

export const ThemeId = z.enum(["classic", "chalk"]);
export type ThemeId = z.infer<typeof ThemeId>;
