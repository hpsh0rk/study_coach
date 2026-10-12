import { z } from "zod";

/** Every PdfParser adapter writes exactly this shape, so downstream never depends on the parser. */
export const ParsedDocument = z.object({
  parser: z.object({ id: z.string(), version: z.string() }),
  pageCount: z.number().int().nonnegative(),
  pages: z.array(
    z.object({
      no: z.number().int().positive(),
      width: z.number(),
      height: z.number(),
      imageKey: z.string().optional(),
    }),
  ),
  toc: z.array(z.object({ title: z.string(), level: z.number().int().positive(), page: z.number().int().positive() })).optional(),
  blocks: z.array(
    z.object({
      id: z.string(),
      page: z.number().int().positive(),
      bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      type: z.enum(["heading", "text", "figure", "table", "formula", "caption", "list"]),
      text: z.string().optional(),
      latex: z.string().optional(),
      html: z.string().optional(),
      imageKey: z.string().optional(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});
export type ParsedDocument = z.infer<typeof ParsedDocument>;

export const ChapterNode = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  ord: z.number().int().nonnegative(),
  level: z.number().int().positive(),
  title: z.string(),
  pageStart: z.number().int().positive(),
  pageEnd: z.number().int().positive(),
  wordCount: z.number().int().nonnegative(),
  estSlides: z.number().int().nonnegative(),
});
export type ChapterNode = z.infer<typeof ChapterNode>;
