import { z } from "zod";
import {
  ChartContent,
  ChartSpec,
  countWords,
  FlowSpec,
  FormulaSpec,
  FunctionSpec,
  PlaceholderSpec,
  TableSpec,
  ExperimentContent,
  QuestionsContent,
  QuizContent,
  StatementContent,
  StepsContent,
  SummaryContent,
  TitleContent,
  type LayoutId,
  type PageType,
  type SlideContent,
  type VisualKind,
} from "@kj/schema";

export { LAYOUT_IDS } from "@kj/schema";

import { BUDGETS, type ListBudget, type TextBudget } from "./budgets.ts";

export * from "./budgets.ts";

export interface LayoutDef {
  id: LayoutId;
  label: { zh: string; en: string };
  visual: "required" | "optional" | "none";
}

export const LAYOUTS: Record<LayoutId, LayoutDef> = {
  title: { id: "title", label: { zh: "封面", en: "Title" }, visual: "none" },
  statement: { id: "statement", label: { zh: "要点 + 图示", en: "Statement + visual" }, visual: "required" },
  chart: { id: "chart", label: { zh: "图表 + 结论", en: "Chart + takeaways" }, visual: "required" },
  steps: { id: "steps", label: { zh: "分步例题", en: "Step-by-step" }, visual: "optional" },
  experiment: { id: "experiment", label: { zh: "实验（预测-观察-解释）", en: "Experiment (POE)" }, visual: "required" },
  quiz: { id: "quiz", label: { zh: "选择题", en: "Quiz" }, visual: "none" },
  questions: { id: "questions", label: { zh: "问答题组", en: "Questions" }, visual: "none" },
  summary: { id: "summary", label: { zh: "结构小结", en: "Summary map" }, visual: "none" },
};

const PAGE_TYPE_LAYOUT: Record<PageType, LayoutId> = {
  cover: "title",
  retrieval: "questions",
  concept: "statement",
  process: "statement",
  data: "chart",
  worked: "steps",
  faded: "steps",
  practice: "questions",
  experiment: "experiment",
  check: "quiz",
  summary: "summary",
  exit: "questions",
};

export function layoutForPageType(pageType: PageType): LayoutId {
  return PAGE_TYPE_LAYOUT[pageType];
}

/** Visual kinds a page type may use; the first is the default. */
export const PAGE_TYPE_VISUALS: Record<PageType, VisualKind[]> = {
  cover: ["none"],
  retrieval: ["none"],
  concept: ["formula", "function", "chart", "flow", "table", "none"],
  process: ["flow", "formula", "function", "table", "none"],
  data: ["chart", "table", "function", "none"],
  worked: ["formula", "none"],
  faded: ["formula", "none"],
  practice: ["none"],
  experiment: ["sim", "function"],
  check: ["none"],
  summary: ["none"],
  exit: ["none"],
};

const within = (b: TextBudget) => (s: string) => countWords(s) <= b.max;
const msg = (what: string, b: TextBudget) => `${what}: at most ${b.max} words (about ${Math.round(b.max * 1.7)} Chinese characters)`;
const str = (what: string, b: TextBudget) => z.string().trim().min(1).max(b.max * 12).refine(within(b), msg(what, b));
const optStr = (what: string, b: TextBudget) => z.string().trim().max(b.max * 12).refine(within(b), msg(what, b)).default("");
const arr = <T extends z.ZodType>(item: T, b: ListBudget) => z.array(item).min(b.min).max(b.max);

const B = BUDGETS;

type TableBudget = (typeof BUDGETS)["table"] | (typeof BUDGETS)["tableNarrow"];
const tableSlot = (b: TableBudget) =>
  TableSpec.extend({
    columns: arr(str("column heading", b.columns.item), b.columns),
    rows: arr(z.array(z.string().trim().max(b.rows.item.max * 12).refine(within(b.rows.item), msg("table cell", b.rows.item))), b.rows),
    caption: z.string().trim().max(b.caption.max * 12).refine(within(b.caption), msg("table caption", b.caption)).optional(),
  }).refine((t) => t.rows.every((r) => r.length === t.columns.length), { message: "every table row needs one cell per column", path: ["rows"] });
/** Table in the chart slot (up to 3 columns). */
export const TABLE_SLOT = tableSlot(B.table);
/** Table in the statement visual column (exactly 2 columns). */
export const TABLE_NARROW_SLOT = tableSlot(B.tableNarrow);
export const PLACEHOLDER_SLOT = PlaceholderSpec.extend({ hint: optStr("placeholder hint", B.placeholder.hint) });

/** Budget-refined slot schemas: these go to the model as JSON Schema and validate its output. */
export const SLOT_SCHEMAS = {
  title: TitleContent.extend({
    title: str("title", B.title.title),
    subtitle: optStr("subtitle", B.title.subtitle),
    objectives: arr(str("objective", B.title.objectives.item), B.title.objectives),
  }),
  statement: StatementContent.extend({
    title: str("title", B.statement.title),
    visual: z.discriminatedUnion("kind", [ChartSpec, FunctionSpec, FlowSpec, FormulaSpec, TABLE_NARROW_SLOT, PLACEHOLDER_SLOT]),
    bullets: arr(str("bullet", B.statement.bullets.item), B.statement.bullets).refine((xs) => xs.reduce((n, s) => n + countWords(s), 0) <= B.statement.bodyTotal.max, `bullets: at most ${B.statement.bodyTotal.max} words in total`),
    terms: arr(z.object({ term: str("term", B.statement.terms.item), zh: z.string().trim().max(12).default("") }), B.statement.terms),
  }),
  chart: ChartContent.extend({
    title: str("title", B.chart.title),
    chart: z.discriminatedUnion("kind", [ChartSpec, FunctionSpec, TABLE_SLOT, PLACEHOLDER_SLOT]),
    takeaways: arr(str("takeaway", B.chart.takeaways.item), B.chart.takeaways),
    source: optStr("source", B.chart.source),
  }),
  steps: StepsContent.extend({
    title: str("title", B.steps.title),
    problem: str("problem", B.steps.problem),
    steps: arr(z.object({ text: str("step", B.steps.steps.item), why: optStr("why", B.steps.why) }), B.steps.steps),
  }),
  experiment: ExperimentContent.extend({
    title: str("title", B.experiment.title),
    predict: z.object({ question: str("prediction question", B.experiment.question), options: arr(str("option", B.experiment.options.item), B.experiment.options) }),
    observe: arr(str("observation prompt", B.experiment.observe.item), B.experiment.observe),
    explain: str("explanation", B.experiment.explain),
  }),
  quiz: QuizContent.extend({
    question: str("question", B.quiz.question),
    options: arr(z.object({ text: str("option", B.quiz.options.item), misconception: optStr("misconception", B.quiz.misconception) }), B.quiz.options),
    explain: str("explanation", B.quiz.explain),
  }).refine((q) => q.answer < q.options.length, { message: "answer must index an option", path: ["answer"] }),
  questions: QuestionsContent.extend({
    title: str("title", B.questions.title),
    items: arr(z.object({ q: str("question", B.questions.items.item), a: str("answer", B.questions.answer) }), B.questions.items),
  }),
  summary: SummaryContent.extend({
    title: str("title", B.summary.title),
    nodes: arr(z.object({ head: str("node heading", B.summary.nodes.item), detail: optStr("node detail", B.summary.detail) }), B.summary.nodes),
  }),
} satisfies Record<LayoutId, z.ZodType>;

export function slotSchema(layout: LayoutId): z.ZodType<SlideContent> {
  return SLOT_SCHEMAS[layout] as unknown as z.ZodType<SlideContent>;
}

/** Number of reveal steps after the initial state (clicker "next" walks through them first). */
export function stepsOf(content: SlideContent): number {
  switch (content.layout) {
    case "title":
      return 0;
    case "statement":
      return Math.max(0, content.bullets.length - 1);
    case "chart":
      return content.takeaways.length;
    case "steps":
      return Math.max(0, content.steps.length - (content.fadeFrom ?? 0));
    case "experiment":
      return 2;
    case "quiz":
      return 1;
    case "questions":
      return content.items.length;
    case "summary":
      return Math.max(0, content.nodes.length - 1);
  }
}

export * from "./samples.ts";
