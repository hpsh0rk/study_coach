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

export const Outline = z.object({
  objectives: z.array(z.string().trim().min(1).max(160)).min(1).max(3),
  slides: z.array(SlideSpec).min(1).max(40),
});
export type Outline = z.infer<typeof Outline>;

/**
 * An outline version the teacher has confirmed. Only the server's store constructs it
 * (after checking confirmed_at), so generation code cannot run on an unconfirmed outline.
 */
export type ConfirmedOutline = {
  readonly versionId: string;
  readonly lessonId: string;
  readonly outline: Outline;
  readonly confirmedAt: number;
} & { readonly __brand: "ConfirmedOutline" };
