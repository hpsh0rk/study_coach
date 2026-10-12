import { z } from "zod";
import { PageType } from "./outline.ts";
import { ChartSpec, ExperimentSim, FunctionSpec, PlaceholderSpec, TableSpec, VisualSpec } from "./widgets.ts";

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
  chart: z.discriminatedUnion("kind", [ChartSpec, FunctionSpec, TableSpec, PlaceholderSpec]),
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
  /** The prediction the simulation bears out; highlighted next to the class tally at the explain step. */
  outcome: z.number().int().min(0).optional(),
});

export const QuizContent = z.object({
  layout: z.literal("quiz"),
  question: text.min(1),
  options: z.array(z.object({ text: text.min(1), misconception: text.default("") })),
  answer: z.number().int().min(0),
  explain: text.min(1),
  /** Hinge question: the class votes first; the teacher's tally is revealed before the answer. */
  poll: z.boolean().optional(),
});

/** Put items in order (`order`: listed in the right order) or match each item to its `match` (`match`). Shown shuffled. */
export const OrderContent = z.object({
  layout: z.literal("order"),
  title: text.min(1),
  mode: z.enum(["order", "match"]).default("order"),
  items: z.array(z.object({ text: text.min(1), match: text.default("") })),
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
  OrderContent,
  SummaryContent,
]);
export type SlideContent = z.infer<typeof SlideContent>;
export type ContentOf<L extends SlideContent["layout"]> = Extract<SlideContent, { layout: L }>;

/**
 * "待核实": a number, formula or calculation on screen that the deterministic check could not
 * find in the cited source pages (or that does not compute). Teachers verify; nothing is blocked.
 */
export const Unverified = z.object({
  kind: z.enum(["number", "formula", "calc", "source"]),
  text: z.string().max(120),
  detail: z.string().max(200).default(""),
});
export type Unverified = z.infer<typeof Unverified>;

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
  /** The previous content (before the last edit or regeneration) can be restored. */
  canUndo: z.boolean().optional(),
  unverified: z.array(Unverified).optional(),
});
export type Slide = z.infer<typeof Slide>;
