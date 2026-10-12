import { z } from "zod";

export const PAGE_TYPE_IDS = ["cover", "retrieval", "concept", "process", "data", "worked", "faded", "practice", "experiment", "check", "summary", "exit"] as const;
export const PageType = z.enum(PAGE_TYPE_IDS);
export type PageType = z.infer<typeof PageType>;

export const LAYOUT_IDS = ["title", "statement", "chart", "steps", "experiment", "quiz", "questions", "summary"] as const;
export const LayoutId = z.enum(LAYOUT_IDS);
export type LayoutId = z.infer<typeof LayoutId>;

export const VisualKind = z.enum(["none", "chart", "function", "flow", "formula", "sim"]);
export type VisualKind = z.infer<typeof VisualKind>;

export const SlideSpec = z.object({
  id: z.string().min(1).max(40),
  pageType: PageType,
  layout: LayoutId,
  /** Assertion-style title: the one teaching point of the page (P-01, P-02). */
  title: z.string().trim().min(1).max(160),
  purpose: z.string().trim().max(200).default(""),
  keyPoints: z.array(z.string().trim().min(1).max(160)).max(6).default([]),
  visual: VisualKind.default("none"),
  minutes: z.number().min(0.2).max(15),
  sourcePages: z.array(z.number().int().min(1)).max(20).default([]),
  /** Learning loop index; 0 = opening/closing pages. */
  loop: z.number().int().min(0).max(6).default(0),
});
export type SlideSpec = z.infer<typeof SlideSpec>;

/** One translation per term for the whole lesson, so every slide uses the same wording (Q-22). */
export const GlossaryEntry = z.object({
  term: z.string().trim().min(1).max(60),
  zh: z.string().trim().max(30).default(""),
});
export type GlossaryEntry = z.infer<typeof GlossaryEntry>;

export const Outline = z.object({
  objectives: z.array(z.string().trim().min(1).max(160)).min(1).max(3),
  slides: z.array(SlideSpec).min(1).max(40),
  glossary: z.array(GlossaryEntry).max(30).default([]),
  /** Parts of the selection the lesson does not cover (time or source-length limits). */
  notCovered: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
});
export type Outline = z.infer<typeof Outline>;
