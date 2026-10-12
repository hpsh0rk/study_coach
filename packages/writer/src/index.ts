import { z } from "zod";
import { jsonSchemaOf, type AiLayer, type CallContext } from "@kj/ai";
import { PAGE_TYPES } from "@kj/pedagogy";
import { DEFAULT_FLAGS, SlideContent, type AblationFlags, type ConfirmedOutline, type LayoutId, type LessonParams, type PageText, type SlideSpec } from "@kj/schema";
import { BUDGETS, LAYOUTS, SLOT_SCHEMAS } from "@kj/templates";
import { problemsOf, truncateLists } from "./checks.ts";
import { stubSlide } from "./stub.ts";

export { clip, findFormula, stubSlide } from "./stub.ts";
export { problemsOf, truncateLists } from "./checks.ts";
export { buildDirectMessages, DIRECT_PROMPT_VERSION, writeDeckDirect, type DirectDeck, type DirectInput, type DirectSlideResult } from "./direct.ts";

export const PROMPT_VERSION = "slide.write@2";

export interface WriteInput {
  lessonTitle: string;
  params: LessonParams;
  /** All pages of the lesson's selected scope; the writer picks the spec's source pages from them. */
  pages: PageText[];
  ctx: CallContext;
  /** Ablation switches; omitted = full pipeline. */
  flags?: Partial<AblationFlags>;
}

const flagsOf = (input: WriteInput): AblationFlags => ({ ...DEFAULT_FLAGS, ...input.flags });

/** A8: which source text the writer sees. Default = the spec's own source pages. */
export function sourcePagesFor(spec: SlideSpec, input: WriteInput): PageText[] {
  const f = flagsOf(input);
  if (f.writerSource === "none") return [];
  if (f.writerSource === "all") return input.pages;
  const cited = new Set(spec.sourcePages);
  const own = input.pages.filter((p) => cited.has(p.no));
  return own.length ? own : input.pages;
}

export interface WriteResult {
  content: SlideContent;
  notes: string;
  sources: number[];
  warnings: string[];
  providerId: string;
}

export class SpecNotFoundError extends Error {
  constructor(specId: string) {
    super(`slide spec ${specId} is not in the confirmed outline`);
    this.name = "SpecNotFoundError";
  }
}

const NOTES_MAX = 2000;

function outputSchema(layout: LayoutId) {
  const content = SlideContent.options.find((o) => o.shape.layout.value === layout)!;
  return z.object({ content, notes: z.string().max(NOTES_MAX * 2).default("") });
}

function budgetText(layout: LayoutId): string {
  return `Hard content budgets for this layout (words; 1.7 Chinese characters = 1 word): ${JSON.stringify(BUDGETS[layout])}. "soft" is the target, "max" the absolute limit; list "min/max" are item counts.`;
}

const WIDGET_RULES = [
  "Widgets are declarative JSON, never code:",
  '- formula: {"kind":"formula","tex":"v = f\\\\lambda","caption":"..."} (KaTeX).',
  '- function: {"kind":"function","expr":"A*sin(2*pi*x/L)","x":[0,4],"y":[-3,3],"xLabel":"distance / m","yLabel":"displacement / cm","params":[{"name":"A","label":"Amplitude / cm","min":0,"max":3,"step":0.1,"value":2}]} — expr uses only x, param names, numbers, + - * / ^, parentheses, pi, e and sin cos tan sqrt abs exp ln log min max.',
  '- chart: {"kind":"chart","type":"bar|line|scatter","xLabel":"...","yLabel":"... / unit","categories":[...],"series":[{"name":"...","data":[...]}],"focus":0} — ≤ 4 series, ≤ 7 categories, real values from the source only.',
  '- flow: {"kind":"flow","steps":["...", "..."]} — 2–6 short steps.',
  '- sim (experiment only): {"kind":"sim","embedId":"wave-string|pendulum"} or a function widget with sliders.',
].join("\n");

export function buildMessages(spec: SlideSpec, input: WriteInput, outline: ConfirmedOutline["outline"], problems?: string[]) {
  const f = flagsOf(input);
  const pages = sourcePagesFor(spec, input);
  const visualRule =
    spec.layout !== "statement"
      ? ""
      : f.visualPlanning === "writer"
        ? 'Choose the visual kind (formula, function, chart or flow) that best explains this point.'
        : `The visual must be of kind "${spec.visual === "none" || spec.visual === "sim" ? "formula" : spec.visual}".`;
  const lang = input.params.language === "zh" ? "Simplified Chinese" : "English";
  const def = PAGE_TYPES[spec.pageType];
  const system = [
    `You write the on-screen content of ONE slide for a ${input.params.minutes}-minute lesson (student level: ${input.params.level}). Screen text in ${lang}.`,
    input.params.language === "en+zh" ? "Students are Chinese speakers learning in English: give key terms with Chinese translations in `terms` where the layout has them." : "",
    `Layout "${spec.layout}" (${LAYOUTS[spec.layout].label.en}); page type ${spec.pageType} (${def.label.en}), about ${spec.minutes} minutes.`,
    f.budgetsInPrompt ? budgetText(spec.layout) : "",
    "Rules: one teaching point; assertion-style title; short phrases, not paragraphs; no teacher talk or clichés on screen (no 'In this lesson', 'Let's', 'dive into', 'crucial'); use $...$ for inline math.",
    (pages.length ? "Every number, definition and formula must come from the source pages." : "Stay faithful to the slide plan; do not invent numbers.") +
      " Put explanations, a question to ask, the expected answer or common misconception, and timing into `notes` (60–150 words).",
    visualRule,
    spec.layout === "steps" && spec.pageType === "faded" ? "This is a faded example: set fadeFrom so the last 1–2 steps are left for students." : "",
    spec.layout === "quiz" ? "Each wrong option names the misconception it diagnoses; `answer` is the 0-based index of the correct option." : "",
    WIDGET_RULES,
    `Return JSON only: {"content": <slot object>, "notes": "..."} where content matches this JSON Schema: ${JSON.stringify(jsonSchemaOf(SLOT_SCHEMAS[spec.layout]))}`,
  ]
    .filter(Boolean)
    .join("\n");
  const user = [
    `Lesson: ${input.lessonTitle}. Objectives: ${outline.objectives.join("; ")}`,
    `Slide plan: ${JSON.stringify({ title: spec.title, purpose: spec.purpose, keyPoints: spec.keyPoints, ...(f.visualPlanning === "outline" ? { visual: spec.visual } : {}), layout: spec.layout })}`,
    pages.length ? `Source pages:\n${pages.map((p) => `[p.${p.no}] ${p.text.replace(/\s+/g, " ").slice(0, 4000)}`).join("\n")}` : "",
    problems?.length ? `Your previous answer had these problems; fix them:\n${problems.map((p) => `- ${p}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

/**
 * Writes one slide of a confirmed outline. The ConfirmedOutline type can only be produced by the
 * server's store after checking confirmed_at, so this cannot run before the teacher confirms.
 */
export async function writeSlide(ai: AiLayer, confirmed: ConfirmedOutline, specId: string, input: WriteInput): Promise<WriteResult> {
  const spec = confirmed.outline.slides.find((s) => s.id === specId);
  if (!spec) throw new SpecNotFoundError(specId);
  const f = flagsOf(input);
  const pages = sourcePagesFor(spec, input);
  const schema = outputSchema(spec.layout);
  const call = (problems?: string[]) =>
    ai.callStructured({
      capability: "slide.write",
      promptVersion: PROMPT_VERSION,
      schema,
      messages: buildMessages(spec, input, confirmed.outline, problems),
      stub: () => stubSlide({ spec, outline: confirmed.outline, lessonTitle: input.lessonTitle, pages }),
      temperature: 0.4,
      ctx: input.ctx,
    });

  let res = await call();
  let found = problemsOf(res.output.content as SlideContent);
  if (found.errors.length && res.providerId !== "stub" && f.slideCheckRetry) {
    res = await call(found.errors);
    found = problemsOf(res.output.content as SlideContent);
  }
  let content = res.output.content as SlideContent;
  if (found.errors.length && f.truncateFallback) {
    content = truncateLists(content);
    found = problemsOf(content);
  }
  return {
    content,
    notes: res.output.notes.slice(0, NOTES_MAX),
    sources: spec.sourcePages,
    warnings: [...found.errors, ...found.warnings],
    providerId: res.providerId,
  };
}
