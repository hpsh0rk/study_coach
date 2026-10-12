import type { FunctionSpec, LayoutId, SlideContent } from "@kj/schema";
import { BUDGETS } from "./budgets.ts";

export type SampleLang = "en" | "zh";

/** About 6 letters per word: longer than typical textbook prose (≈ 5), so max budgets stay a worst case. */
const EN_WORDS = ["Sound", "waves", "transfer", "energy", "through", "a", "medium", "without", "moving", "matter", "the", "wavelength", "frequency", "and", "amplitude", "change"];
const ZH_TEXT = "电磁波可以在真空中传播能量而不需要介质粒子振动方向与传播方向垂直波长频率和振幅决定了波的性质";

/** Worst-case filler: exactly `n` English words, or the CJK equivalent (1.7 chars per word). */
export function filler(n: number, lang: SampleLang, seed = 0): string {
  if (lang === "zh") {
    const chars = Math.floor(n * 1.7);
    let out = "";
    for (let i = 0; out.length < chars; i++) out += ZH_TEXT[(seed * 7 + i) % ZH_TEXT.length];
    return out;
  }
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(EN_WORDS[(seed * 5 + i) % EN_WORDS.length]!);
  return out.join(" ");
}

const sliders: FunctionSpec = {
  kind: "function",
  expr: "A*sin(2*pi*(x/L - f/4))",
  x: [0, 4],
  y: [-3, 3],
  xLabel: "distance / m",
  yLabel: "displacement / cm",
  params: [
    { name: "A", label: "Amplitude A / cm", min: 0, max: 3, step: 0.1, value: 2 },
    { name: "L", label: "Wavelength λ / m", min: 0.5, max: 4, step: 0.1, value: 2 },
    { name: "f", label: "Frequency f / Hz", min: 0, max: 5, step: 0.5, value: 1 },
  ],
};

/** Content that fills every slot of a layout to its hard budget (used by the overflow test and gallery). */
export function maxBudgetContent(layout: LayoutId, lang: SampleLang): SlideContent {
  const f = (n: number, seed = 0) => filler(n, lang, seed);
  const times = <T>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i));
  switch (layout) {
    case "title": {
      const b = BUDGETS.title;
      return { layout, title: f(b.title.max), subtitle: f(b.subtitle.max, 1), objectives: times(b.objectives.max, (i) => f(b.objectives.item.max, i + 2)) };
    }
    case "statement": {
      const b = BUDGETS.statement;
      const per = Math.min(b.bullets.item.max, Math.floor(b.bodyTotal.max / b.bullets.max));
      return {
        layout,
        title: f(b.title.max),
        bullets: times(b.bullets.max, (i) => f(per, i + 1)),
        visual: { ...sliders, expr: "A*sin(2*pi*x/L)", params: sliders.params.slice(0, 2) },
        terms: times(b.terms.max, (i) => ({ term: f(b.terms.item.max, i + 3), zh: "电磁辐射" })),
      };
    }
    case "chart": {
      const b = BUDGETS.chart;
      const categories = ["Radio", "Micro", "Infrared", "Visible", "UV", "X-ray", "Gamma"];
      return {
        layout,
        title: f(b.title.max),
        chart: {
          kind: "chart",
          type: "bar",
          xLabel: "Region of the spectrum",
          yLabel: "log10(frequency / Hz)",
          categories,
          series: times(4, (s) => ({ name: `Series ${s + 1}`, data: categories.map((_, i) => Math.round((8 + i * 1.6 + s * 0.3) * 10) / 10) })),
          focus: 0,
        },
        takeaways: times(b.takeaways.max, (i) => f(b.takeaways.item.max, i + 1)),
        source: f(b.source.max, 5),
      };
    }
    case "steps": {
      const b = BUDGETS.steps;
      return {
        layout,
        title: f(b.title.max),
        problem: f(b.problem.max, 1),
        steps: times(b.steps.max, (i) => ({ text: f(b.steps.item.max, i + 2), why: f(b.why.max, i + 3) })),
      };
    }
    case "experiment": {
      const b = BUDGETS.experiment;
      return {
        layout,
        title: f(b.title.max),
        predict: { question: f(b.question.max, 1), options: times(b.options.max, (i) => f(b.options.item.max, i + 2)) },
        sim: sliders,
        observe: times(b.observe.max, (i) => f(b.observe.item.max, i + 3)),
        explain: f(b.explain.max, 4),
      };
    }
    case "quiz": {
      const b = BUDGETS.quiz;
      return {
        layout,
        question: f(b.question.max),
        options: times(b.options.max, (i) => ({ text: f(b.options.item.max, i + 1), misconception: f(b.misconception.max, i + 2) })),
        answer: 1,
        explain: f(b.explain.max, 3),
      };
    }
    case "questions": {
      const b = BUDGETS.questions;
      return { layout, title: f(b.title.max), items: times(b.items.max, (i) => ({ q: f(b.items.item.max, i + 1), a: f(b.answer.max, i + 2) })) };
    }
    case "summary": {
      const b = BUDGETS.summary;
      return { layout, title: f(b.title.max), nodes: times(b.nodes.max, (i) => ({ head: f(b.nodes.item.max, i + 1), detail: f(b.detail.max, i + 2) })) };
    }
  }
}

/** Light content for previews of each layout. */
export function sampleContent(layout: LayoutId): SlideContent {
  switch (layout) {
    case "title":
      return { layout, title: "Waves transfer energy", subtitle: "IGCSE Physics · Lesson 1", objectives: ["Describe a wave using amplitude, wavelength and frequency", "Use $v = f\\lambda$ to calculate wave speed"] };
    case "statement":
      return {
        layout,
        title: "Wave speed equals frequency times wavelength",
        bullets: ["Frequency: waves passing per second", "Wavelength: crest-to-crest distance", "Double $f$ at fixed $v$: $\\lambda$ halves"],
        visual: { kind: "formula", tex: "v = f\\lambda", caption: "v in m/s, f in Hz, λ in m" },
        terms: [{ term: "wavelength", zh: "波长" }],
      };
    default:
      return maxBudgetContent(layout, "en");
  }
}
