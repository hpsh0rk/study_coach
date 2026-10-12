import type { PageText, PageType, VisualKind } from "@kj/schema";
import { findEmbed } from "@kj/widgets";
import { sentencesOf, shorten } from "./text.ts";
import type { DraftInput, PlannerSection } from "./types.ts";

interface DraftSlide {
  pageType: PageType;
  title: string;
  purpose: string;
  keyPoints: string[];
  visual: VisualKind;
  minutes: number;
  sourcePages: number[];
  loop: number;
}

const FORMULA = /\b[a-zA-Z]\s*=\s*[a-zA-Z0-9]/;

function sectionsOf(input: DraftInput): PlannerSection[] {
  if (input.sections.length) return input.sections;
  const nos = input.pages.map((p) => p.no).sort((a, b) => a - b);
  const out: PlannerSection[] = [];
  for (let i = 0; i < nos.length; i += 2) out.push({ title: `Pages ${nos[i]}–${nos[Math.min(i + 1, nos.length - 1)]}`, pageStart: nos[i]!, pageEnd: nos[Math.min(i + 1, nos.length - 1)]! });
  return out;
}

function textOf(pages: PageText[], s: PlannerSection): string {
  return pages
    .filter((p) => p.no >= s.pageStart && p.no <= s.pageEnd)
    .map((p) => p.text)
    .join(" ");
}

const cleanTitle = (t: string) => t.replace(/^(chapter\s+)?\d+(\.\d+)*\s*/i, "").replace(/\s*\(continued\)\s*/i, "").trim() || t;

/**
 * Deterministic planner used when no model is configured (tests, local dev, CI).
 * Builds the L-02 skeleton from the selected sections and lands on the time budget.
 */
/** One long section becomes 2–3 parts so the lesson still gets several learning loops. */
function loopsOf(input: DraftInput): PlannerSection[] {
  const sections = sectionsOf(input).slice(0, 3);
  if (sections.length !== 1) return sections;
  const s = sections[0]!;
  const span = s.pageEnd - s.pageStart + 1;
  const parts = span >= 9 ? 3 : span >= 5 ? 2 : 1;
  if (parts === 1) return sections;
  const size = Math.ceil(span / parts);
  return Array.from({ length: parts }, (_, k) => ({
    title: `${s.title} (${k + 1}/${parts})`,
    pageStart: s.pageStart + k * size,
    pageEnd: Math.min(s.pageEnd, s.pageStart + (k + 1) * size - 1),
  }));
}

export function stubOutline(input: DraftInput): { objectives: string[]; slides: DraftSlide[] } {
  const sections = loopsOf(input);
  const slides: DraftSlide[] = [];
  const pagesOf = (s: PlannerSection) => {
    const out: number[] = [];
    for (let p = s.pageStart; p <= s.pageEnd; p++) out.push(p);
    return out;
  };
  const all = input.pages.map((p) => p.no);
  const objectives = sections.map((s) => `Explain ${cleanTitle(s.title).toLowerCase()}`).slice(0, 3);

  slides.push({ pageType: "cover", title: cleanTitle(input.lessonTitle), purpose: "Lesson title and objectives", keyPoints: [], visual: "none", minutes: 0.5, sourcePages: [], loop: 0 });
  slides.push({
    pageType: "retrieval",
    title: "Quick recap: what do you remember?",
    purpose: "Activate prior knowledge",
    keyPoints: sections.map((s) => `Recall ${cleanTitle(s.title).toLowerCase()}`).slice(0, 3),
    visual: "none",
    minutes: 4,
    sourcePages: all.slice(0, 2),
    loop: 0,
  });

  let experimentUsed = false;
  sections.forEach((s, i) => {
    const loop = i + 1;
    const text = textOf(input.pages, s);
    const sentences = sentencesOf(text);
    const pages = pagesOf(s);
    const head = cleanTitle(s.title);
    const points = sentences.slice(1, 4).map((x) => shorten(x, 9));
    slides.push({
      pageType: "concept",
      title: shorten(sentences[0] ?? head, 12),
      purpose: `Introduce ${head}`,
      keyPoints: points.length ? points : [head],
      visual: FORMULA.test(text) ? "formula" : "flow",
      minutes: 3,
      sourcePages: pages,
      loop,
    });
    if (FORMULA.test(text)) {
      slides.push({ pageType: "worked", title: `Worked example: ${head}`, purpose: "Model the calculation step by step", keyPoints: points.slice(0, 3), visual: "formula", minutes: 4, sourcePages: pages, loop });
      slides.push({ pageType: "faded", title: `Your turn: finish the last step`, purpose: "Faded example", keyPoints: points.slice(0, 3), visual: "formula", minutes: 3, sourcePages: pages, loop });
    } else if (sentences.length > 4) {
      slides.push({ pageType: "data", title: shorten(sentences[4] ?? head, 12), purpose: `Show ${head} as a graph`, keyPoints: sentences.slice(4, 6).map((x) => shorten(x, 9)), visual: "function", minutes: 2.5, sourcePages: pages, loop });
    }
    const embed = findEmbed(`${s.title} ${text}`);
    if (embed && !experimentUsed) {
      experimentUsed = true;
      slides.push({ pageType: "experiment", title: `Investigate: ${embed.title.en}`, purpose: "Predict, observe, explain", keyPoints: points.slice(0, 2), visual: "sim", minutes: 7, sourcePages: pages, loop });
    }
    slides.push({ pageType: "check", title: `Check: ${head}`, purpose: "Hinge question", keyPoints: points.slice(0, 1).length ? points.slice(0, 1) : [head], visual: "none", minutes: 2, sourcePages: pages, loop });
  });

  const closing = 5 + 2.5 + 3;
  const target = input.params.minutes * 0.95;
  for (let k = 0; slides.reduce((n, x) => n + x.minutes, 0) + closing < target && slides.length < 34; k++) {
    const sec = sections[k % sections.length]!;
    const head = cleanTitle(sec.title);
    const pages = pagesOf(sec);
    slides.push({ pageType: "practice", title: `Apply it: ${head}`, purpose: `Practice round ${k + 1}`, keyPoints: [head], visual: "none", minutes: 6, sourcePages: pages, loop: (k % sections.length) + 1 });
    slides.push({ pageType: "check", title: `Check: ${head}`, purpose: "Hinge question", keyPoints: [head], visual: "none", minutes: 2, sourcePages: pages, loop: (k % sections.length) + 1 });
  }

  slides.push({ pageType: "practice", title: "Practice questions", purpose: "Independent practice", keyPoints: sections.map((s) => cleanTitle(s.title)).slice(0, 3), visual: "none", minutes: 5, sourcePages: all, loop: sections.length });
  slides.push({ pageType: "summary", title: "How the ideas connect", purpose: "Structure of the lesson", keyPoints: sections.map((s) => cleanTitle(s.title)).slice(0, 4), visual: "none", minutes: 2.5, sourcePages: [], loop: 0 });
  slides.push({ pageType: "exit", title: "Exit ticket", purpose: "Check the objectives", keyPoints: objectives.slice(0, 3), visual: "none", minutes: 3, sourcePages: all, loop: 0 });
  return {
    objectives: objectives.length ? objectives : ["Understand the selected pages"],
    slides: slides.map((x) => ({ ...x, title: x.title.slice(0, 160), sourcePages: x.sourcePages.slice(0, 20) })),
  };
}
