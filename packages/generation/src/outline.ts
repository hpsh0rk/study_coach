import { z } from "zod";
import { jsonSchemaOf, type AiLayer } from "@kj/ai";
import { formatPages, sourceForPages } from "@kj/textbook";
import {
  decodeSourcePage,
  Outline,
  PageType,
  SlideSpec,
  SOURCE_STRIDE,
  VisualKind,
  type FigureCatalogEntry,
  type GlossaryEntry,
  type LessonParams,
  type LessonSource,
  type PageText,
} from "@kj/schema";
import { checkOutline, OUTLINE_SOURCE_CHARS, outlineTiming, PAGE_TYPES, planBudget, type Violation } from "@kj/pedagogy";
import { layoutForPageType, LAYOUTS, PAGE_TYPE_VISUALS } from "@kj/templates";
import type { EmbedEntry } from "@kj/widgets";
import { optionsOf, type PipelineOptions } from "./options.ts";
import { checkSourcePages, enforceCheckCadence } from "./outline-repair.ts";
import { stubOutline } from "./outline-stub.ts";
import { neutralizeSource, SOURCE_RULE } from "./safety.ts";
import { simFor } from "./sims.ts";
import type { DraftInput } from "./types.ts";

export const OUTLINE_PROMPT_VERSION = "outline.draft@6";
export { OUTLINE_SOURCE_CHARS };

export interface DraftResult {
  outline: Outline;
  warnings: Violation[];
  providerId: string;
}

/** What the model returns: specs without ids; layout is derived from the page type. */
const DraftSpec = SlideSpec.omit({ id: true, layout: true, sourceIssue: true });
type DraftOutline = { objectives: Outline["objectives"]; slides: z.infer<typeof DraftSpec>[]; glossary?: GlossaryEntry[]; notCovered?: string[] };

/** The model-facing schema shrinks with phases=false (no loop) and visualPlanning=writer (no visual). */
function draftSchema(o: PipelineOptions) {
  let spec: z.ZodObject<z.ZodRawShape> = DraftSpec;
  if (!o.phases) spec = spec.omit({ loop: true });
  if (o.visualPlanning === "writer") spec = spec.omit({ visual: true });
  return z.object({
    objectives: Outline.shape.objectives,
    slides: z.array(spec).min(3).max(40),
    glossary: Outline.shape.glossary,
    notCovered: Outline.shape.notCovered,
  });
}

const schemaCache = new Map<string, { schema: ReturnType<typeof draftSchema>; json: string }>();
function draftSchemaFor(o: PipelineOptions) {
  const key = `${o.phases}/${o.visualPlanning}`;
  let hit = schemaCache.get(key);
  if (!hit) {
    const schema = draftSchema(o);
    hit = { schema, json: JSON.stringify(jsonSchemaOf(schema)) };
    schemaCache.set(key, hit);
  }
  return hit;
}

const TEXTBOOK_FIGURE_FOCUS_RE =
  /书本.*图|原书.*图|教材.*图|课本.*图|书上.*图|多用.*原图|直接用.*图|\b(?:textbook|book|coursebook|source)\s+(?:figures?|images?|diagrams?|illustrations?|pictures?)\b/i;

export function formatFigureCatalogEntry(f: FigureCatalogEntry): string {
  const loc =
    f.pageNo !== undefined
      ? f.pageNo > SOURCE_STRIDE
        ? `S${decodeSourcePage(f.pageNo).pdfIndex + 1} p.${decodeSourcePage(f.pageNo).pageNo} | sourcePage=${f.pageNo}`
        : `p.${f.pageLabel ?? f.pageNo}`
      : "lesson";
  const labelPart = f.label ? ` ${neutralizeSource(f.label)}` : "";
  const capPart = f.caption ? `: ${neutralizeSource(f.caption)}` : "";
  return `[${loc}${labelPart} (assetId: ${f.assetId})${capPart}]`;
}

function pageTypeTable(o: PipelineOptions, sim: EmbedEntry | undefined, hasFigures = false): string {
  return PageType.options
    .filter((t) => t !== "experiment" || sim)
    .map((t) => {
      const d = PAGE_TYPES[t];
      const allowedVisuals = hasFigures ? PAGE_TYPE_VISUALS[t] : PAGE_TYPE_VISUALS[t].filter((v) => v !== "figure");
      const visual = o.visualPlanning === "outline" ? `, visual one of [${allowedVisuals.join(", ")}]` : "";
      return `- ${t} (${d.label.en}): ${d.minutes} min (range ${d.range[0]}–${d.range[1]}), ${d.mode}, layout "${LAYOUTS[layoutForPageType(t)].label.en}"${visual}`;
    })
    .join("\n");
}

export type MultiSourceDraftInput = DraftInput & {
  sources?: LessonSource[];
};

function syllabusItemsOf(sources: LessonSource[] | undefined): string[] {
  if (!sources?.length) return [];
  const items: string[] = [];
  for (const s of sources) {
    if (s.kind !== "syllabus") continue;
    if (s.items?.length) items.push(...s.items);
    else if (s.text.trim()) {
      items.push(
        ...s.text
          .split(/\r?\n/)
          .map((line) => line.replace(/^\s*(?:[-*•☐☑✓]|\d+[.)])\s*/, "").trim())
          .filter(Boolean),
      );
    }
  }
  return [...new Set(items)].slice(0, 60);
}

function sourceOf(pages: PageText[], multiPdf = false) {
  if (!pages.length) return { text: "", included: [], omitted: [] };
  const isMulti = multiPdf || pages.some((p) => p.no > SOURCE_STRIDE);
  if (!isMulti) return sourceForPages(pages, OUTLINE_SOURCE_CHARS);
  return sourceForPages(pages, OUTLINE_SOURCE_CHARS, (p) => {
    const { pdfIndex, pageNo } = decodeSourcePage(p.no);
    const prefix = pdfIndex === 0 ? `[S1 p.${pageNo}]` : `[S${pdfIndex + 1} p.${pageNo} | sourcePage=${p.no}]`;
    return `${prefix} ${p.text.replace(/\s+/g, " ").trim()}`;
  });
}

export function buildMessages(input: MultiSourceDraftInput, problems?: Violation[]) {
  const o = optionsOf(input.options);
  const b = planBudget(input.params);
  const sim = simFor(input);
  const pdfSources = (input.sources ?? []).filter((s): s is Extract<LessonSource, { kind: "pdf" }> => s.kind === "pdf");
  const noteSources = (input.sources ?? []).filter((s): s is Extract<LessonSource, { kind: "note" }> => s.kind === "note" && !!s.text.trim());
  const syllabusItems = syllabusItemsOf(input.sources);
  const hasExamSource = pdfSources.some((s) => s.role === "past_paper" || s.role === "workbook");
  const isMultiPdf = pdfSources.length > 1 || input.pages.some((p) => p.no > SOURCE_STRIDE);
  const figures = input.figures ?? [];
  const hasFigures = figures.length > 0;
  const wantsTextbookFigures = TEXTBOOK_FIGURE_FOCUS_RE.test(input.params.focus ?? "");
  const langRule =
    input.params.language === "zh"
      ? "Write all titles, objectives, key points, notCovered and glossary terms in pure Simplified Chinese (never English term labels unless teaching an explicit English symbol)."
      : input.params.language === "en+zh"
        ? "Bilingual classroom mode (English + Simplified Chinese): write concise English primary titles and key points paired with Simplified Chinese key terms."
        : "Write all titles, objectives, key points, notCovered and glossary terms in pure English.";
  const system = [
    "You are an expert secondary-school teacher planning ONE lesson as a time-budgeted slide outline.",
    `Lesson: ${input.params.minutes} minutes, student level ${input.params.level}, lesson type ${input.params.lessonType}. ${langRule}`,
    input.params.focus ? `Teacher's focus for this lesson: ${input.params.focus}` : "",
    "Rules:",
    `- The sum of slide minutes must be within ${b.minMinutes}–${b.maxMinutes} minutes (target ${b.minutes}). Time is the only budget; the number of slides follows from it.`,
    "- If the selection holds more than fits the time, teach the core well and list what you leave out in notCovered (short phrases). Do not rush through everything.",
    syllabusItems.length
      ? "- A mandatory Syllabus checklist is provided: cover every checklist item across objectives and slides; only list an item in notCovered if lesson time genuinely makes it impossible."
      : "",
    hasExamSource
      ? "- Attached past_paper / workbook PDF sources contain authentic exam or practice questions: build practice, check, worked or faded slides from them and cite their sourcePage numbers."
      : "",
    o.phases
      ? "- Skeleton: cover → retrieval (3–5 recap questions on prior knowledge the lesson builds on, not on today's new content) → 2–3 learning loops (each loop MUST contain both explanation pages AND at least one student check/activity page) → summary → exit ticket."
      : "- Order the slides from cover to exit ticket.",
    "- Never more than 10 minutes of consecutive lecture pages (concept/process/data/worked/summary) without a check, practice, faded, sequence or experiment page.",
    "- A sequence page (cards students put in order or match) suits a process, cycle or set of term–definition pairs; at most one per loop.",
    "- A worked example is followed by a faded example or practice built on the same problem structure with genuinely different numbers.",
    sim
      ? `- At most one experiment page, using the simulation "${sim.title.en}" (predict–observe–explain).`
      : "- No interactive simulation fits this content: do not plan experiment pages.",
    o.budgetsInPrompt
      ? "- One teaching point per slide. Title = a full-sentence assertion (≤ 12 words). 2–3 key points per slide, each ≤ 9 words."
      : "- One teaching point per slide. Title = a full-sentence assertion.",
    o.visualPlanning === "outline"
      ? hasFigures
        ? '- Concept, process and data pages need a meaningful visual (formula, function plot, chart, flow, table or figure). Choose "figure" when an extracted textbook diagram in Available textbook figures directly illustrates the teaching point, and cite that figure\'s page in sourcePages. Choose "none" only when none of these apply.'
        : '- Concept, process and data pages need a meaningful visual (formula, function plot, chart, flow or a small table). Choose "none" only when the point needs a picture none of these can draw; the slide then shows a "图示待补" placeholder for the teacher.'
      : "",
    hasFigures && wantsTextbookFigures
      ? '- Teacher figure preference: actively select visual "figure" on concept, process or data slides whenever a relevant textbook diagram is available on the cited pages.'
      : "",
    isMultiPdf
      ? "- sourcePages: cite the exact integer sourcePage of each supporting page (for S1 use the page number N; for S2+ use the `sourcePage=...` integer shown on that line). Stay faithful to the sources; do not invent facts."
      : "- sourcePages: the textbook pages ([p.N] markers) that support the slide. Stay faithful to the source; do not invent facts.",
    o.phases ? "- loop: learning loop number (1, 2, 3); use 0 for cover, retrieval, summary and exit." : "",
    input.params.language === "en+zh"
      ? "- glossary: the key English terms of the lesson with ONE Simplified Chinese translation each; every slide will use these."
      : input.params.language === "zh"
        ? "- glossary: the key Simplified Chinese terms of the lesson (`term` in Simplified Chinese, `zh` empty string)."
        : "- glossary: the key English terms of the lesson (`zh` empty string).",
    `- ${SOURCE_RULE}`,
    "Page types:",
    pageTypeTable(o, sim, hasFigures),
    `Return JSON only, matching this JSON Schema: ${draftSchemaFor(o).json}`,
  ]
    .filter(Boolean)
    .join("\n");
  const user = [
    `Lesson title: ${input.lessonTitle}`,
    input.sections.length ? `Selected sections:\n${input.sections.map((s) => `- ${s.title} (pp. ${s.pageStart}–${s.pageEnd})`).join("\n")}` : "",
    pdfSources.length > 1
      ? `Attached PDF sources:\n${pdfSources
          .map((s, idx) =>
            idx === 0
              ? `- S1 (${s.role}): ${neutralizeSource(s.title)} — cite page N directly`
              : `- S${idx + 1} (${s.role}): ${neutralizeSource(s.title)} — cite virtual sourcePage (${idx * SOURCE_STRIDE} + page)`,
          )
          .join("\n")}`
      : "",
    syllabusItems.length ? `Syllabus checklist (MUST cover all items):\n${syllabusItems.map((it, idx) => `${idx + 1}. ${neutralizeSource(it)}`).join("\n")}` : "",
    noteSources.length ? `Teacher reference notes:\n${noteSources.map((n) => `- ${neutralizeSource(n.title)}: ${neutralizeSource(n.text)}`).join("\n")}` : "",
    hasFigures ? `Available textbook figures on selected pages:\n${figures.slice(0, 60).map((f) => `- ${formatFigureCatalogEntry(f)}`).join("\n")}` : "",
    `<source>\n${neutralizeSource(sourceOf(input.pages, isMultiPdf).text)}\n</source>`,
    problems?.length ? `Your previous outline broke these rules; fix them:\n${problems.map((p) => `- ${p.message}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

const roundHalf = (n: number) => Math.max(0.5, Math.round(n * 2) / 2);

interface NormalizeContext {
  validPages: number[];
  /** Experiment pages become practice pages when no catalog simulation fits. */
  simAvailable: boolean;
  /** Whether extracted textbook/lesson figures exist; without them `visual: "figure"` downgrades to default. */
  figuresAvailable?: boolean;
  /** Text of the selection, for the source-page match check. */
  pages?: PageText[];
  options?: Partial<PipelineOptions>;
}

function resolveVirtualCitations(sourcePages: number[], validPages: number[]): number[] {
  if (!validPages.some((v) => v > SOURCE_STRIDE)) return sourcePages;
  const validSet = new Set(validPages);
  return sourcePages.map((p) => {
    if (validSet.has(p) || p > SOURCE_STRIDE) return p;
    const candidates = validPages.filter((v) => v > SOURCE_STRIDE && decodeSourcePage(v).pageNo === p);
    return candidates.length === 1 ? candidates[0]! : p;
  });
}

/**
 * Assigns ids, derives layouts, clamps minutes/visuals to legal values, flags (never silently drops)
 * bad source pages and inserts check pages so no lecture run exceeds 10 minutes.
 */
export function normalizeOutline(draft: DraftOutline, ctx: NormalizeContext): Outline {
  const o = optionsOf(ctx.options);
  const slides = draft.slides.map((s, i) => {
    const pageType: PageType = s.pageType === "experiment" && !ctx.simAvailable ? "practice" : s.pageType;
    const def = PAGE_TYPES[pageType];
    const visuals = ctx.figuresAvailable ? PAGE_TYPE_VISUALS[pageType] : PAGE_TYPE_VISUALS[pageType].filter((v) => v !== "figure");
    const visual = o.visualPlanning === "writer" ? "none" : visuals.includes(s.visual) ? s.visual : visuals[0]!;
    return SlideSpec.parse({
      ...s,
      sourcePages: resolveVirtualCitations(s.sourcePages ?? [], ctx.validPages),
      pageType,
      id: `sp${i + 1}`,
      layout: layoutForPageType(pageType),
      visual: VisualKind.parse(visual),
      loop: o.phases ? s.loop : 0,
      minutes: Math.min(def.range[1], Math.max(def.range[0], s.minutes)),
      keyPoints: s.keyPoints.slice(0, 6),
    });
  });
  const checked = enforceCheckCadence(checkSourcePages(slides, ctx.validPages, ctx.pages));
  return Outline.parse({ objectives: draft.objectives, slides: checked, glossary: draft.glossary ?? [], notCovered: draft.notCovered ?? [] });
}

/** Deterministic L-03 repair: scale minutes toward the lesson length within each page type's range (check cadence kept). */
export function rebalanceMinutes(outline: Outline, params: LessonParams): Outline {
  let slides = enforceCheckCadence(outline.slides);
  for (let i = 0; i < 4; i++) {
    const total = slides.reduce((n, s) => n + s.minutes, 0);
    if (Math.abs(total - params.minutes) / params.minutes <= 0.05) break;
    const factor = params.minutes / total;
    slides = slides.map((s) => {
      const [lo, hi] = PAGE_TYPES[s.pageType].range;
      const m = s.pageType === "cover" ? s.minutes : roundHalf(Math.min(hi, Math.max(lo, s.minutes * factor)));
      return { ...s, minutes: m };
    });
  }
  return Outline.parse({ ...outline, slides: enforceCheckCadence(slides) });
}

export async function draftOutline(ai: AiLayer, input: MultiSourceDraftInput): Promise<DraftResult> {
  const o = optionsOf(input.options);
  const ctx: NormalizeContext = {
    validPages: input.pages.map((p) => p.no),
    simAvailable: !!simFor(input),
    figuresAvailable: !!(input.figures && input.figures.length > 0),
    pages: input.pages,
    options: o,
  };
  const isMultiPdf = (input.sources ?? []).filter((s) => s.kind === "pdf").length > 1 || input.pages.some((p) => p.no > SOURCE_STRIDE);
  const { omitted } = sourceOf(input.pages, isMultiPdf);
  const labels = new Map(input.pages.flatMap((p) => (p.label ? [[p.no, p.label] as const] : [])));
  const call = async (problems?: Violation[]) => {
    const res = await ai.callStructured({
      capability: "outline.draft",
      promptVersion: OUTLINE_PROMPT_VERSION,
      schema: draftSchemaFor(o).schema.transform((d) => d as unknown as DraftOutline),
      messages: buildMessages(input, problems),
      stub: () => stubOutline(input),
      temperature: 0.3,
      timeoutMs: 120_000,
      ctx: input.ctx,
    });
    return { outline: normalizeOutline(res.output, ctx), providerId: res.providerId };
  };

  const rebalance = (x: Outline) => (outlineTiming(x, input.params).needsAck ? rebalanceMinutes(x, input.params) : x);
  const errors = (x: Outline) => checkOutline(x, input.params).filter((v) => v.level === "error");
  let { outline, providerId } = await call();
  // Rebalancing repairs most timing errors without a model call; only what it cannot fix (e.g. too few slides) is retried.
  outline = rebalance(outline);
  if (providerId !== "stub" && o.outlineCheckRetry && errors(outline).length) {
    ({ outline, providerId } = await call(errors(outline)));
    outline = rebalance(outline);
  }
  if (omitted.length) outline = { ...outline, notCovered: [`pp. ${formatPages(omitted, labels)}：原文过长未读入 · not read (source too long)`.slice(0, 200), ...outline.notCovered].slice(0, 20) };
  return { outline, warnings: checkOutline(outline, input.params), providerId };
}
