/**
 * Switches that turn individual pipeline stages off for the ablation study. The product always
 * runs with the defaults; only tools/eval passes anything else.
 */
export interface PipelineOptions {
  /** Content budgets and density rules in the prompts. */
  budgetsInPrompt: boolean;
  /** Retry the outline once with the rule violations. */
  outlineCheckRetry: boolean;
  /** Retry a slide once with the budget/rule violations. */
  slideCheckRetry: boolean;
  /** Deterministically trim lists that are still over budget. */
  truncateFallback: boolean;
  /** Learning-loop structure in the outline. */
  phases: boolean;
  /** Who picks each slide's visual: the outline or the slide writer. */
  visualPlanning: "outline" | "writer";
  /** Source text the slide writer sees: the slide's own pages, none, or the whole selection. */
  writerSource: "pages" | "none" | "all";
}

export const DEFAULT_OPTIONS: Readonly<PipelineOptions> = Object.freeze({
  budgetsInPrompt: true,
  outlineCheckRetry: true,
  slideCheckRetry: true,
  truncateFallback: true,
  phases: true,
  visualPlanning: "outline",
  writerSource: "pages",
});

export const optionsOf = (o?: Partial<PipelineOptions>): PipelineOptions => ({ ...DEFAULT_OPTIONS, ...o });
