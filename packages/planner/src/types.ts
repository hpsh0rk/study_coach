import type { CallContext } from "@kj/ai";
import type { AblationFlags, LessonParams, PageText } from "@kj/schema";

export interface PlannerSection {
  title: string;
  pageStart: number;
  pageEnd: number;
}

export interface DraftInput {
  lessonTitle: string;
  params: LessonParams;
  /** Selected chapters (leaf sections) in reading order; empty when the teacher picked raw page ranges. */
  sections: PlannerSection[];
  /** Selected pages with text. */
  pages: PageText[];
  /** Source text with [p.N] markers (pdf-structure textForRanges). */
  sourceText: string;
  ctx: CallContext;
  /** Ablation switches; omitted = full pipeline. */
  flags?: Partial<AblationFlags>;
}
