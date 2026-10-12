import { z } from "zod";
import { OutlineItem, SlideSlots } from "@kj/schema";
import { findGlossaryTerms } from "./glossary.ts";
import type { ChatMessage } from "./providers.ts";

export interface CapabilityDef<I extends z.ZodType, O extends z.ZodType> {
  name: string;
  promptVersion: string;
  input: I;
  output: O;
  /** Plan §7.1: generation capabilities require a confirmed-outline gate token. */
  requiresGate: boolean;
  timeoutMs: number;
  temperature: number;
  buildMessages(input: z.infer<I>): ChatMessage[];
  /** Deterministic output used when no provider is configured (local dev, CI, evals). */
  stub(input: z.infer<I>): z.input<O>;
}

export function defineCapability<I extends z.ZodType, O extends z.ZodType>(def: CapabilityDef<I, O>): CapabilityDef<I, O> {
  return def;
}

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25 && s.length <= 180 && /[a-z]/.test(s));
}

const JSON_RULES =
  "Respond with a single JSON object only, no markdown fences. Never invent ids or coordinates; the layout engine places content.";

export const slideGenerate = defineCapability({
  name: "slide.generate",
  promptVersion: "slide.generate@1",
  input: z.object({
    outlineItem: OutlineItem,
    sourceText: z.string().max(12_000),
    course: z.object({ name: z.string(), teachingLanguage: z.enum(["en", "zh"]) }).default({ name: "IGCSE Physics", teachingLanguage: "en" }),
  }),
  output: SlideSlots,
  requiresGate: true,
  timeoutMs: 90_000,
  temperature: 0.4,
  buildMessages(input) {
    return [
      {
        role: "system",
        content: [
          `You write one slide for a bilingual ${input.course.name} lesson taught in English to Chinese-speaking G10 students.`,
          "Bullets are concise English teaching points (max 6, each under 25 words), faithful to the source text.",
          "terms: up to 5 key subject terms from the slide with standard Simplified Chinese translations.",
          "notes.en: 2-4 speaker notes for the teacher. notes.zhTerms: same terms, optionally with a short note.",
          'layout: "title-bullets-terms" when there are terms, otherwise "title-bullets".',
          `JSON shape: ${JSON.stringify(z.toJSONSchema(SlideSlots, { io: "input" }))}`,
          JSON_RULES,
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({ outlineItem: input.outlineItem, sourceText: input.sourceText }),
      },
    ];
  },
  stub(input) {
    const title = input.outlineItem.title.replace(/^\d+(\.\d+)*\s+/, "").trim() || input.outlineItem.title;
    const fromPoints = input.outlineItem.points.filter(Boolean);
    const heading = input.outlineItem.title.replace(/\s+/g, " ").trim();
    const body = input.sourceText.replace(/\s+/g, " ").split(heading).join(" ").replace(/\(continued\)/gi, " ");
    const fromSource = sentences(body);
    const bullets = (fromPoints.length >= 2 ? fromPoints : fromSource).slice(0, 5);
    if (bullets.length === 0) bullets.push(`Key ideas of ${title}`);
    const terms = findGlossaryTerms(`${title} ${bullets.join(" ")}`, 5);
    return {
      layout: terms.length ? ("title-bullets-terms" as const) : ("title-bullets" as const),
      title: title.slice(0, 120),
      bullets,
      terms,
      notes: {
        en: [
          `Introduce "${title}" and link it to the previous lesson.`,
          bullets[0] ? `Emphasise: ${bullets[0]}` : "Ask students what they already know.",
          "Check understanding with a quick cold-call question before moving on.",
        ],
        zhTerms: terms.map((t) => ({ term: t.term, zh: t.zh })),
      },
    };
  },
});

export const outlineDraft = defineCapability({
  name: "outline.draft",
  promptVersion: "outline.draft@1",
  input: z.object({
    chapters: z.array(z.object({ id: z.string(), title: z.string(), subtitles: z.array(z.string()) })).min(1),
    lessonMinutes: z.number().int().positive().default(40),
  }),
  output: z.object({
    items: z.array(z.object({ title: z.string(), points: z.array(z.string()), chapterIds: z.array(z.string()) })).min(1),
  }),
  requiresGate: false,
  timeoutMs: 60_000,
  temperature: 0.3,
  buildMessages(input) {
    return [
      { role: "system", content: `Draft a lesson outline: one item per slide, each with 2-4 points. ${JSON_RULES}` },
      { role: "user", content: JSON.stringify(input) },
    ];
  },
  stub(input) {
    return { items: input.chapters.map((c) => ({ title: c.title, points: c.subtitles.slice(0, 4), chapterIds: [c.id] })) };
  },
});

export const CAPABILITIES = {
  "slide.generate": slideGenerate,
  "outline.draft": outlineDraft,
} as const;

export type CapabilityName = keyof typeof CAPABILITIES;
export type CapabilityInput<N extends CapabilityName> = z.input<(typeof CAPABILITIES)[N]["input"]>;
export type CapabilityOutput<N extends CapabilityName> = z.infer<(typeof CAPABILITIES)[N]["output"]>;

/** Planned M1a capabilities not wired yet; listed so admin routing UI can show them. */
export const PLANNED_CAPABILITIES = [
  "ingest.correct.targeted",
  "ingest.figure.caption",
  "chapter.summarize",
  "clarify.detect",
  "theme.adjust",
  "outline.revise",
  "slide.notes",
  "asset.rerank",
  "embed.text",
] as const;
