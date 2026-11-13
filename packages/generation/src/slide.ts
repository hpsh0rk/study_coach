import { z } from "zod";
import { jsonSchemaOf, type AiLayer, type CallContext } from "@kj/ai";
import { PAGE_TYPES, verifyNumbers } from "@kj/pedagogy";
import { LAYOUT_IDS, SlideContent, type GlossaryEntry, type LayoutId, type LessonParams, type Outline, type PageText, type SlideSpec, type Unverified } from "@kj/schema";
import { BUDGETS, LAYOUTS, SLOT_SCHEMAS } from "@kj/templates";
import { slotIssues, widgetIssues } from "@kj/templates/issues";
import { findEmbed } from "@kj/widgets";
import { applyGlossary, clipToBudgets, healChartFocus, problemsOf, sanitizeWidgets, trimExcessHighlights, truncateLists } from "./checks.ts";
import { optionsOf, type PipelineOptions } from "./options.ts";
import { neutralizeSource, SOURCE_RULE, suspiciousContent } from "./safety.ts";
import { stubSlide } from "./slide-stub.ts";

export const SLIDE_PROMPT_VERSION = "slide.write@10";
/** Source characters the writer sees for one slide. */
export const SLIDE_SOURCE_CHARS = 12_000;

export interface WriteInput {
  lessonTitle: string;
  params: LessonParams;
  /** Pages of the lesson's selection; the writer picks the spec's source pages from them. */
  pages: PageText[];
  ctx: CallContext;
  /** Problem of the preceding worked example, so faded/practice pages stay isomorphic to it. */
  workedProblem?: string;
  /** Optional teacher steering instruction when regenerating a single slide (trimmed, max 200 chars). */
  instruction?: string;
  options?: Partial<PipelineOptions>;
}

export type SlideInput = WriteInput;

/** Source text the writer sees (capped at SLIDE_SOURCE_CHARS). A slide without source pages gets none. */
export function sourcePagesFor(spec: SlideSpec, input: Pick<WriteInput, "pages" | "options">): PageText[] {
  const o = optionsOf(input.options);
  if (o.writerSource === "none") return [];
  const cited = new Set(spec.sourcePages);
  const picked = o.writerSource === "all" ? input.pages : input.pages.filter((p) => cited.has(p.no));
  const out: PageText[] = [];
  let used = 0;
  for (const p of picked) {
    if (used >= SLIDE_SOURCE_CHARS) break;
    const text = p.text.replace(/\s+/g, " ").trim().slice(0, SLIDE_SOURCE_CHARS - used);
    out.push({ ...p, text });
    used += text.length;
  }
  return out;
}

export interface WriteResult {
  content: SlideContent;
  notes: string;
  sources: number[];
  warnings: string[];
  /** 待核实: numbers, formulas and calculations the source check could not confirm. */
  unverified: Unverified[];
  providerId: string;
}

/** 待核实 entries for an outline spec whose source pages were out of range or look shifted. */
export function sourceUnverified(spec: Pick<SlideSpec, "sourceIssue">): Unverified[] {
  const i = spec.sourceIssue;
  if (!i) return [];
  const cited = i.cited.length ? `p.${i.cited.join(", ")}` : "—";
  const suggested = i.suggested.length ? ` · 可能是 p.${i.suggested.join(", ")}` : "";
  return [
    {
      kind: "source",
      text: cited,
      detail: (i.kind === "out-of-range" ? `大纲引用的页不在所选范围内${suggested} · cited page outside the selection` : `引用页和这一页的内容对不上${suggested} · cited page does not match the slide`).slice(0, 200),
    },
  ];
}

/** The text a slide is checked against. No citation means no source support; it must not borrow the selection. */
export function checkSourceText(sourcePages: number[], pages: PageText[]): string {
  const cited = new Set(sourcePages);
  const picked = cited.size ? pages.filter((p) => cited.has(p.no)) : [];
  return picked.map((p) => p.text).join("\n");
}

/** The writer and its deterministic fallbacks could not produce a slide the editor accepts. */
export class SlideInvalidError extends Error {
  constructor(public readonly problems: string[]) {
    super(`slide failed its own validation: ${problems.slice(0, 3).join("; ")}`);
    this.name = "SlideInvalidError";
  }
}

const invalidSlots = (c: SlideContent) => [...slotIssues(c), ...widgetIssues(c)].map((i) => `${i.path.join(".")}: ${i.message}`);

export class SpecNotFoundError extends Error {
  constructor(specId: string) {
    super(`slide spec ${specId} is not in the outline`);
    this.name = "SpecNotFoundError";
  }
}

const NOTES_MAX = 2000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeStepsSlot(slot: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...slot };
  if (out.problem === undefined || out.problem === null) {
    const alias = out.question ?? out.prompt ?? out.task;
    if (typeof alias === "string") out.problem = alias;
  }
  if (Array.isArray(out.steps)) {
    out.steps = out.steps.map((item) => {
      if (typeof item === "string") return { text: item, why: "" };
      if (!isRecord(item)) return item;
      const text =
        typeof item.text === "string"
          ? item.text
          : typeof item.step === "string"
            ? item.step
            : typeof item.label === "string"
              ? item.label
              : typeof item.content === "string"
                ? item.content
                : typeof item.formula === "string"
                  ? item.formula
                  : item.text;
      const rawWhy = item.why ?? item.reason ?? item.explanation ?? item.note;
      return { ...item, ...(text !== undefined ? { text } : {}), why: typeof rawWhy === "string" ? rawWhy : "" };
    });
  }
  let fade = out.fadeFrom;
  if (typeof fade === "string" && /^\s*-?\d+\s*$/.test(fade)) fade = Number(fade);
  if (fade === null || (typeof fade === "number" && (!Number.isInteger(fade) || fade < 1))) delete out.fadeFrom;
  else if (fade !== undefined) out.fadeFrom = fade;
  return out;
}

/**
 * Normalises bare top-level slot objects (`{"layout":"questions","title":...,"items":[...],"notes":"..."}`)
 * and common `steps` output quirks (`fadeFrom: null`, string steps, field aliases) into the canonical
 * `{"content": ..., "notes": "..."}` envelope before strict Zod slot validation runs.
 */
function unwrapSlideEnvelope(layout: LayoutId, raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const finishSlot = (slot: Record<string, unknown>) => {
    const withLayout = slot.layout === undefined ? { layout, ...slot } : slot;
    return layout === "steps" ? normalizeStepsSlot(withLayout) : withLayout;
  };
  if ("content" in raw) {
    const notes = raw.notes === null ? "" : raw.notes;
    if (!isRecord(raw.content) || Object.keys(raw.content).length === 0) return notes !== raw.notes ? { ...raw, notes } : raw;
    return { ...raw, content: finishSlot(raw.content), ...(notes !== undefined ? { notes } : {}) };
  }
  const { notes, ...slot } = raw;
  if (Object.keys(slot).length === 0) return notes === null ? { notes: "" } : raw;
  return {
    content: finishSlot(slot),
    ...(notes !== undefined ? { notes: notes === null ? "" : notes } : {}),
  };
}

const outputSchemas = Object.fromEntries(
  LAYOUT_IDS.map((layout) => {
    const content = SlideContent.options.find((o) => o.shape.layout.value === layout)!;
    const envelope = z.object({ content, notes: z.string().max(NOTES_MAX * 2).default("") });
    return [layout, z.preprocess((raw) => unwrapSlideEnvelope(layout, raw), envelope)];
  }),
) as unknown as Record<LayoutId, z.ZodType<{ content: SlideContent; notes: string }>>;

const envelopeSchemaJson = new Map<string, string>();
function envelopeSchemaText(spec: Pick<SlideSpec, "layout" | "pageType">): string {
  const key = spec.layout === "steps" ? (spec.pageType === "faded" ? "steps:faded" : "steps:worked") : spec.layout;
  let json = envelopeSchemaJson.get(key);
  if (!json) {
    const envelope = structuredClone(jsonSchemaOf(z.object({ content: SLOT_SCHEMAS[spec.layout], notes: z.string() }))) as {
      properties?: { content?: { properties?: Record<string, unknown>; required?: string[] } };
    };
    const contentSchema = envelope.properties?.content;
    if (spec.layout === "steps" && contentSchema?.properties) {
      if (spec.pageType === "faded") {
        contentSchema.properties.fadeFrom = { type: "integer", minimum: 1, maximum: BUDGETS.steps.steps.max - 1 };
        if (Array.isArray(contentSchema.required) && !contentSchema.required.includes("fadeFrom")) contentSchema.required.push("fadeFrom");
      } else {
        delete contentSchema.properties.fadeFrom;
      }
    }
    envelopeSchemaJson.set(key, (json = JSON.stringify(envelope)));
  }
  return json;
}

function budgetText(layout: LayoutId): string {
  return `Hard content budgets for this layout (words; 1.7 Chinese characters = 1 word): ${JSON.stringify(BUDGETS[layout])}. "soft" is the target, "max" the absolute limit; list "min/max" are item counts.`;
}

const WIDGET_RULES = [
  "Widgets are declarative JSON, never code:",
  '- formula: {"kind":"formula","tex":"v = f\\\\lambda","caption":"..."} (KaTeX).',
  '- function: {"kind":"function","expr":"A*sin(2*pi*x/L)","x":[0,4],"y":[-3,3],"xLabel":"distance / m","yLabel":"displacement / cm","params":[{"name":"A","label":"Amplitude / cm","min":0,"max":3,"step":0.1,"value":2}]} — expr uses only x, param names, numbers, + - * / ^, parentheses, pi, e and sin cos tan sqrt abs exp ln log min max.',
  '- chart: {"kind":"chart","type":"bar|line|scatter","xLabel":"...","yLabel":"... / unit","categories":[...],"series":[{"name":"...","data":[...]}],"focus":0} — ≤ 4 series, ≤ 7 categories, real values from the source only; optional "focus" is a 0-based series index (< series.length), omit it when there is only 1 series.',
  '- flow: {"kind":"flow","steps":["...", "..."]} — 2–5 sequential process or causal steps (A → B → C), at most 4 words each; never use standalone conjunctions like "或" or "or" as a step box.',
  '- table: {"kind":"table","columns":["Quantity","Unit"],"rows":[["wavelength","λ / m"]],"caption":"..."} — every row has one cell per column; cells are 1–2 words or a number with unit, taken from the source.',
  '- placeholder: {"kind":"placeholder","hint":"Photo of a ripple tank"} — "图示待补": only when the point needs a picture no widget above can draw.',
].join("\n");

/** Which visual the writer must produce: the outline's choice, a "图示待补" placeholder for "none", or the writer's own pick. */
export function visualRuleFor(spec: SlideSpec, planning: PipelineOptions["visualPlanning"]): string {
  const slotName = spec.layout === "statement" ? "visual" : spec.layout === "chart" ? "chart" : "";
  if (!slotName) return "";
  const allowed = spec.layout === "statement" ? "formula, function, chart, flow or table" : "chart, function or table";
  if (planning === "writer") return `Choose the ${slotName} kind (${allowed}) that best explains this point; use placeholder only if none of them can show it honestly.`;
  if (spec.visual === "none") return `The ${slotName} slot must be {"kind":"placeholder","hint":"..."}: in the hint, name the diagram or photo the teacher should add (at most ${BUDGETS.placeholder.hint.max} words).`;
  const kind = spec.layout === "chart" && !["chart", "function", "table"].includes(spec.visual) ? "chart" : spec.visual === "sim" ? "formula" : spec.visual;
  return `The ${slotName} must be of kind "${kind}".${kind === "table" ? ` ${spec.layout === "statement" ? "Exactly 2 columns" : "2–3 columns"}, at most 4 rows, 1–2 words per cell.` : ""}`;
}

function neighbours(spec: SlideSpec, outline: Outline): string {
  const i = outline.slides.findIndex((s) => s.id === spec.id);
  const prev = outline.slides[i - 1];
  const next = outline.slides[i + 1];
  return [prev ? `previous slide: "${prev.title}"` : "", next ? `next slide: "${next.title}"` : ""].filter(Boolean).join("; ");
}

function glossaryText(glossary: GlossaryEntry[]): string {
  if (!glossary.length) return "";
  return `Lesson glossary — use exactly these terms and translations, never a different one: ${glossary.map((g) => (g.zh ? `${g.term} = ${g.zh}` : g.term)).join("; ")}`;
}

const PROBLEM_PAGE_TYPES = new Set(["worked", "faded", "practice", "check", "exit", "retrieval"]);
const PROBLEM_SLIDE_LAYOUTS = new Set(["steps", "quiz", "questions"]);
const RED_EMPHASIS_FOCUS_RE = /红(?:色|字)|标红|加粗|\bred[\s-]*(?:bold|font|text|highlight)\b|\bbold\s+red\b/i;

export function buildMessages(spec: SlideSpec, input: WriteInput, outline: Outline, problems?: string[]) {
  const o = optionsOf(input.options);
  const pages = sourcePagesFor(spec, input);
  const sim = spec.layout === "experiment" ? findEmbed(`${spec.title} ${spec.keyPoints.join(" ")} ${pages.map((p) => p.text).join(" ")}`) : undefined;
  const visualRule = visualRuleFor(spec, o.visualPlanning);
  const languageRule =
    input.params.language === "zh"
      ? 'Screen text and speaker `notes` in pure Simplified Chinese. On statement slides, `terms` must use Simplified Chinese term names in `term` (with `zh: ""`), never English words unless teaching an explicit English symbol.'
      : input.params.language === "en+zh"
        ? "Bilingual classroom mode (English + Simplified Chinese): keep bullets, stems and options in concise English; place Simplified Chinese only in statement `terms[].zh` chips or brief key-noun parentheses such as `magnetic field lines (磁感线)` (at most 1–2 nouns per item) — never append whole-clause Chinese translations at the end of English sentences."
        : 'Screen text and speaker `notes` in pure English (leave `terms[].zh` empty).';
  const def = PAGE_TYPES[spec.pageType];
  const isProblem = PROBLEM_PAGE_TYPES.has(spec.pageType) || PROBLEM_SLIDE_LAYOUTS.has(spec.layout);
  const workedSpecId = workedSpecFor(outline, spec.id);
  const workedPlan = workedSpecId ? outline.slides.find((s) => s.id === workedSpecId) : undefined;
  const priorWorkedSummary =
    input.workedProblem ?? (workedPlan ? `${workedPlan.title}${workedPlan.keyPoints.length ? ` (${workedPlan.keyPoints.join("; ")})` : ""}` : undefined);
  const sourceRule = isProblem
    ? pages.length
      ? "Every definition, physical law and formula must come from the source pages; for worked, faded, practice and check problems, use numbers planned in `keyPoints` or invent realistic, distinct numbers when the source pages lack distinct exercise numbers."
      : "Stay faithful to the slide plan and core formulas; use realistic, consistent numbers for exercises."
    : pages.length
      ? "Every number, definition and formula must come from the source pages."
      : "Stay faithful to the slide plan; do not invent numbers.";
  const trimmedInstruction = input.instruction?.trim().slice(0, 200);
  const wantsRedEmphasis = RED_EMPHASIS_FOCUS_RE.test(input.params.focus ?? "") || RED_EMPHASIS_FOCUS_RE.test(trimmedInstruction ?? "");
  const system = [
    `You write the on-screen content of ONE slide of a lesson (student level: ${input.params.level}). ${languageRule}`,
    `Layout "${spec.layout}" (${LAYOUTS[spec.layout].label.en}); page type ${spec.pageType} (${def.label.en}), about ${spec.minutes} minutes.`,
    o.budgetsInPrompt ? budgetText(spec.layout) : "",
    "Rules: one teaching point; assertion-style title; short phrases, not paragraphs; no teacher talk or clichés on screen (no 'In this lesson', 'Let's', 'dive into', 'crucial'); use $...$ for inline math; use ==key term or rule== sparingly for red-bold key-phrase emphasis on core takeaways (at most 1–2 short phrases, ≤ 25% of slide words; never highlight whole sentences or slide titles). Do not repeat what the neighbouring slides cover.",
    wantsRedEmphasis
      ? "Teacher emphasis preference: highlight the core physical law, definition or key takeaway on explanatory/summary slides with ==...== (renders as bold red text), keeping highlights selective (≤ 25% of slide words)."
      : "",
    `${sourceRule} Always write non-empty speaker \`notes\` (60–150 words) covering explanation, a question to ask, expected answer or misconception, and timing.`,
    glossaryText(outline.glossary),
    visualRule,
    spec.pageType === "faded"
      ? 'This is a faded example: each item in `steps` is {"text":"...","why":"..."}; set fadeFrom so the last 1–2 steps are left for students (1 ≤ fadeFrom ≤ steps − 1).'
      : spec.layout === "steps"
        ? 'Worked example: each item in `steps` is {"text":"...","why":"..."}; omit `fadeFrom` so every step is shown.'
        : "",
    (spec.pageType === "faded" || spec.pageType === "practice") && priorWorkedSummary
      ? `Use the same problem structure and formula as the preceding worked example ("${priorWorkedSummary}"), but MUST use genuinely DIFFERENT numbers (honor numbers planned in Slide plan keyPoints if given; never clone the worked example's exact numbers).`
      : "",
    spec.pageType === "retrieval" ? "Recap questions test prior knowledge this lesson builds on, not today's new content." : "",
    spec.layout === "quiz"
      ? "Each wrong option names the misconception it diagnoses; `answer` is the 0-based index of the correct option. Ensure the question stem, given conditions, options, `answer` and `explain` never contradict each other (e.g. never ask about 'same mass' while marking 'larger mass' correct). Set `poll: true` when the next part of the lesson depends on this idea (a hinge question the class votes on by show of hands before the answer); otherwise omit it."
      : "",
    spec.layout === "order"
      ? 'Ordering activity: for a sequence or process, mode "order" with the cards in the correct order; for term ↔ definition or cause ↔ effect pairs, mode "match" with each card\'s partner in `match`. The player shuffles the cards; put the answer key in the notes.'
      : "",
    sim ? `The sim slot must be {"kind":"sim","embedId":"${sim.id}"} (${sim.title.en}); write predict/observe/explain for that simulation. Set \`outcome\` to the 0-based index of the prediction the simulation confirms.` : "",
    LAYOUTS[spec.layout].visual === "required" ? WIDGET_RULES : "",
    SOURCE_RULE,
    `Return ONE JSON object with top-level keys "content" and "notes" only (never put slide fields like "layout" or "title" at top level), matching this JSON Schema: ${envelopeSchemaText(spec)}`,
  ]
    .filter(Boolean)
    .join("\n");
  const user = [
    `Lesson: ${input.lessonTitle}. Objectives: ${outline.objectives.join("; ")}`,
    neighbours(spec, outline) ? `Context: ${neighbours(spec, outline)}` : "",
    `Slide plan: ${JSON.stringify({ title: spec.title, purpose: spec.purpose, keyPoints: spec.keyPoints, ...(o.visualPlanning === "outline" && LAYOUTS[spec.layout].visual === "required" ? { visual: spec.visual } : {}), layout: spec.layout })}`,
    pages.length ? `<source>\n${neutralizeSource(pages.map((p) => `[p.${p.no}] ${p.text}`).join("\n"))}\n</source>` : "",
    trimmedInstruction ? `Teacher instruction for regenerating this slide: ${neutralizeSource(trimmedInstruction)}` : "",
    problems?.length ? `Your previous answer had these problems; fix them:\n${problems.map((p) => `- ${p}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

/** The worked example a faded or practice slide mirrors: the nearest preceding worked page. */
export function workedSpecFor(outline: Outline, specId: string): string | undefined {
  const i = outline.slides.findIndex((s) => s.id === specId);
  const spec = outline.slides[i];
  if (!spec || (spec.pageType !== "faded" && spec.pageType !== "practice")) return undefined;
  for (let j = i - 1; j >= 0; j--) if (outline.slides[j]!.pageType === "worked") return outline.slides[j]!.id;
  return undefined;
}

/** Experiment slides always embed the catalog simulation that matches the slide. */
function pinSim(content: SlideContent, spec: SlideSpec, pages: PageText[]): SlideContent {
  if (content.layout !== "experiment") return content;
  const sim = findEmbed(`${spec.title} ${spec.keyPoints.join(" ")} ${pages.map((p) => p.text).join(" ")}`);
  return sim ? { ...content, sim: { kind: "sim", embedId: sim.id } } : content;
}

/** Writes one slide of an outline. The server only calls this for confirmed outline versions. */
export async function writeSlide(ai: AiLayer, outline: Outline, specId: string, input: WriteInput): Promise<WriteResult> {
  const spec = outline.slides.find((s) => s.id === specId);
  if (!spec) throw new SpecNotFoundError(specId);
  const o = optionsOf(input.options);
  const pages = sourcePagesFor(spec, input);
  const call = (problems?: string[]) =>
    ai.callStructured({
      capability: "slide.write",
      promptVersion: SLIDE_PROMPT_VERSION,
      schema: outputSchemas[spec.layout],
      messages: buildMessages(spec, input, outline, problems),
      stub: () => stubSlide({ spec, outline, lessonTitle: input.lessonTitle, pages }),
      temperature: 0.4,
      ctx: input.ctx,
    });

  const finish = (c: SlideContent) => trimExcessHighlights(healChartFocus(pinSim(applyGlossary(c, outline.glossary, input.params.language), spec, pages)));
  const checkText = checkSourceText(spec.sourcePages, input.pages);
  const invented = (c: SlideContent, notes: string) =>
    verifyNumbers(c, checkText, { pageType: spec.pageType, notes, sources: spec.sourcePages })
      .filter((u) => u.kind === "number" || u.kind === "calc")
      .map((u) => (u.kind === "number" ? `number ${u.text}: not on the cited pages (待核实) — use only numbers from the source, or remove it` : `calculation ${u.text}: does not compute (待核实) — ${u.detail}`));
  let res = await call();
  let content = finish(res.output.content);
  let found = problemsOf(content, spec.pageType, res.output.notes);
  const firstInvented = invented(content, res.output.notes);
  if ((found.errors.length || firstInvented.length) && res.providerId !== "stub" && o.slideCheckRetry) {
    res = await call([...found.errors, ...firstInvented]);
    content = finish(res.output.content);
    found = problemsOf(content, spec.pageType, res.output.notes);
  }
  // Fallbacks that always end in a slide the editor accepts (truncateFallback=false is an eval-only ablation).
  const repair = (c: SlideContent) => {
    const fixed = o.truncateFallback ? clipToBudgets(truncateLists(c, spec.pageType)) : c;
    return sanitizeWidgets(fixed);
  };
  let safe = repair(content);
  content = safe.content;
  if (o.truncateFallback && invalidSlots(content).length) {
    const before = invalidSlots(content);
    safe = repair(finish(stubSlide({ spec, outline, lessonTitle: input.lessonTitle, pages }).content));
    content = safe.content;
    if (invalidSlots(content).length) throw new SlideInvalidError(before);
    safe = { ...safe, replaced: [...safe.replaced, `slide → deterministic fallback (${before.slice(0, 2).join("; ")})`] };
  }
  const rawNotes = res.output.notes.trim();
  const notes = (rawNotes ? res.output.notes : stubSlide({ spec, outline, lessonTitle: input.lessonTitle, pages }).notes).slice(0, NOTES_MAX);
  found = problemsOf(content, spec.pageType, notes);
  return {
    content,
    notes,
    sources: spec.sourcePages,
    warnings: [...safe.replaced.map((r) => `widget replaced: ${r}`), ...found.errors, ...found.warnings, ...suspiciousContent(content, notes)],
    unverified: [...sourceUnverified(spec), ...verifyNumbers(content, checkText, { pageType: spec.pageType, notes, sources: spec.sourcePages })].slice(0, 10),
    providerId: res.providerId,
  };
}
