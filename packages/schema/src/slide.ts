import { z } from "zod";
import { PageType } from "./outline.ts";
import { ChartSpec, ExperimentSim, FunctionSpec, VisualSpec } from "./widgets.ts";

/**
 * Structural slot shapes per layout. Text may contain inline math as $...$.
 * Hard content budgets (max items / lengths) are owned by @kj/templates, which refines these.
 */
const text = z.string().trim();

export const TitleContent = z.object({
  layout: z.literal("title"),
  title: text.min(1),
  subtitle: text.default(""),
  objectives: z.array(text.min(1)).default([]),
});

export const StatementContent = z.object({
  layout: z.literal("statement"),
  title: text.min(1),
  bullets: z.array(text.min(1)),
  visual: VisualSpec,
  terms: z.array(z.object({ term: text.min(1), zh: text.default("") })).default([]),
});

export const ChartContent = z.object({
  layout: z.literal("chart"),
  title: text.min(1),
  chart: z.discriminatedUnion("kind", [ChartSpec, FunctionSpec]),
  takeaways: z.array(text.min(1)),
  source: text.default(""),
});

export const StepsContent = z.object({
  layout: z.literal("steps"),
  title: text.min(1),
  problem: text.min(1),
  steps: z.array(z.object({ text: text.min(1), why: text.default("") })),
  /** Faded example: steps from this index are blank boxes until revealed. */
  fadeFrom: z.number().int().min(0).optional(),
});

export const ExperimentContent = z.object({
  layout: z.literal("experiment"),
  title: text.min(1),
  predict: z.object({ question: text.min(1), options: z.array(text.min(1)) }),
  sim: ExperimentSim,
  observe: z.array(text.min(1)),
  explain: text.min(1),
});

export const QuizContent = z.object({
  layout: z.literal("quiz"),
  question: text.min(1),
  options: z.array(z.object({ text: text.min(1), misconception: text.default("") })),
  answer: z.number().int().min(0),
  explain: text.min(1),
});

export const QuestionsContent = z.object({
  layout: z.literal("questions"),
  title: text.min(1),
  items: z.array(z.object({ q: text.min(1), a: text.min(1) })),
});

export const SummaryContent = z.object({
  layout: z.literal("summary"),
  title: text.min(1),
  nodes: z.array(z.object({ head: text.min(1), detail: text.default("") })),
});

export const SlideContent = z.discriminatedUnion("layout", [
  TitleContent,
  StatementContent,
  ChartContent,
  StepsContent,
  ExperimentContent,
  QuizContent,
  QuestionsContent,
  SummaryContent,
]);
export type SlideContent = z.infer<typeof SlideContent>;
export type ContentOf<L extends SlideContent["layout"]> = Extract<SlideContent, { layout: L }>;

export const Slide = z.object({
  id: z.string(),
  specId: z.string(),
  outlineVersionId: z.string(),
  layout: z.string(),
  /** Copied from the SlideSpec so an exported deck can be scored without its outline. */
  pageType: PageType,
  minutes: z.number(),
  content: SlideContent,
  notes: z.string().default(""),
  sources: z.array(z.number().int().min(1)).default([]),
  warnings: z.array(z.string()).default([]),
  /** Slot ids measured as overflowing in a browser (templates measureOverflow); absent = not measured. */
  overflow: z.array(z.string()).optional(),
});
export type Slide = z.infer<typeof Slide>;
