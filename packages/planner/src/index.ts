import { z } from "zod";
import { jsonSchemaOf, type AiLayer } from "@kj/ai";
import { DEFAULT_FLAGS, Outline, PageType, SlideSpec, VisualKind, type AblationFlags, type LessonParams } from "@kj/schema";
import { checkOutline, outlineTiming, PAGE_TYPES, planBudget, type Violation } from "@kj/pedagogy";
import { layoutForPageType, LAYOUTS, PAGE_TYPE_VISUALS } from "@kj/templates";
import { stubOutline } from "./stub.ts";
import type { DraftInput } from "./types.ts";

export type { DraftInput, PlannerSection } from "./types.ts";

export { stubOutline } from "./stub.ts";
export { shorten, sentencesOf } from "./text.ts";

export const PROMPT_VERSION = "outline.draft@2";

export interface DraftResult {
  outline: Outline;
  warnings: Violation[];
  providerId: string;
}

/** What the model returns: specs without ids; layout is derived from the page type. */
const DraftSpec = SlideSpec.omit({ id: true, layout: true });
const DraftOutline = z.object({ objectives: Outline.shape.objectives, slides: z.array(DraftSpec).min(3).max(40) });
type DraftOutline = z.infer<typeof DraftOutline>;

export const flagsOf = (input: { flags?: Partial<AblationFlags> }): AblationFlags => ({ ...DEFAULT_FLAGS, ...input.flags });

/** The model-facing schema shrinks with A6 (no loop) and A7 (no visual). */
function draftSchema(f: AblationFlags) {
  let spec: z.ZodObject<z.ZodRawShape> = DraftSpec;
  if (!f.phases) spec = spec.omit({ loop: true });
  if (f.visualPlanning === "writer") spec = spec.omit({ visual: true });
  return z.object({ objectives: Outline.shape.objectives, slides: z.array(spec).min(3).max(40) });
}

function pageTypeTable(f: AblationFlags): string {
  return PageType.options
    .map((t) => {
      const d = PAGE_TYPES[t];
      const visual = f.visualPlanning === "outline" ? `, visual one of [${PAGE_TYPE_VISUALS[t].join(", ")}]` : "";
      return `- ${t} (${d.label.en}): ${d.minutes} min (range ${d.range[0]}–${d.range[1]}), ${d.mode}, layout "${LAYOUTS[layoutForPageType(t)].label.en}"${visual}`;
    })
    .join("\n");
}

export function buildMessages(input: DraftInput, problems?: Violation[]) {
  const f = flagsOf(input);
  const b = planBudget(input.params);
  const lang = input.params.language === "zh" ? "Simplified Chinese" : "English";
  const system = [
    "You are an expert secondary-school teacher planning ONE lesson as a time-budgeted slide outline.",
    `Lesson: ${input.params.minutes} minutes, student level ${input.params.level}, lesson type ${input.params.lessonType}. Write titles and key points in ${lang}.`,
    input.params.focus ? `Teacher's focus for this lesson: ${input.params.focus}` : "",
    "Rules:",
    `- The sum of slide minutes must be within ${b.minMinutes}–${b.maxMinutes} minutes (target ${b.minutes}).${f.budgetsInPrompt ? ` Aim for ${b.slideRange[0]}–${b.slideRange[1]} slides.` : ""}`,
    f.phases
      ? "- Skeleton: cover → retrieval (3–5 recap questions) → 2–3 learning loops (each: explanation pages, then student activity) → summary → exit ticket."
      : "- Order the slides from cover to exit ticket.",
    "- Never more than 10 minutes of consecutive lecture pages (concept/process/data/worked/summary) without a check, practice, faded or experiment page.",
    "- A worked example is followed by a faded example or practice. Experiments follow predict–observe–explain.",
    f.budgetsInPrompt
      ? "- One teaching point per slide. Title = a full-sentence assertion (≤ 12 words). 2–3 key points per slide, each ≤ 9 words."
      : "- One teaching point per slide. Title = a full-sentence assertion.",
    f.visualPlanning === "outline" ? "- Concept, process and data pages need a meaningful visual (formula, function plot, chart or flow)." : "",
    "- sourcePages: the textbook pages ([p.N] markers) that support the slide. Stay faithful to the source; do not invent facts.",
    f.phases ? "- loop: learning loop number (1, 2, 3); use 0 for cover, retrieval, summary and exit." : "",
    "Page types:",
    pageTypeTable(f),
    `Return JSON only, matching this JSON Schema: ${JSON.stringify(jsonSchemaOf(draftSchema(f)))}`,
  ]
    .filter(Boolean)
    .join("\n");
  const user = [
    `Lesson title: ${input.lessonTitle}`,
    input.sections.length ? `Selected sections:\n${input.sections.map((s) => `- ${s.title} (pp. ${s.pageStart}–${s.pageEnd})`).join("\n")}` : "",
    `Source text:\n${input.sourceText}`,
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

/** Assigns ids, derives layouts, clamps minutes/visuals/pages to legal values. */
export function normalizeOutline(draft: DraftOutline, validPages: number[], flags: Partial<AblationFlags> = {}): Outline {
  const f = flagsOf({ flags });
  const valid = new Set(validPages);
  const slides = draft.slides.map((s, i) => {
    const def = PAGE_TYPES[s.pageType];
    const visuals = PAGE_TYPE_VISUALS[s.pageType];
    const visual = f.visualPlanning === "writer" ? "none" : visuals.includes(s.visual) ? s.visual : visuals[0]!;
    return SlideSpec.parse({
      ...s,
      id: `sp${i + 1}`,
      layout: layoutForPageType(s.pageType),
      visual: VisualKind.parse(visual),
      loop: f.phases ? s.loop : 0,
      minutes: Math.min(def.range[1], Math.max(def.range[0], s.minutes)),
      sourcePages: [...new Set(s.sourcePages.filter((p) => valid.has(p)))].sort((a, b) => a - b),
      keyPoints: s.keyPoints.slice(0, 6),
    });
  });
  return { objectives: draft.objectives, slides };
}

/** Deterministic L-03 repair: scale minutes toward the lesson length within each page type's range. */
export function rebalanceMinutes(outline: Outline, params: LessonParams): Outline {
  let slides = outline.slides;
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
  return { ...outline, slides };
}

export async function draftOutline(ai: AiLayer, input: DraftInput): Promise<DraftResult> {
  const f = flagsOf(input);
  const validPages = input.pages.map((p) => p.no);
  const call = async (problems?: Violation[]) => {
    const res = await ai.callStructured({
      capability: "outline.draft",
      promptVersion: PROMPT_VERSION,
      schema: draftSchema(f).transform((d) => d as unknown as DraftOutline),
      messages: buildMessages(input, problems),
      stub: () => stubOutline(input),
      temperature: 0.3,
      timeoutMs: 120_000,
      ctx: input.ctx,
    });
    return { outline: normalizeOutline(res.output, validPages, f), providerId: res.providerId };
  };

  let { outline, providerId } = await call();
  let errors = checkOutline(outline, input.params).filter((v) => v.level === "error");
  if (errors.length && providerId !== "stub" && f.outlineCheckRetry) {
    ({ outline, providerId } = await call(errors));
    errors = checkOutline(outline, input.params).filter((v) => v.level === "error");
  }
  if (outlineTiming(outline, input.params).needsAck) outline = rebalanceMinutes(outline, input.params);
  return { outline, warnings: checkOutline(outline, input.params), providerId };
}
