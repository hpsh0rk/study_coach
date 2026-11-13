import { checkSlide, type Violation } from "@kj/pedagogy";
import { hasCjk, type GlossaryEntry, type PageType, type SlideContent, type TableSpec, type TeachingLanguage, type WidgetSpec } from "@kj/schema";
import { BUDGETS } from "@kj/templates";
import { slotIssues } from "@kj/templates/issues";
import { validateWidget, type WidgetIssue } from "@kj/widgets";

function widgetsOf(c: SlideContent) {
  if (c.layout === "statement") return [c.visual];
  if (c.layout === "chart") return [c.chart];
  if (c.layout === "experiment") return [c.sim];
  return [];
}

const STANDALONE_CONJUNCTION = /^(?:或|或者|和|与|及|or|and)$/i;

/** Everything that would make the slide wrong or over budget. */
export function problemsOf(c: SlideContent, pageType?: PageType, notes?: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const msg of new Set(slotIssues(c).map((i) => `${i.path.join(".")}: ${i.message}`))) if (errors.length < 12) errors.push(msg);
  for (const w of widgetsOf(c)) {
    for (const i of validateWidget(w) as WidgetIssue[]) (i.level === "error" ? errors : warnings).push(`widget: ${i.message}`);
    if (w.kind === "flow" && w.steps.some((s) => STANDALONE_CONJUNCTION.test(s.trim()))) {
      errors.push('widget: flow steps must be sequential stages, never standalone conjunctions like "或"');
    }
  }
  for (const v of checkSlide(c) as Violation[]) (v.level === "error" ? errors : warnings).push(v.message);
  if (pageType === "faded" && c.layout === "steps" && !(c.fadeFrom !== undefined && c.fadeFrom >= 1 && c.fadeFrom <= c.steps.length - 1)) {
    errors.push(`fadeFrom: a faded example hides the last steps (1 ≤ fadeFrom ≤ ${c.steps.length - 1})`);
  }
  if (notes !== undefined && !notes.trim()) {
    errors.push("notes: speaker notes must not be empty — include explanation, a question to ask, and timing");
  }
  return { errors, warnings };
}

function trimTable<T extends { kind: string }>(w: T, b: (typeof BUDGETS)["table"] | (typeof BUDGETS)["tableNarrow"]): T {
  if (w.kind !== "table") return w;
  const t = w as unknown as TableSpec;
  const n = Math.min(t.columns.length, b.columns.max);
  return { ...t, columns: t.columns.slice(0, n), rows: t.rows.slice(0, b.rows.max).map((r) => r.slice(0, n)) } as unknown as T;
}

/** Last-resort, deterministic: trims list lengths to the hard maximum (never cuts sentences). */
export function truncateLists(c: SlideContent, pageType?: PageType): SlideContent {
  const B = BUDGETS;
  if (pageType === "faded" && c.layout === "steps" && c.steps.length >= 2) {
    const steps = c.steps.slice(0, B.steps.steps.max);
    const ok = c.fadeFrom !== undefined && c.fadeFrom >= 1 && c.fadeFrom <= steps.length - 1;
    return { ...c, steps, fadeFrom: ok ? c.fadeFrom : steps.length - 1 };
  }
  switch (c.layout) {
    case "title":
      return { ...c, objectives: c.objectives.slice(0, B.title.objectives.max) };
    case "statement":
      return {
        ...c,
        bullets: c.bullets.slice(0, B.statement.bullets.max),
        terms: c.terms.slice(0, B.statement.terms.max),
        visual: c.visual.kind === "flow" ? { ...c.visual, steps: c.visual.steps.slice(0, B.flow.max) } : trimTable(c.visual, B.tableNarrow),
      };
    case "chart":
      return { ...c, takeaways: c.takeaways.slice(0, B.chart.takeaways.max), chart: trimTable(c.chart, B.table) };
    case "steps": {
      const steps = c.steps.slice(0, B.steps.steps.max);
      const fadeFrom = pageType === "worked" ? undefined : c.fadeFrom !== undefined && c.fadeFrom >= 1 && c.fadeFrom < steps.length ? c.fadeFrom : undefined;
      const { fadeFrom: _drop, ...rest } = c;
      return { ...rest, steps, ...(fadeFrom !== undefined ? { fadeFrom } : {}) };
    }
    case "experiment": {
      const options = c.predict.options.slice(0, B.experiment.options.max);
      const outcome = c.outcome !== undefined && c.outcome < options.length ? c.outcome : undefined;
      const { outcome: _drop, ...rest } = c;
      return { ...rest, ...(outcome !== undefined ? { outcome } : {}), predict: { ...c.predict, options }, observe: c.observe.slice(0, B.experiment.observe.max) };
    }
    case "quiz": {
      const options = c.options.slice(0, B.quiz.options.max);
      return { ...c, options, answer: Math.min(c.answer, options.length - 1) };
    }
    case "questions":
      return { ...c, items: c.items.slice(0, B.questions.items.max) };
    case "order":
      return { ...c, items: c.items.slice(0, B.order.items.max) };
    case "summary":
      return { ...c, nodes: c.nodes.slice(0, B.summary.nodes.max) };
  }
}

const TOO_LONG = /at most|too long|太长|最多/i;

function at(root: unknown, path: PropertyKey[]): unknown {
  return path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<PropertyKey, unknown>)[k] : undefined), root);
}

const URL_PATH_FRAGMENT = /\s*(?:https?:\/\/\S+|www\.\S+|[A-Za-z0-9][A-Za-z0-9-]*\.[a-z]{2,}\/\S*|(?:^|(?<=\s))[a-z0-9_-]{2,}(?:\/[a-z0-9_.-]{2,}){2,}[)]?)\s*/g;
const DANGLING_CJK_TAIL = /[的与和或及在于把被向从跟对等之]+$/;
const BROKEN_PHYSICS_COMPOUND: [RegExp, string][] = [
  [/匀速直线运$/, "匀速"],
  [/牛顿第([一二三])定$/, "牛顿第$1定律"],
  [/万有引力定$/, "万有引力"],
  [/机械能守$/, "机械能"],
  [/动量守$/, "动量"],
];

/** Replaces balanced `$...$` spans with same-length placeholders so boundary scans never cut inside math. */
function maskBalancedMath(s: string): string {
  return s.replace(/\$\$[^$]+\$\$|\$[^$]+\$/g, (m) => "\uE000".repeat(m.length));
}

function cleanTrimmedTail(s: string): string {
  let out = s.replace(/[\s,;:，；：、—–+= -]+$/, "").trim();
  out = out.replace(DANGLING_CJK_TAIL, "").replace(/[\s,;:，；：、—–-]+$/, "").trim();
  for (const [broken, replacement] of BROKEN_PHYSICS_COMPOUND) {
    if (broken.test(out)) out = out.replace(broken, replacement);
  }
  return out;
}

/**
 * Shortens `s` by one semantic step: URL footers first, then trailing parentheticals or clauses,
 * treating balanced `$...$` spans as atomic so a formula is never sliced open.
 */
function shorter(s: string): string {
  const noLink = s.replace(URL_PATH_FRAGMENT, " ").trim();
  if (noLink !== s.trim() && noLink) return noLink;
  const t = s.trim();
  if (!t) return t;

  // Repair an already-unmatched `$` first by dropping the broken tail from the stray `$`.
  const singleDollars = [...t.replace(/\$\$/g, "  ").matchAll(/\$/g)];
  if (singleDollars.length % 2 === 1) {
    const strayAt = singleDollars[singleDollars.length - 1]!.index!;
    const before = cleanTrimmedTail(t.slice(0, strayAt));
    return before || t.replace(/\$/g, "");
  }

  const masked = maskBalancedMath(t);

  // 1. Trailing parenthetical outside `$...$`
  const paren = /^(.*\S)\s*(?:（[^（）\uE000]*）|\([^()\uE000]*\))$/.exec(masked);
  if (paren) {
    const candidate = cleanTrimmedTail(t.slice(0, paren[1]!.length));
    if (candidate) return candidate;
  }

  // 2. Last clause boundary outside `$...$` (`，`, `；`, `：`, `,`, `;`, `—`, `–`)
  let lastSep = -1;
  for (let i = masked.length - 1; i >= 2; i--) {
    if (/[，；：,;—–]/.test(masked[i]!)) {
      lastSep = i;
      break;
    }
  }
  if (lastSep >= 2) {
    const candidate = cleanTrimmedTail(t.slice(0, lastSep));
    if (candidate.length >= 2) return candidate;
  }

  // 3. Trailing CJK disjunction/conjunction phrase (`…保持静止或匀速直线运动` -> `…保持静止`)
  const conjMatch = /^(.*[\u3400-\u9fff]{2,})(?:或者|以及|并且|或|与|和|及)[\u3400-\u9fffA-Za-z0-9\s]+$/.exec(masked);
  if (conjMatch) {
    const candidate = cleanTrimmedTail(t.slice(0, conjMatch[1]!.length));
    if (candidate.length >= 2) return candidate;
  }

  // 4. Atomic balanced `$...$` at the end: drop whole span if preceded by prose, never slice inside it
  const trailingMath = /^(.*?)\s*[=:：，,；;≈∝]?\s*(\$\$[^$]+\$\$|\$[^$]+\$)$/.exec(t);
  if (trailingMath) {
    const prefix = cleanTrimmedTail(trailingMath[1]!);
    return prefix || t;
  }

  // 5. Fallback token / CJK trim outside math
  const cut = /[\u3400-\u9fff]$/.test(t) ? t.slice(0, -1) : t.replace(/\s*[^\s$]+$/, "");
  const cleaned = cleanTrimmedTail(cut);
  return cleaned || cut.replace(/[\s,;:，；：、—-]+$/, "");
}

/**
 * Last-resort, deterministic: shortens every text slot that is over its hard budget (word or character
 * limit) until the slot schema accepts it, so no saved slide fails the editor's own validation.
 */
export function clipToBudgets(c: SlideContent): SlideContent {
  const out = structuredClone(c) as SlideContent;
  for (let guard = 0; guard < 600; guard++) {
    const issue = slotIssues(out).find((i) => TOO_LONG.test(i.message) && typeof at(out, i.path) === "string" && (at(out, i.path) as string).trim().length > 0);
    if (!issue) break;
    const key = issue.path[issue.path.length - 1]!;
    const parent = at(out, issue.path.slice(0, -1)) as Record<PropertyKey, unknown>;
    const next = shorter(parent[key] as string);
    if (next === parent[key]) break;
    parent[key] = next;
  }
  return out;
}

/** Replaces term translations with the lesson glossary's, and keeps pure-Chinese (`zh`) slides free of English term chips. */
export function applyGlossary(c: SlideContent, glossary: GlossaryEntry[], language?: TeachingLanguage): SlideContent {
  if (c.layout !== "statement") return c;
  const zh = new Map(glossary.filter((g) => g.zh).map((g) => [g.term.toLowerCase(), g.zh]));
  const mapped = glossary.length ? c.terms.map((t) => ({ ...t, zh: zh.get(t.term.toLowerCase()) ?? t.zh })) : c.terms;
  if (language !== "zh") return { ...c, terms: mapped };
  return {
    ...c,
    terms: mapped.map((t) => {
      const zhText = t.zh.trim();
      if (zhText && hasCjk(zhText) && !hasCjk(t.term)) return { term: zhText, zh: "" };
      if (hasCjk(t.term) && zhText === t.term.trim()) return { term: t.term.trim(), zh: "" };
      return t;
    }),
  };
}

const PLACEHOLDER_HINT = "Visual could not be drawn; add a diagram";

/**
 * Last-resort, deterministic: a visual that still fails validation (e.g. an expression that does not
 * compile) is replaced by the "图示待补" placeholder (experiment plots by a safe wave), so a saved slide always renders.
 */
export function sanitizeWidgets(c: SlideContent): { content: SlideContent; replaced: string[] } {
  const bad = (w: WidgetSpec | undefined) => !!w && validateWidget(w).some((i) => i.level === "error");
  const why = (w: WidgetSpec) => validateWidget(w).find((i) => i.level === "error")?.message ?? "invalid";
  const placeholder = { kind: "placeholder" as const, hint: PLACEHOLDER_HINT };
  if (c.layout === "statement" && bad(c.visual)) return { content: { ...c, visual: placeholder }, replaced: [`visual → 图示待补 (${why(c.visual)})`] };
  if (c.layout === "chart" && bad(c.chart)) return { content: { ...c, chart: placeholder }, replaced: [`chart → 图示待补 (${why(c.chart)})`] };
  if (c.layout === "experiment" && bad(c.sim)) {
    const safe = { kind: "function" as const, expr: "A*sin(2*pi*x/L)", x: [0, 4] as [number, number], y: [-3, 3] as [number, number], xLabel: "distance / m", yLabel: "displacement / cm", params: [
      { name: "A", label: "Amplitude A / cm", min: 0.5, max: 3, step: 0.1, value: 2 },
      { name: "L", label: "Wavelength λ / m", min: 0.5, max: 4, step: 0.1, value: 2 },
    ] };
    return { content: { ...c, sim: safe }, replaced: [`sim → default wave plot (${why(c.sim)})`] };
  }
  return { content: c, replaced: [] };
}
