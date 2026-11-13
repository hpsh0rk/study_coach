import type { CallContext } from "@kj/ai";
import type { FigureCatalogEntry, LessonParams, PageText } from "@kj/schema";
import type { PipelineOptions } from "./options.ts";

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
  /** Pages of the selection, with text. */
  pages: PageText[];
  /** Extracted textbook/lesson figures available across the selected pages. */
  figures?: FigureCatalogEntry[];
  ctx: CallContext;
  options?: Partial<PipelineOptions>;
}
