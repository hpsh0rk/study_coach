import { z } from "zod";
import { PageRange } from "./pdf.ts";

export const Level = z.enum(["basic", "intermediate", "advanced"]);
export type Level = z.infer<typeof Level>;

export const LessonType = z.enum(["new", "review", "lab"]);
export type LessonType = z.infer<typeof LessonType>;

export const TeachingLanguage = z.enum(["en", "zh", "en+zh"]);
export type TeachingLanguage = z.infer<typeof TeachingLanguage>;

export const MAX_FOCUS_CHARS = 1500;

export const LessonParams = z.object({
  minutes: z.number().int().min(10).max(120),
  level: Level,
  lessonType: LessonType,
  language: TeachingLanguage,
  focus: z.string().trim().max(MAX_FOCUS_CHARS).default(""),
});
export type LessonParams = z.infer<typeof LessonParams>;

export const DEFAULT_PARAMS: LessonParams = { minutes: 40, level: "intermediate", lessonType: "new", language: "en+zh", focus: "" };

export const PdfSourceRole = z.enum(["textbook", "past_paper", "workbook"]);
export type PdfSourceRole = z.infer<typeof PdfSourceRole>;

export const PdfLessonSource = z.object({
  id: z.string().trim().min(1).max(60),
  kind: z.literal("pdf"),
  documentId: z.string().trim().min(1).max(60),
  title: z.string().trim().min(1).max(300),
  chapterIds: z.array(z.string()).max(200).optional(),
  ranges: z.array(PageRange).min(1).max(50),
  role: PdfSourceRole.default("textbook"),
});
export type PdfLessonSource = z.infer<typeof PdfLessonSource>;

export const SyllabusLessonSource = z.object({
  id: z.string().trim().min(1).max(60),
  kind: z.literal("syllabus"),
  title: z.string().trim().min(1).max(300),
  text: z.string().trim().max(20_000).default(""),
  items: z.array(z.string().trim().min(1).max(300)).max(80).optional(),
});
export type SyllabusLessonSource = z.infer<typeof SyllabusLessonSource>;

export const NoteLessonSource = z.object({
  id: z.string().trim().min(1).max(60),
  kind: z.literal("note"),
  title: z.string().trim().min(1).max(300),
  text: z.string().trim().max(20_000).default(""),
  items: z.array(z.string().trim().min(1).max(300)).max(80).optional(),
});
export type NoteLessonSource = z.infer<typeof NoteLessonSource>;

export const LessonSource = z.discriminatedUnion("kind", [PdfLessonSource, SyllabusLessonSource, NoteLessonSource]);
export type LessonSource = z.infer<typeof LessonSource>;

/** Virtual page stride for secondary PDF sources (`ord = 0` keeps raw `1..100_000`; `ord = k >= 1` uses `k * 100_000 + pageNo`). */
export const SOURCE_STRIDE = 100_000;

export function encodeSourcePage(pdfIndex: number, pageNo: number): number {
  return pdfIndex * SOURCE_STRIDE + pageNo;
}

export function decodeSourcePage(virtualPage: number): { pdfIndex: number; pageNo: number } {
  const zeroBased = Math.max(0, virtualPage - 1);
  return {
    pdfIndex: Math.floor(zeroBased / SOURCE_STRIDE),
    pageNo: (zeroBased % SOURCE_STRIDE) + 1,
  };
}

export function shortSourceTitle(title: string, maxLen = 24): string {
  const clean = title.replace(/\.pdf$/i, "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean || "PDF";
  const cut = clean.slice(0, maxLen - 1);
  const lastSpace = clean[maxLen - 1] === " " ? maxLen - 1 : cut.lastIndexOf(" ");
  const wordCut = lastSpace >= Math.floor((maxLen - 1) * 0.6) ? cut.slice(0, lastSpace) : cut;
  return `${wordCut.trim()}…`;
}

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
  sources: z.array(LessonSource).max(12).optional(),
  unit: UnitRef.optional(),
});
export type LessonScope = z.infer<typeof LessonScope>;

export const ThemeId = z.enum(["classic", "chalk"]);
export type ThemeId = z.infer<typeof ThemeId>;
