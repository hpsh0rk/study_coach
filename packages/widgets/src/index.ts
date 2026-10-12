import type { ChartSpec, FunctionSpec, WidgetSpec } from "@kj/schema";
import { compileExpr, ExprError, sampleFunction } from "./expr.ts";

export { compileExpr, ExprError, sampleFunction };

export interface EmbedEntry {
  id: string;
  title: { en: string; zh: string };
  topics: string[];
  /** Same-origin static path; swapping the source (PhET, AI-generated sims) only changes this table. */
  src: string;
  attribution: string;
}

export const EMBED_CATALOG: EmbedEntry[] = [
  {
    id: "wave-string",
    title: { en: "Wave on a string", zh: "弦上的波" },
    topics: ["wave", "waves", "frequency", "amplitude", "wavelength", "wave speed", "transverse"],
    src: "/sims/wave-string.html",
    attribution: "study_coach built-in simulation",
  },
  {
    id: "pendulum",
    title: { en: "Simple pendulum", zh: "单摆" },
    topics: ["pendulum", "oscillation", "period", "gravity", "time period"],
    src: "/sims/pendulum.html",
    attribution: "study_coach built-in simulation",
  },
];

export function resolveEmbed(id: string): EmbedEntry | undefined {
  return EMBED_CATALOG.find((e) => e.id === id);
}

/** Best catalog match for free text: the entry with the most whole-word topic hits (at least `minHits`). */
export function findEmbed(text: string, minHits = 1): EmbedEntry | undefined {
  const t = text.toLowerCase();
  let best: { entry: EmbedEntry; score: number } | undefined;
  for (const entry of EMBED_CATALOG) {
    const score = entry.topics.filter((k) => new RegExp(`\\b${k}\\b`).test(t)).length;
    if (score >= minHits && (!best || score > best.score)) best = { entry, score };
  }
  return best?.entry;
}

export interface WidgetIssue {
  level: "error" | "warning";
  code: string;
  message: string;
}

function validateFunction(spec: FunctionSpec, issues: WidgetIssue[]): void {
  try {
    compileExpr(spec.expr, ["x", ...spec.params.map((p) => p.name)]);
  } catch (e) {
    issues.push({ level: "error", code: "expr", message: `invalid expression: ${(e as Error).message}` });
  }
  if (!(spec.x[1] > spec.x[0])) issues.push({ level: "error", code: "range", message: "x range must be increasing" });
  if (spec.y && !(spec.y[1] > spec.y[0])) issues.push({ level: "error", code: "range", message: "y range must be increasing" });
  for (const p of spec.params) {
    if (!(p.max > p.min)) issues.push({ level: "error", code: "param", message: `param ${p.name}: max must exceed min` });
    else if (p.value < p.min || p.value > p.max) issues.push({ level: "error", code: "param", message: `param ${p.name}: value out of range` });
  }
}

function validateChart(spec: ChartSpec, issues: WidgetIssue[]): void {
  const cats = spec.categories?.length ?? 0;
  for (const s of spec.series) {
    const pairs = s.data.every((d) => Array.isArray(d));
    const plain = s.data.every((d) => typeof d === "number");
    if (!pairs && !plain) issues.push({ level: "error", code: "data", message: `series ${s.name}: mix of values and [x,y] pairs` });
    if (plain && spec.type !== "scatter" && cats && s.data.length !== cats) issues.push({ level: "error", code: "data", message: `series ${s.name}: ${s.data.length} values for ${cats} categories` });
    if (plain && !cats) issues.push({ level: "error", code: "data", message: `series ${s.name}: plain values need categories` });
  }
  if (cats > 7) issues.push({ level: "warning", code: "categories", message: "more than 7 categories (V-04)" });
  if (spec.focus !== undefined && spec.focus >= spec.series.length) issues.push({ level: "error", code: "focus", message: "focus index out of range" });
}

export function validateWidget(spec: WidgetSpec): WidgetIssue[] {
  const issues: WidgetIssue[] = [];
  switch (spec.kind) {
    case "function":
      validateFunction(spec, issues);
      break;
    case "chart":
      validateChart(spec, issues);
      break;
    case "sim":
      if (!resolveEmbed(spec.embedId)) issues.push({ level: "error", code: "embed", message: `unknown embed "${spec.embedId}"` });
      break;
    case "formula":
      if (/\\(input|include|href|url)\b/.test(spec.tex)) issues.push({ level: "error", code: "tex", message: "forbidden TeX command" });
      break;
    case "flow":
      break;
  }
  return issues;
}

export interface Palette {
  accent: string;
  series: string[];
  muted: string;
  text: string;
  grid: string;
  fontFamily: string;
}

const LABEL_PX = 40;

function axisCommon(p: Palette, name: string) {
  return {
    name,
    nameLocation: "middle" as const,
    nameGap: 70,
    nameTextStyle: { fontSize: LABEL_PX * 0.9, color: p.text, fontFamily: p.fontFamily },
    axisLabel: { fontSize: LABEL_PX * 0.8, color: p.text, fontFamily: p.fontFamily },
    axisLine: { lineStyle: { color: p.text } },
    splitLine: { lineStyle: { color: p.grid } },
  };
}

/** ECharts option for a ChartSpec (pure data; rendering lives in ./render). */
export function chartOption(spec: ChartSpec, p: Palette): Record<string, unknown> {
  const numericX = spec.type === "scatter" || spec.series.every((s) => s.data.every((d) => Array.isArray(d)));
  const color = (i: number) => (spec.focus === undefined || spec.focus === i ? (p.series[i % p.series.length] ?? p.accent) : p.muted);
  return {
    animation: false,
    textStyle: { fontFamily: p.fontFamily },
    grid: { left: 150, right: 60, top: spec.series.length > 1 ? 90 : 40, bottom: 120, containLabel: false },
    legend: spec.series.length > 1 ? { top: 0, textStyle: { fontSize: LABEL_PX * 0.8, color: p.text }, itemWidth: 40, itemHeight: 24 } : undefined,
    xAxis: numericX ? { type: "value", ...axisCommon(p, spec.xLabel) } : { type: "category", data: spec.categories ?? [], ...axisCommon(p, spec.xLabel) },
    yAxis: { type: "value", ...axisCommon(p, spec.yLabel), nameGap: 100 },
    series: spec.series.map((s, i) => ({
      name: s.name,
      type: spec.type,
      data: s.data,
      symbolSize: spec.type === "scatter" ? 22 : 12,
      lineStyle: { width: 6 },
      itemStyle: { color: color(i) },
      label: spec.type === "bar" ? { show: true, position: "top", fontSize: LABEL_PX * 0.8, color: p.text } : undefined,
    })),
  };
}

export function functionOption(spec: FunctionSpec, values: Record<string, number>, p: Palette): Record<string, unknown> {
  const data = sampleFunction(spec.expr, spec.x, values);
  return {
    animation: false,
    textStyle: { fontFamily: p.fontFamily },
    grid: { left: 150, right: 60, top: 40, bottom: 120 },
    xAxis: { type: "value", min: spec.x[0], max: spec.x[1], ...axisCommon(p, spec.xLabel) },
    yAxis: { type: "value", ...(spec.y ? { min: spec.y[0], max: spec.y[1] } : {}), ...axisCommon(p, spec.yLabel), nameGap: 100 },
    series: [{ type: "line", data, showSymbol: false, smooth: false, lineStyle: { width: 7, color: p.accent }, connectNulls: false }],
  };
}

export function initialValues(spec: FunctionSpec): Record<string, number> {
  return Object.fromEntries(spec.params.map((p) => [p.name, p.value]));
}
