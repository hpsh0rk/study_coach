import type { ExperimentSim, FunctionSpec, Outline, PageText, PlaceholderSpec, SlideContent, SlideSpec, TableSpec, VisualSpec } from "@kj/schema";
import { BUDGETS } from "@kj/templates";
import { findEmbed } from "@kj/widgets";
import { clip, glossaryFrom, quantitiesIn, sentencesOf } from "./text.ts";

const PREDICT: Record<string, { question: string; options: string[]; observe: string[] }> = {
  "wave-string": {
    question: "What happens to the wavelength if frequency increases?",
    options: ["It gets longer", "It gets shorter", "It stays the same"],
    observe: ["Double the frequency", "Measure the new wavelength"],
  },
  pendulum: {
    question: "What happens to the period with a longer string?",
    options: ["It gets longer", "It gets shorter", "It stays the same"],
    observe: ["Double the string length", "Time ten swings"],
  },
};

function termsFor(text: string, outline: Outline, max: number): { term: string; zh: string }[] {
  const lower = text.toLowerCase();
  const fromGlossary = outline.glossary.filter((g) => lower.includes(g.term.toLowerCase())).map((g) => ({ term: g.term, zh: g.zh }));
  return (fromGlossary.length ? fromGlossary : glossaryFrom(text, max)).slice(0, max);
}

function pad<T>(xs: T[], min: number, make: (i: number) => T): T[] {
  const out = [...xs];
  while (out.length < min) out.push(make(out.length));
  return out;
}

interface Formula {
  lhs: string;
  a: string;
  b: string;
  tex: string;
}

const GREEK: Record<string, string> = { lambda: "\\lambda", theta: "\\theta", omega: "\\omega", rho: "\\rho" };
const tex = (v: string) => GREEK[v.toLowerCase()] ?? v;

/** Detects "v = f x lambda" / "F = m × a" style products in textbook text. */
export function findFormula(text: string): Formula | undefined {
  const m = /\b([A-Za-z])\s*=\s*([A-Za-z]+)\s*(?:x|×|\*)\s*([A-Za-z]+)\b/.exec(text);
  if (!m) return undefined;
  const [, lhs, a, b] = m as unknown as [string, string, string, string];
  return { lhs, a, b, tex: `${tex(lhs)} = ${tex(a)}${tex(b).startsWith("\\") ? "" : " \\times "}${tex(b)}` };
}

const waveFn = (params: boolean): FunctionSpec => ({
  kind: "function",
  expr: "A*sin(2*pi*x/L)",
  x: [0, 4],
  y: [-3, 3],
  xLabel: "distance / m",
  yLabel: "displacement / cm",
  params: params
    ? [
        { name: "A", label: "Amplitude A / cm", min: 0.5, max: 3, step: 0.1, value: 2 },
        { name: "L", label: "Wavelength λ / m", min: 0.5, max: 4, step: 0.1, value: 2 },
      ]
    : [],
});

const placeholderFor = (spec: SlideSpec): PlaceholderSpec => ({ kind: "placeholder", hint: clip(`Diagram: ${spec.title}`, BUDGETS.placeholder.hint.max) });

/** Quantity | (symbol) | unit table from the source, else term | 中文 from the glossary; none if fewer than two rows. */
export function stubTable(source: string, outline: Outline, narrow: boolean): TableSpec | undefined {
  const b = narrow ? BUDGETS.tableNarrow : BUDGETS.table;
  const q = quantitiesIn(source).slice(0, b.rows.max);
  if (q.length >= 2) {
    return narrow
      ? { kind: "table", columns: ["Quantity", "Unit"], rows: q.map((x) => [x.term, `${x.symbol} / ${x.unit}`]) }
      : { kind: "table", columns: ["Quantity", "Symbol", "Unit"], rows: q.map((x) => [x.term, x.symbol, x.unit]), caption: "SI units used in this section" };
  }
  const lower = source.toLowerCase();
  const terms = (outline.glossary.length ? outline.glossary.filter((g) => g.zh && lower.includes(g.term.toLowerCase())) : glossaryFrom(source, b.rows.max)).slice(0, b.rows.max);
  if (terms.length >= 2) return { kind: "table", columns: ["Term", "中文"], rows: terms.map((t) => [clip(t.term, 2), t.zh]) };
  return undefined;
}

function visualFor(spec: SlideSpec, source: string, bullets: string[], outline: Outline): VisualSpec {
  const formula = findFormula(source);
  switch (spec.visual) {
    case "table":
      return stubTable(source, outline, true) ?? placeholderFor(spec);
    case "none":
      return placeholderFor(spec);
    case "formula":
      if (formula) return { kind: "formula", tex: formula.tex, caption: `${formula.lhs}: ${formula.a} × ${formula.b}` };
      break;
    case "function":
    case "chart":
      return waveFn(true);
    default:
      break;
  }
  if (formula && spec.visual !== "flow") return { kind: "formula", tex: formula.tex };
  const steps = pad(bullets.map((b) => clip(b, BUDGETS.flow.item.max).slice(0, 40)), 3, (i) => `Step ${i + 1}`).slice(0, BUDGETS.flow.soft);
  return { kind: "flow", steps };
}

export interface StubInput {
  spec: SlideSpec;
  outline: Outline;
  lessonTitle: string;
  pages: PageText[];
}

/** Deterministic slide content within every hard budget (used when no model is configured). */
export function stubSlide(input: StubInput): { content: SlideContent; notes: string } {
  const { spec, outline } = input;
  const source = input.pages.map((p) => p.text).join(" ");
  const sentences = sentencesOf(source);
  const pts = spec.keyPoints.length ? spec.keyPoints : sentences.slice(0, 3);
  const title = clip(spec.title, BUDGETS.statement.title.max);
  const notes = [
    `Say: ${spec.purpose || spec.title}.`,
    sentences[0] ? `Explain: ${sentences[0]}` : "",
    `Ask: "What do you already know about ${clip(spec.title, 6).toLowerCase()}?"`,
    sentences[1] ? `Expected answer / common misconception: ${sentences[1]}` : "",
    `Suggested time: ${spec.minutes} min.`,
  ]
    .filter(Boolean)
    .join("\n");

  let content: SlideContent;
  switch (spec.layout) {
    case "title":
      content = {
        layout: "title",
        title: clip(spec.title, BUDGETS.title.title.max),
        subtitle: clip(input.lessonTitle === spec.title ? "" : input.lessonTitle, BUDGETS.title.subtitle.max),
        objectives: outline.objectives.slice(0, 3).map((o) => clip(o, BUDGETS.title.objectives.item.max)),
      };
      break;
    case "statement": {
      const bullets = pad(pts.slice(0, 3).map((p) => clip(p, 8)), 1, () => clip(spec.title, 8));
      content = { layout: "statement", title, bullets, visual: visualFor(spec, source, bullets, outline), terms: termsFor(`${spec.title} ${bullets.join(" ")}`, outline, 2) };
      break;
    }
    case "chart":
      content = {
        layout: "chart",
        title,
        chart: spec.visual === "table" ? (stubTable(source, outline, false) ?? placeholderFor(spec)) : spec.visual === "none" ? placeholderFor(spec) : waveFn(true),
        takeaways: pad(pts.slice(0, 2).map((p) => clip(p, 8)), 1, () => "Read the trend from the graph"),
        source: spec.sourcePages.length ? `Textbook p.${spec.sourcePages[0]}` : "",
      };
      break;
    case "steps": {
      const f = findFormula(source);
      const faded = spec.pageType === "faded";
      const [x, y] = faded ? [4, 0.5] : [5, 0.4];
      if (f) {
        const ans = Math.round(x * y * 100) / 100;
        content = {
          layout: "steps",
          title,
          problem: `Find $${tex(f.lhs)}$ when $${tex(f.a)} = ${x}$ and $${tex(f.b)} = ${y}$.`,
          steps: [
            { text: `Write the equation: $${f.tex}$`, why: "Choose the relationship" },
            { text: `Substitute: $${tex(f.lhs)} = ${x} \\times ${y}$`, why: "Use the given values" },
            { text: `Calculate: $${tex(f.lhs)} = ${ans}$`, why: "Multiply" },
            { text: "State the answer with units", why: "Units complete it" },
          ],
          ...(faded ? { fadeFrom: 2 } : {}),
        };
      } else {
        content = {
          layout: "steps",
          title,
          problem: clip(sentences[0] ?? spec.title, BUDGETS.steps.problem.max),
          steps: pad(pts.slice(0, 4).map((p, i) => ({ text: clip(p, 7), why: `Step ${i + 1}` })), 2, (i) => ({ text: `Check step ${i + 1}`, why: "" })),
          ...(faded ? { fadeFrom: 1 } : {}),
        };
      }
      break;
    }
    case "experiment": {
      const embed = findEmbed(`${spec.title} ${source}`);
      const sim: ExperimentSim = embed ? { kind: "sim", embedId: embed.id } : waveFn(true);
      const p = PREDICT[embed?.id ?? "wave-string"]!;
      content = {
        layout: "experiment",
        title,
        predict: { question: p.question, options: p.options },
        sim,
        observe: p.observe,
        explain: clip(sentences.find((s) => /halve|increase|decrease|double|longer|shorter/i.test(s)) ?? sentences[0] ?? spec.title, 12),
      };
      break;
    }
    case "quiz": {
      const correct = clip(sentences[0] ?? spec.title, 7);
      const others = sentences.slice(3).map((s) => clip(s, 7));
      const distractors = pad(others.filter((s) => s !== correct).slice(0, 2), 2, (i) => (i === 0 ? "It depends only on amplitude" : "None of these can be measured"));
      content = {
        layout: "quiz",
        question: `Which statement about ${clip(spec.title.replace(/^check:\s*/i, ""), 8).toLowerCase()} is correct?`,
        options: [
          { text: distractors[0]!, misconception: "Confuses this idea with another one" },
          { text: correct, misconception: "" },
          { text: distractors[1]!, misconception: "Recalls a detail from a different topic" },
        ],
        answer: 1,
        explain: clip(sentences[0] ?? spec.title, BUDGETS.quiz.explain.max),
      };
      break;
    }
    case "questions": {
      const base = sentences.length ? sentences : pts;
      const items = pad(
        base.slice(0, 3).map((s) => {
          const m = /^(.{3,60}?)\s+(?:is|are|depends on|means)\s+(.+)$/i.exec(s.replace(/[.!?]$/, ""));
          return m ? { q: `What ${/ are /i.test(s) ? "are" : "is"} ${clip(m[1]!.replace(/^(the|a|an)\s+/i, "the "), 7).toLowerCase()}?`, a: clip(m[2]!, 5) } : { q: `Explain: ${clip(s, 7)}`, a: clip(s, 5) };
        }),
        2,
        (i) => ({ q: `Recall key idea ${i + 1}`, a: clip(pts[i] ?? spec.title, 5) }),
      );
      content = { layout: "questions", title: clip(spec.title, BUDGETS.questions.title.max), items };
      break;
    }
    case "order": {
      const steps = pad(pts.slice(0, 5).map((p) => clip(p, BUDGETS.order.items.item.max)), 3, (i) => clip(sentences[i] ?? `Stage ${i + 1}`, BUDGETS.order.items.item.max));
      content = { layout: "order", title, mode: "order", items: steps.map((text) => ({ text, match: "" })) };
      break;
    }
    case "summary": {
      const heads = pad(pts.slice(0, 4).map((p) => clip(p, 4)), 3, (i) => clip(outline.objectives[i] ?? `Idea ${i + 1}`, 4));
      content = { layout: "summary", title, nodes: heads.map((h, i) => ({ head: h, detail: clip(sentences[i] ?? "", 6) })) };
      break;
    }
  }
  return { content, notes };
}
