import { z } from "zod";
import { jsonSchemaOf, type AiLayer, type CallContext } from "@kj/ai";
import { PAGE_TYPES } from "@kj/pedagogy";
import { DEFAULT_FLAGS, Outline, PageType, SlideContent, type AblationFlags, type LessonParams } from "@kj/schema";
import { BUDGETS, layoutForPageType } from "@kj/templates";
import { problemsOf, truncateLists } from "./checks.ts";

export const DIRECT_PROMPT_VERSION = "deck.direct@1";

const DirectSlide = z.object({
  pageType: PageType,
  minutes: z.number().min(0.2).max(15),
  sourcePages: z.array(z.number().int().min(1)).max(20).default([]),
  content: SlideContent,
  notes: z.string().default(""),
});
const DirectDeck = z.object({ objectives: Outline.shape.objectives, slides: z.array(DirectSlide).min(3).max(40) });
export type DirectDeck = z.infer<typeof DirectDeck>;

export interface DirectInput {
  lessonTitle: string;
  params: LessonParams;
  sourceText: string;
  validPages: number[];
  ctx: CallContext;
  flags?: Partial<AblationFlags>;
}

export interface DirectSlideResult {
  pageType: PageType;
  minutes: number;
  sources: number[];
  content: SlideContent;
  notes: string;
  warnings: string[];
}

export function buildDirectMessages(input: DirectInput) {
  const f = { ...DEFAULT_FLAGS, ...input.flags };
  const lang = input.params.language === "zh" ? "Simplified Chinese" : "English";
  const types = PageType.options.map((t) => `- ${t}: ${PAGE_TYPES[t].minutes} min, layout "${layoutForPageType(t)}"`).join("\n");
  const system = [
    `You write a complete slide deck for ONE ${input.params.minutes}-minute lesson (student level ${input.params.level}, lesson type ${input.params.lessonType}). Screen text in ${lang}.`,
    "Each slide has a pageType, minutes, sourcePages ([p.N] markers), slot content for the layout of its page type, and speaker notes.",
    "The sum of minutes should match the lesson length. One teaching point per slide; assertion-style titles; no teacher talk on screen.",
    f.budgetsInPrompt ? `Content budgets per layout (words): ${JSON.stringify(BUDGETS)}` : "",
    "Page types:",
    types,
    `Return JSON only, matching this JSON Schema: ${JSON.stringify(jsonSchemaOf(DirectDeck))}`,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: `Lesson title: ${input.lessonTitle}\n\nSource text:\n${input.sourceText}` },
  ];
}

/** A2 ablation: no outline step; one call writes every slide straight into the layout slot schemas. */
export async function writeDeckDirect(ai: AiLayer, input: DirectInput, stub: () => DirectDeck) {
  const f = { ...DEFAULT_FLAGS, ...input.flags };
  const valid = new Set(input.validPages);
  const res = await ai.callStructured({
    capability: "slide.write",
    promptVersion: DIRECT_PROMPT_VERSION,
    schema: DirectDeck,
    messages: buildDirectMessages(input),
    stub,
    temperature: 0.4,
    timeoutMs: 240_000,
    ctx: input.ctx,
  });
  const slides: DirectSlideResult[] = res.output.slides.map((s) => {
    let content = s.content;
    let found = problemsOf(content);
    if (found.errors.length && f.truncateFallback) {
      content = truncateLists(content);
      found = problemsOf(content);
    }
    const expected = layoutForPageType(s.pageType);
    const mismatch = content.layout !== expected ? [`layout ${content.layout} does not match page type ${s.pageType} (${expected})`] : [];
    return {
      pageType: s.pageType,
      minutes: s.minutes,
      sources: [...new Set(s.sourcePages.filter((p) => valid.has(p)))].sort((a, b) => a - b),
      content,
      notes: s.notes.slice(0, 2000),
      warnings: [...mismatch, ...found.errors, ...found.warnings],
    };
  });
  return { objectives: res.output.objectives, slides, providerId: res.providerId };
}
