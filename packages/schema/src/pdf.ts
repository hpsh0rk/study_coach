import { z } from "zod";

export interface TocEntry {
  title: string;
  /** 1-based page number the bookmark points to. */
  page: number;
  children: TocEntry[];
}

export const TocEntry: z.ZodType<TocEntry> = z.lazy(() =>
  z.object({
    title: z.string().trim().min(1).max(300),
    page: z.number().int().min(1),
    children: z.array(TocEntry).max(200),
  }),
);

export const PageText = z.object({
  no: z.number().int().min(1),
  text: z.string().max(40_000),
  /** Printed page label from the PDF (e.g. "112", "xiv") when it differs from the page index. */
  label: z.string().trim().min(1).max(20).optional(),
});
export type PageText = z.infer<typeof PageText>;

/** Normalised output of PDF parsing (browser pdf.js today; any future parser must produce the same shape). */
export const ParsedPdf = z.object({
  title: z.string().max(300),
  pageCount: z.number().int().min(1).max(3000),
  toc: z.array(TocEntry).max(500),
  pages: z.array(PageText),
});
export type ParsedPdf = z.infer<typeof ParsedPdf>;

export const ChapterNode = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  level: z.number().int().min(1),
  ord: z.number().int().min(0),
  title: z.string(),
  pageStart: z.number().int().min(1),
  pageEnd: z.number().int().min(1),
  words: z.number().int().min(0),
});
export type ChapterNode = z.infer<typeof ChapterNode>;

export const PageRange = z
  .object({ start: z.number().int().min(1), end: z.number().int().min(1) })
  .refine((r) => r.end >= r.start, "end must be >= start");
export type PageRange = z.infer<typeof PageRange>;
