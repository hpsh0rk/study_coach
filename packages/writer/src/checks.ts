import { checkSlide, type Violation } from "@kj/pedagogy";
import type { SlideContent } from "@kj/schema";
import { BUDGETS, SLOT_SCHEMAS } from "@kj/templates";
import { validateWidget, type WidgetIssue } from "@kj/widgets";

function widgetsOf(c: SlideContent) {
  if (c.layout === "statement") return [c.visual];
  if (c.layout === "chart") return [c.chart];
  if (c.layout === "experiment") return [c.sim];
  return [];
}

/** Everything that would make the slide wrong or over budget. */
export function problemsOf(c: SlideContent): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const strict = SLOT_SCHEMAS[c.layout].safeParse(c);
  if (!strict.success) for (const i of strict.error.issues.slice(0, 10)) errors.push(`${i.path.join(".")}: ${i.message}`);
  for (const w of widgetsOf(c)) for (const i of validateWidget(w) as WidgetIssue[]) (i.level === "error" ? errors : warnings).push(`widget: ${i.message}`);
  for (const v of checkSlide(c) as Violation[]) (v.level === "error" ? errors : warnings).push(v.message);
  return { errors, warnings };
}

/** Last-resort, deterministic: trims list lengths to the hard maximum (never cuts sentences). */
export function truncateLists(c: SlideContent): SlideContent {
  const B = BUDGETS;
  switch (c.layout) {
    case "title":
      return { ...c, objectives: c.objectives.slice(0, B.title.objectives.max) };
    case "statement":
      return { ...c, bullets: c.bullets.slice(0, B.statement.bullets.max), terms: c.terms.slice(0, B.statement.terms.max) };
    case "chart":
      return { ...c, takeaways: c.takeaways.slice(0, B.chart.takeaways.max) };
    case "steps":
      return { ...c, steps: c.steps.slice(0, B.steps.steps.max), ...(c.fadeFrom !== undefined ? { fadeFrom: Math.min(c.fadeFrom, Math.min(c.steps.length, B.steps.steps.max) - 1) } : {}) };
    case "experiment":
      return { ...c, predict: { ...c.predict, options: c.predict.options.slice(0, B.experiment.options.max) }, observe: c.observe.slice(0, B.experiment.observe.max) };
    case "quiz": {
      const options = c.options.slice(0, B.quiz.options.max);
      return { ...c, options, answer: Math.min(c.answer, options.length - 1) };
    }
    case "questions":
      return { ...c, items: c.items.slice(0, B.questions.items.max) };
    case "summary":
      return { ...c, nodes: c.nodes.slice(0, B.summary.nodes.max) };
  }
}
