import { z } from "zod";

/**
 * Pipeline switches for ablation runs (docs/design/ablation-plan.md §2).
 * Defaults are the full pipeline; the product always runs with the defaults.
 */
export const AblationFlags = z.object({
  scope: z.enum(["selected", "wholeDocument"]).default("selected"),
  outline: z.enum(["on", "skip"]).default("on"),
  budgetsInPrompt: z.boolean().default(true),
  slideCheckRetry: z.boolean().default(true),
  truncateFallback: z.boolean().default(true),
  outlineCheckRetry: z.boolean().default(true),
  phases: z.boolean().default(true),
  visualPlanning: z.enum(["outline", "writer"]).default("outline"),
  writerSource: z.enum(["pages", "none", "all"]).default("pages"),
  renderMode: z.enum(["templates", "freeHtml"]).default("templates"),
  autoConfirm: z.boolean().default(true),
});
export type AblationFlags = z.infer<typeof AblationFlags>;

export const DEFAULT_FLAGS: AblationFlags = AblationFlags.parse({});
