import { tokenizeRichText, type ChartSpec, type ExperimentSim, type FormulaSpec, type FunctionSpec, type PageType, type Slide, type SlideContent, type TableSpec, type TeachingLanguage, type ThemeId, type Unverified, type VisualSpec } from "@kj/schema";
import { CANVAS, FONT } from "@kj/templates";
import { resolveEmbed, sampleFunction } from "@kj/widgets";
import { lineCount, plain, texToText } from "./text.ts";

export type PptxFontScale = "standard" | "large";

const LARGE_FONT_FOCUS_RE =
  /\b(?:29|3[0-6])\s*(?:pt|px)\b|(?:29|3[0-6])\s*(?:号字?|pt|磅)|字体要?大|大字号?|字号要?大|大号字体|字大一些|字要大|\blarge(?:\s+classroom)?\s+(?:font|text|type)\b|\bbig\s+(?:font|text)\b/i;

/** Resolves explicit `fontScale` or auto-selects `"large"` (~30pt body) when lesson `focus` asks for ~30pt / large classroom font. */
export function resolveFontScale(opts?: { fontScale?: PptxFontScale; focus?: string }): PptxFontScale {
  if (opts?.fontScale === "large" || opts?.fontScale === "standard") return opts.fontScale;
  if (opts?.focus && LARGE_FONT_FOCUS_RE.test(opts.focus)) return "large";
  return "standard";
}

/**
 * A deck slide as positioned, editable PPTX objects. Geometry is in the templates' logical pixels
 * (1920×1080, 16:9) and font sizes in the same pixels, so the HTML type scale carries over: 56px = 28pt.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Run {
  text: string;
  bold?: boolean;
  color?: string;
  /** Font size relative to the box's size. */
  scale?: number;
}

export interface Para {
  runs: Run[];
  bullet?: boolean;
  /** Space above the paragraph, px. */
  gap?: number;
}

export interface TextItem {
  kind: "text";
  slot: string;
  rect: Rect;
  paras: Para[];
  fontPx: number;
  minFontPx: number;
  /** Safety auto-fit floor when a `"large"` classroom slide is packed to maximum density. */
  denseMinFontPx?: number;
  color: string;
  bold?: boolean;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  fill?: string;
  line?: string;
  dashed?: boolean;
  /** Inner padding, px. */
  inset?: number;
  shape?: "rect" | "roundRect" | "ellipse";
  /** Line pitch as a multiple of the font size (exact spacing, so every renderer agrees). */
  lineFactor?: number;
}

export interface ShapeItem {
  kind: "shape";
  shape: "rect" | "roundRect" | "downArrow" | "rightArrow";
  rect: Rect;
  fill?: string;
  line?: string;
  dashed?: boolean;
}

export interface TableItem {
  kind: "table";
  slot: string;
  rect: Rect;
  header: string[];
  rows: string[][];
  fontPx: number;
  rowPx: number;
}

export interface ChartSeries {
  name: string;
  labels: string[];
  values: number[];
  color: string;
}

/** Native PPTX chart. Scatter series share `x` (the first entry of the PPTX scatter data). */
export interface ChartItem {
  kind: "chart";
  slot: string;
  rect: Rect;
  type: "bar" | "line" | "scatter";
  series: ChartSeries[];
  x?: number[];
  xLabel: string;
  yLabel: string;
  yRange?: [number, number];
  xRange?: [number, number];
  /** Scatter drawn as a curve (function plots). */
  smoothLine?: boolean;
  dataLabels: boolean;
}

/** Data a native PPTX object cannot express faithfully; the exporter asks the app for a picture, else keeps `fallback`. */
export interface ImageItem {
  kind: "image";
  slot: string;
  rect: Rect;
  spec: ChartSpec | FunctionSpec | FormulaSpec;
  fallback: TextItem;
}

export type Item = TextItem | ShapeItem | TableItem | ChartItem | ImageItem;

export interface SlidePlan {
  items: Item[];
  notes: string;
  /** What did not survive as-is (also explained in the notes); codes for tests and the export summary. */
  degraded: string[];
}

export interface Palette {
  bg: string;
  text: string;
  soft: string;
  accent: string;
  accentInk: string;
  panel: string;
  panelLine: string;
  good: string;
  emphasis: string;
  muted: string;
  series: string[];
}

/** The two slide themes from templates/render/slides.css. */
export const PALETTES: Record<ThemeId, Palette> = {
  classic: { bg: "FBFCFE", text: "17202E", soft: "4B5668", accent: "1F5FBF", accentInk: "FFFFFF", panel: "EEF3FB", panelLine: "C9D7EF", good: "1E7D46", emphasis: "C81E1E", muted: "B9C2D0", series: ["1F5FBF", "D9822B", "1E7D46", "8E44AD"] },
  chalk: { bg: "1F3A32", text: "F3F1E7", soft: "C9D3C8", accent: "FFD166", accentInk: "1F3A32", panel: "28473D", panelLine: "3F6457", good: "8EE09F", emphasis: "FF7B72", muted: "5D7A70", series: ["FFD166", "8ECAE6", "8EE09F", "F4A3C0"] },
};

export interface PlanContext {
  theme: ThemeId;
  pageLabels?: Record<number, string>;
  language?: TeachingLanguage;
  fontScale?: PptxFontScale;
  focus?: string;
}

const byLang = (lang: TeachingLanguage | undefined, zh: string, en: string, bi: string) =>
  lang === "zh" ? zh : lang === "en" ? en : bi;

const M = 96;
const W = CANVAS.width - 2 * M;
const TITLE: Rect = { x: M, y: 54, w: W, h: 180 };
const BODY_Y = 254;
const BODY_H = 720;
const GAP = 64;
export const LINE = 1.22;
/** Extra height LibreOffice's layout needs beyond lines × pitch (measured with the render check). */
const BOX_SLACK = 10;
const LETTERS = "ABCDEFGH";

/** Box height a text item needs at `fontPx` (estimate; the LibreOffice render test checks the real thing). */
export function textHeight(item: Pick<TextItem, "paras" | "rect" | "inset" | "lineFactor">, fontPx: number): number {
  const inset = item.inset ?? 0;
  const width = item.rect.w - 2 * inset;
  const line = item.lineFactor ?? LINE;
  let h = 2 * inset + BOX_SLACK;
  item.paras.forEach((p, i) => {
    const scale = p.runs[0]?.scale ?? 1;
    const size = fontPx * scale;
    const indent = p.bullet ? size * 0.9 : 0;
    const text = p.runs.map((r) => r.text).join("");
    h += lineCount(text, (width - indent) / size) * size * line + (i > 0 ? (p.gap ?? 0) : 0);
  });
  return h;
}

/** Largest size in [minFontPx, fontPx] (2px steps, like templates fitSlide) at which the text fits its box. */
export function fitFont(item: TextItem): { fontPx: number; fits: boolean } {
  for (let size = item.fontPx; size >= item.minFontPx; size -= 2) if (textHeight(item, size) <= item.rect.h) return { fontPx: size, fits: true };
  if (item.denseMinFontPx !== undefined && item.denseMinFontPx < item.minFontPx) {
    for (let size = item.minFontPx - 2; size >= item.denseMinFontPx; size -= 2) {
      if (textHeight(item, size) <= item.rect.h) return { fontPx: size, fits: true };
    }
    return { fontPx: item.denseMinFontPx, fits: false };
  }
  return { fontPx: item.minFontPx, fits: false };
}

interface TypeScale {
  large: boolean;
  body: number;
  bodyMin: number;
  card: number;
  cardMin: number;
  compact: number;
  compactMin: number;
  quizQuestion: number;
  quizQuestionMin: number;
  denseMin?: number;
}

function scaleFor(scale: PptxFontScale): TypeScale {
  if (scale === "large") {
    return {
      large: true,
      body: 60,
      bodyMin: 52,
      card: 60,
      cardMin: 54,
      compact: 56,
      compactMin: 52,
      quizQuestion: 64,
      quizQuestionMin: 52,
      denseMin: FONT.bodyMin,
    };
  }
  return {
    large: false,
    body: FONT.body,
    bodyMin: FONT.bodyMin,
    card: FONT.body,
    cardMin: FONT.bodyMin,
    compact: FONT.bodyMin,
    compactMin: FONT.bodyMin,
    quizQuestion: 60,
    quizQuestionMin: FONT.bodyMin,
  };
}

/** Splits `**bold**` and `==red-bold==` into native OOXML runs while converting `$...$` math via `texToText`. */
function richRuns(raw: string, p: Palette, base: Omit<Run, "text"> = {}): Run[] {
  const tokens = tokenizeRichText(raw);
  if (!tokens.length) return [{ ...base, text: "" }];
  const merged: Run[] = [];
  const push = (r: Run) => {
    if (!r.text) return;
    const prev = merged[merged.length - 1];
    if (prev && prev.bold === r.bold && prev.color === r.color && prev.scale === r.scale) {
      prev.text += r.text;
    } else {
      merged.push(r);
    }
  };
  for (const tok of tokens) {
    if (tok.kind === "text") {
      push({ ...base, text: tok.text });
    } else if (tok.kind === "math") {
      push({ ...base, text: texToText(tok.tex).text });
    } else {
      const innerText = tok.children.map((c) => (c.kind === "math" ? texToText(c.tex).text : c.text)).join("");
      if (tok.kind === "highlight") push({ ...base, text: innerText, bold: true, color: p.emphasis });
      else push({ ...base, text: innerText, bold: true });
    }
  }
  return merged.length ? merged : [{ ...base, text: "" }];
}

const plainPara = (s: string, extra: Omit<Para, "runs"> & Omit<Run, "text"> = {}): Para => {
  const { bullet, gap, ...run } = extra;
  return { runs: [{ ...run, text: plain(s) }], ...(bullet ? { bullet } : {}), ...(gap ? { gap } : {}) };
};

const richPara = (s: string, p: Palette, extra: Omit<Para, "runs"> & Omit<Run, "text"> = {}): Para => {
  const { bullet, gap, ...run } = extra;
  return { runs: richRuns(s, p, run), ...(bullet ? { bullet } : {}), ...(gap ? { gap } : {}) };
};

function text(slot: string, rect: Rect, paras: Para[], p: Palette, o: Partial<TextItem> = {}, ts?: TypeScale): TextItem {
  const baseFont = ts?.body ?? FONT.body;
  const baseMin = ts?.bodyMin ?? FONT.bodyMin;
  return {
    kind: "text",
    slot,
    rect,
    paras,
    fontPx: baseFont,
    minFontPx: baseMin,
    ...(ts?.denseMin !== undefined && (o.minFontPx ?? baseMin) > ts.denseMin ? { denseMinFontPx: ts.denseMin } : {}),
    color: p.text,
    valign: "top",
    ...o,
  };
}

function title(s: string, p: Palette): TextItem {
  return text("title", TITLE, [plainPara(s)], p, { fontPx: FONT.title, minFontPx: 60, bold: true, valign: "middle" });
}

function sourcesLine(slide: Slide, ctx: PlanContext, p: Palette): TextItem | null {
  if (!slide.sources.length) return null;
  const labels = slide.sources.map((n) => ctx.pageLabels?.[n] ?? String(n));
  return text("sources", { x: M, y: 1000, w: 1200, h: 50 }, [plainPara(`教材 p. ${labels.join(", ")}`)], p, { fontPx: FONT.source, minFontPx: FONT.source, color: p.soft, valign: "middle" });
}

function badge(letter: string, rect: Rect, p: Palette, fill = p.accent, color = p.accentInk): TextItem {
  return text("badge", rect, [plainPara(letter)], p, { fontPx: FONT.label, minFontPx: FONT.label, bold: true, align: "center", valign: "middle", fill, color, shape: "ellipse" });
}

function tableItem(spec: TableSpec, rect: Rect, slot: string, ts: TypeScale): TableItem {
  const header = spec.columns.map(plain);
  const rows = spec.rows.map((r) => r.map(plain));
  const maxRow = ts.large ? 124 : 110;
  const rowPx = Math.min(maxRow, Math.floor((rect.h - (spec.caption ? 56 : 0)) / (rows.length + 1)));
  let fontPx: number = FONT.bodyMin;
  if (ts.large) {
    const colWidthPx = Math.max(80, rect.w / Math.max(1, header.length) - 24);
    const allRows = [header, ...rows];
    for (const candidate of [56, 54, 52]) {
      const fitsAll = allRows.every((r) => {
        const lines = Math.max(1, ...r.map((cell) => lineCount(cell, colWidthPx / candidate)));
        return lines * candidate * LINE + 22 <= rowPx;
      });
      if (fitsAll) {
        fontPx = candidate;
        break;
      }
    }
  }
  return { kind: "table", slot, rect: { ...rect, h: rowPx * (rows.length + 1) }, header, rows, fontPx, rowPx };
}

function chartFallback(spec: ChartSpec | FunctionSpec, rect: Rect, p: Palette, slot: string, lang?: TeachingLanguage): TextItem {
  const lines =
    spec.kind === "function"
      ? [plain(`y = ${spec.expr}`), `x: ${spec.x[0]} … ${spec.x[1]}`]
      : spec.series.map((s) => `${plain(s.name)}: ${s.data.map((d) => (Array.isArray(d) ? `(${d[0]}, ${d[1]})` : String(d))).join(", ")}`);
  const head =
    spec.kind === "function"
      ? byLang(lang, "函数图像", "Graph", "函数图像 Graph")
      : byLang(lang, "图表数据", "Chart data", "图表数据 Chart data");
  return text(slot, rect, [plainPara(head, { bold: true }), ...lines.map((l) => plainPara(l, { gap: 12 }))], p, {
    fontPx: FONT.label,
    minFontPx: 28,
    fill: p.panel,
    line: p.panelLine,
    inset: 24,
    color: p.text,
  });
}

/** Function plot as a native scatter-with-lines chart at the sliders' starting values; image when the curve breaks. */
function functionChart(spec: FunctionSpec, rect: Rect, p: Palette, slot: string, lang?: TeachingLanguage): ChartItem | ImageItem {
  const values = Object.fromEntries(spec.params.map((q) => [q.name, q.value]));
  let pts: [number, number | null][] = [];
  try {
    pts = sampleFunction(spec.expr, spec.x, values, 120);
  } catch {
    pts = [];
  }
  const inside = pts.filter(([, y]) => y !== null && Number.isFinite(y) && (!spec.y || (y >= spec.y[0] && y <= spec.y[1])));
  const firstGood = pts.findIndex(([, y]) => y !== null);
  const broken = inside.length < 2 || pts.slice(firstGood).some(([, y], i, a) => (y === null || (spec.y && (y < spec.y[0] || y > spec.y[1]))) && a.slice(i).some(([, z]) => z !== null));
  if (broken) return { kind: "image", slot, rect, spec, fallback: chartFallback(spec, rect, p, slot, lang) };
  return {
    kind: "chart",
    slot,
    rect,
    type: "scatter",
    x: inside.map(([x]) => round(x)),
    series: [{ name: plain(`y = ${spec.expr}`), labels: [], values: inside.map(([, y]) => round(y!)), color: p.accent }],
    xLabel: plain(spec.xLabel),
    yLabel: plain(spec.yLabel),
    xRange: spec.x,
    ...(spec.y ? { yRange: spec.y } : {}),
    smoothLine: true,
    dataLabels: false,
  };
}

const round = (n: number) => Number(n.toPrecision(5));

function dataChart(spec: ChartSpec, rect: Rect, p: Palette, slot: string, lang?: TeachingLanguage): ChartItem | ImageItem {
  const focus = spec.focus !== undefined && spec.focus >= 0 && spec.focus < spec.series.length ? spec.focus : undefined;
  const color = (i: number) => (focus === undefined || focus === i ? (p.series[i % p.series.length] ?? p.accent) : p.muted);
  const pairs = spec.series.every((s) => s.data.every((d) => Array.isArray(d)));
  const flat = spec.series.every((s) => s.data.every((d) => !Array.isArray(d)));
  const base = { kind: "chart" as const, slot, rect, xLabel: plain(spec.xLabel), yLabel: plain(spec.yLabel), dataLabels: spec.type === "bar" && spec.series.length === 1 };
  if (flat && spec.type !== "scatter") {
    const labels = (spec.categories ?? spec.series[0]!.data.map((_, i) => String(i + 1))).map(plain);
    return { ...base, type: spec.type, series: spec.series.map((s, i) => ({ name: plain(s.name), labels, values: s.data as number[], color: color(i) })) };
  }
  if (pairs) {
    const xs = (spec.series[0]!.data as [number, number][]).map(([x]) => x);
    const shared = spec.series.every((s) => s.data.length === xs.length && (s.data as [number, number][]).every(([x], i) => x === xs[i]));
    if (shared)
      return {
        ...base,
        type: "scatter",
        x: xs,
        series: spec.series.map((s, i) => ({ name: plain(s.name), labels: [], values: (s.data as [number, number][]).map(([, y]) => y), color: color(i) })),
        smoothLine: spec.type === "line",
      };
  }
  return { kind: "image", slot, rect, spec, fallback: chartFallback(spec, rect, p, slot, lang) };
}

interface Notes {
  answers: string[];
  interaction: string[];
  other: string[];
  degraded: string[];
}

function visualItems(v: VisualSpec | ExperimentSim | ChartContentChart, rect: Rect, p: Palette, notes: Notes, slot: string, ts: TypeScale, lang?: TeachingLanguage): Item[] {
  switch (v.kind) {
    case "chart":
      return [dataChart(v, rect, p, slot, lang)];
    case "function": {
      const item = functionChart(v, rect, p, slot, lang);
      if (v.params.length) {
        notes.degraded.push("function-sliders");
        const paramList = v.params.map((q) => `${plain(q.label)} = ${q.value}`).join(lang === "en" ? ", " : "，");
        notes.interaction.push(
          byLang(
            lang,
            `图像带滑块（${paramList}）：PPT 里是这些初始值下的静态曲线；要拖动滑块请用 HTML 课件。`,
            `Slider plot (${paramList}): a static curve at the starting values here; drag the sliders in the HTML deck.`,
            `图像带滑块（${paramList}）：PPT 里是这些初始值下的静态曲线；要拖动滑块请用 HTML 课件。· Slider plot: a static curve at the starting values here; drag the sliders in the HTML deck.`,
          ),
        );
      }
      return [item];
    }
    case "table": {
      const t = tableItem(v, rect, slot, ts);
      return [t, ...(v.caption ? [text(`${slot}.caption`, { x: rect.x, y: t.rect.y + t.rect.h + 12, w: rect.w, h: 50 }, [richPara(v.caption, p)], p, { fontPx: FONT.source, minFontPx: FONT.source, color: p.soft })] : [])];
    }
    case "flow": {
      const n = v.steps.length;
      const arrow = 44;
      const box = Math.min(150, (rect.h - (n - 1) * arrow) / n);
      const items: Item[] = [];
      v.steps.forEach((s, i) => {
        const y = rect.y + i * (box + arrow);
        items.push(text(`${slot}.steps.${i}`, { x: rect.x, y, w: rect.w, h: box }, [richPara(s, p)], p, { fontPx: ts.compact, minFontPx: ts.compactMin, fill: p.panel, line: p.panelLine, inset: 6, align: "center", valign: "middle", shape: "roundRect", lineFactor: 1.12 }, ts));
        if (i < n - 1) items.push({ kind: "shape", shape: "downArrow", rect: { x: rect.x + rect.w / 2 - 22, y: y + box + 4, w: 44, h: arrow - 8 }, fill: p.accent });
      });
      return items;
    }
    case "formula": {
      const t = texToText(v.tex);
      notes.other.push(byLang(lang, `公式原文（LaTeX）：${v.tex}`, `Original formula (LaTeX): ${v.tex}`, `公式原文（LaTeX）：${v.tex}`));
      const boxRect = { x: rect.x, y: rect.y + rect.h / 2 - 160, w: rect.w, h: v.caption ? 220 : 320 };
      const formulaBox = text(slot, boxRect, [plainPara(t.text)], p, {
        fontPx: FONT.title,
        minFontPx: FONT.bodyMin,
        fill: p.panel,
        line: p.panelLine,
        inset: 24,
        align: "center",
        valign: "middle",
        shape: "roundRect",
      });
      const captionItems = v.caption
        ? [text(`${slot}.caption`, { x: rect.x, y: rect.y + rect.h / 2 + 80, w: rect.w, h: 100 }, [richPara(v.caption, p)], p, { fontPx: FONT.label, minFontPx: 32, color: p.soft, align: "center" })]
        : [];
      if (!t.exact) {
        notes.degraded.push("formula-approx");
        return [{ kind: "image", slot, rect: boxRect, spec: v, fallback: formulaBox }, ...captionItems];
      }
      return [formulaBox, ...captionItems];
    }
    case "placeholder":
      notes.degraded.push("placeholder");
      return [
        text(slot, rect, [plainPara(byLang(lang, "图示待补", "Visual needed", "图示待补 Visual needed"), { bold: true }), ...(v.hint ? [richPara(v.hint, p, { gap: 16, scale: 0.85, color: p.soft })] : [])], p, {
          fontPx: FONT.bodyMin,
          minFontPx: 32,
          line: p.panelLine,
          dashed: true,
          inset: 32,
          align: "center",
          valign: "middle",
          shape: "roundRect",
        }),
      ];
    case "sim": {
      const entry = resolveEmbed(v.embedId);
      const name = entry ? byLang(lang, entry.title.zh, entry.title.en, `${entry.title.zh} ${entry.title.en}`) : v.embedId;
      notes.degraded.push("sim");
      notes.interaction.push(
        byLang(
          lang,
          `模拟实验「${name}」只能在 HTML 课件或离线 HTML 文件里操作；PPT 里是说明框，可以切到 HTML 演示后再回来。`,
          `The simulation "${name}" runs only in the HTML deck or offline HTML file; switch to the HTML deck to run it.`,
          `模拟实验「${name}」只能在 HTML 课件或离线 HTML 文件里操作；PPT 里是说明框，可以切到 HTML 演示后再回来。· The simulation runs only in the HTML deck.`,
        ),
      );
      return [
        text(
          slot,
          rect,
          [
            plainPara(byLang(lang, "▶ 模拟实验", "▶ Simulation", "▶ 模拟实验 Simulation"), { bold: true, color: p.accent }),
            plainPara(name, { gap: 24 }),
            ...(v.caption ? [richPara(v.caption, p, { gap: 16, scale: 0.85, color: p.soft })] : []),
            plainPara(byLang(lang, "在 HTML 课件中操作", "Interactive in the HTML deck", "在 HTML 课件中操作 · interactive in the HTML deck"), { gap: 32, scale: 0.75, color: p.soft }),
          ],
          p,
          {
            fontPx: FONT.bodyMin,
            minFontPx: 32,
            fill: p.panel,
            line: p.panelLine,
            inset: 32,
            align: "center",
            valign: "middle",
            shape: "roundRect",
          },
        ),
      ];
    }
  }
}

type ChartContentChart = Extract<SlideContent, { layout: "chart" }>["chart"];

/** Deterministic card shuffle in which no card stays in place (same as templates/render shuffledOrder). */
export function shuffledOrder(keys: string[]): number[] {
  const n = keys.length;
  let seed = [...keys.join("|")].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  for (let attempt = 0; attempt < 20; attempt++) {
    const q = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [q[i], q[j]] = [q[j]!, q[i]!];
    }
    if (q.every((v, i) => v !== i)) return q;
  }
  return Array.from({ length: n }, (_, i) => (i + 1) % n);
}

function body(c: SlideContent, p: Palette, notes: Notes, ts: TypeScale, pageType?: PageType, lang?: TeachingLanguage): Item[] {
  switch (c.layout) {
    case "title": {
      const items: Item[] = [
        text("title", { x: M, y: 200, w: W, h: 300 }, [plainPara(c.title)], p, { fontPx: 96, minFontPx: FONT.title, bold: true, valign: "bottom" }),
      ];
      if (c.subtitle) items.push(text("subtitle", { x: M, y: 520, w: W, h: 150 }, [richPara(c.subtitle, p)], p, { color: p.soft }, ts));
      if (c.objectives.length)
        items.push(
          text("objectives", { x: M, y: 690, w: W, h: 300 }, c.objectives.map((o, i) => richPara(o, p, { bullet: true, gap: i ? 12 : 0 })), p, { fontPx: ts.compact, minFontPx: ts.large ? ts.compactMin : FONT.label, fill: p.panel, line: p.panelLine, inset: 28 }, ts),
        );
      return items;
    }
    case "statement": {
      const lw = Math.round(((W - GAP) * (c.visual.kind === "flow" ? 1 : 1.2)) / (c.visual.kind === "flow" ? 2 : 2.2));
      const rx = M + lw + GAP;
      const termsH = c.terms.length ? 128 : 0;
      const items: Item[] = [title(c.title, p), text("bullets", { x: M, y: BODY_Y, w: lw, h: BODY_H - termsH - (termsH ? 20 : 0) }, c.bullets.map((b, i) => richPara(b, p, { bullet: true, gap: i ? 28 : 0 })), p, {}, ts)];
      if (c.terms.length) {
        const tw = (lw - 24 * (c.terms.length - 1)) / c.terms.length;
        c.terms.forEach((t, i) =>
          items.push(
            text(`terms.${i}`, { x: M + i * (tw + 24), y: BODY_Y + BODY_H - termsH, w: tw, h: termsH }, [{ runs: [...richRuns(t.term, p, { bold: true }), ...(t.zh ? richRuns(` ${t.zh}`, p, { color: p.soft }) : [])] }], p, {
              fontPx: ts.large ? 44 : FONT.label,
              minFontPx: 26,
              fill: p.panel,
              line: p.panelLine,
              inset: 20,
              lineFactor: 1.12,
              valign: "middle",
              align: "center",
              shape: "roundRect",
            }),
          ),
        );
      }
      if (c.visual.kind === "flow" && c.bullets.length > 1) {
        notes.interaction.push(
          byLang(lang, "要点和流程图在 HTML 里逐条揭示；PPT 里一次全部显示。", "Bullets and flow steps appear all at once here.", "要点和流程图在 HTML 里逐条揭示；PPT 里一次全部显示。· Bullets and flow steps appear all at once here."),
        );
      }
      return [...items, ...visualItems(c.visual, { x: rx, y: BODY_Y, w: CANVAS.width - M - rx, h: BODY_H }, p, notes, "visual", ts, lang)];
    }
    case "chart": {
      const cw = Math.round(((W - GAP) * 1.35) / 2.35);
      const rx = M + cw + GAP;
      const srcH = c.source ? 60 : 0;
      const items: Item[] = [title(c.title, p), ...visualItems(c.chart, { x: M, y: BODY_Y, w: cw, h: BODY_H - srcH }, p, notes, "chart", ts, lang)];
      if (c.source) items.push(text("source", { x: M, y: BODY_Y + BODY_H - srcH + 10, w: cw, h: 50 }, [plainPara(c.source)], p, { fontPx: FONT.source, minFontPx: FONT.source, color: p.soft }));
      items.push(text("takeaways", { x: rx, y: BODY_Y, w: CANVAS.width - M - rx, h: BODY_H }, c.takeaways.map((t, i) => richPara(t, p, { bullet: true, gap: i ? 28 : 0 })), p, { fill: p.panel, line: p.panelLine, inset: 32 }, ts));
      notes.interaction.push(
        byLang(lang, "结论在 HTML 里逐条揭示；PPT 里一次全部显示。", "Takeaways appear all at once here.", "结论在 HTML 里逐条揭示；PPT 里一次全部显示。· Takeaways appear all at once here."),
      );
      return items;
    }
    case "steps": {
      const lw = Math.round((W - GAP) / 2.3);
      const rx = M + lw + GAP;
      const rw = CANVAS.width - M - rx;
      const items: Item[] = [title(c.title, p), text("problem", { x: M, y: BODY_Y, w: lw, h: BODY_H }, [richPara(c.problem, p)], p, { fill: p.panel, line: p.panelLine, inset: 32 }, ts)];
      const n = c.steps.length;
      const gap = 6;
      const h = (BODY_H - gap * (n - 1)) / n;
      const fade = c.fadeFrom ?? (pageType === "faded" && n > 1 ? n - 1 : n);
      c.steps.forEach((s, i) => {
        const y = BODY_Y + i * (h + gap);
        items.push(badge(String(i + 1), { x: rx, y: y + 8, w: 64, h: 64 }, p));
        const box = { x: rx + 84, y, w: rw - 84, h };
        if (i >= fade) items.push(text(`steps.${i}`, box, [plainPara("？")], p, { color: p.soft, line: p.panelLine, dashed: true, inset: 12, valign: "middle", align: "center" }, ts));
        else items.push(text(`steps.${i}`, box, [richPara(s.text, p), ...(s.why ? [richPara(s.why, p, { scale: 0.84, color: p.soft, gap: 4 })] : [])], p, { fontPx: ts.compact, minFontPx: ts.compactMin, inset: 4, lineFactor: 1.12 }, ts));
      });
      if (fade < n) {
        notes.degraded.push("faded-steps");
        const stepLines = c.steps.slice(fade).map((s, i) => `${fade + i + 1}. ${plain(s.text)}${s.why ? `（${plain(s.why)}）` : ""}`).join(lang === "en" ? "; " : "；");
        notes.answers.push(byLang(lang, `空着的步骤：${stepLines}`, `Blank steps: ${stepLines}`, `空着的步骤 Blank steps：${stepLines}`));
      }
      notes.interaction.push(
        byLang(lang, "步骤在 HTML 里逐步揭示；PPT 里一次全部显示（渐隐页的空框除外）。", "Steps appear all at once here (except blank boxes on faded slides).", "步骤在 HTML 里逐步揭示；PPT 里一次全部显示（渐隐页的空框除外）。· Steps appear all at once here."),
      );
      return items;
    }
    case "experiment": {
      const cw = (W - GAP) / 2;
      const rx = M + cw + GAP;
      const items: Item[] = [
        title(c.title, p),
        text("predict.question", { x: M, y: BODY_Y, w: cw, h: 200 }, [{ runs: [{ text: byLang(lang, "预测：", "Predict: ", "预测 Predict："), color: p.soft }, ...richRuns(c.predict.question, p)] }], p, {}, ts),
      ];
      const oh = 96;
      c.predict.options.forEach((o, i) => {
        const y = BODY_Y + 210 + i * (oh + 10);
        items.push(badge(LETTERS[i]!, { x: M, y: y + 14, w: 68, h: 68 }, p));
        items.push(text(`predict.options.${i}`, { x: M + 88, y, w: cw - 88, h: oh }, [richPara(o, p)], p, { fill: p.panel, line: p.panelLine, inset: 12, valign: "middle" }, ts));
      });
      const oy = BODY_Y + 210 + c.predict.options.length * (oh + 10) + 6;
      items.push(text("observe", { x: M, y: oy, w: cw, h: BODY_Y + BODY_H - oy }, [plainPara(byLang(lang, "观察", "Observe", "观察 Observe"), { bold: true, scale: 0.85, color: p.soft }), ...c.observe.map((o) => richPara(o, p, { bullet: true, gap: 8 }))], p, { fontPx: ts.compact, minFontPx: ts.compactMin, lineFactor: 1.15 }, ts));
      items.push(...visualItems(c.sim, { x: rx, y: BODY_Y, w: cw, h: 520 }, p, notes, "sim", ts, lang));
      items.push(
        text(
          "explain",
          { x: rx, y: BODY_Y + 540, w: cw, h: BODY_H - 540 },
          [plainPara(byLang(lang, "解释：讲完后揭示（见讲稿）", "Explain: reveal after demo (see notes)", "解释 Explain：讲完后揭示（见讲稿）"), { color: p.soft })],
          p,
          { fontPx: FONT.label, minFontPx: 32, line: p.panelLine, dashed: true, inset: 20, valign: "middle" },
        ),
      );
      notes.degraded.push("poe");
      notes.answers.push(byLang(lang, `解释：${plain(c.explain)}`, `Explain: ${plain(c.explain)}`, `解释 Explain：${plain(c.explain)}`));
      if (c.outcome !== undefined) {
        const outVal = `${LETTERS[c.outcome]}. ${plain(c.predict.options[c.outcome] ?? "")}`;
        notes.answers.push(byLang(lang, `实际结果：${outVal}`, `Outcome: ${outVal}`, `实际结果 Outcome：${outVal}`));
      }
      notes.interaction.push(
        byLang(
          lang,
          "预测-观察-解释（POE）：先让学生举手预测并记下每个选项的人数，再演示实验、观察，最后口头揭示解释。HTML 课件可录入预测人数并高亮实际结果。",
          "POE: take a show of hands, run the demo, then reveal the explanation.",
          "预测-观察-解释（POE）：先让学生举手预测并记下每个选项的人数，再演示实验、观察，最后口头揭示解释。HTML 课件可录入预测人数并高亮实际结果。· POE: take a show of hands, run the demo, then reveal the explanation.",
        ),
      );
      return items;
    }
    case "quiz": {
      const items: Item[] = [text("question", { x: M, y: 54, w: W, h: 290 }, [richPara(c.question, p)], p, { fontPx: ts.quizQuestion, minFontPx: ts.quizQuestionMin, bold: true, valign: "middle" }, ts)];
      const cw = (W - 48) / 2;
      const oh = 300;
      c.options.forEach((o, i) => {
        const x = M + (i % 2) * (cw + 48);
        const y = 370 + Math.floor(i / 2) * (oh + 32);
        items.push({ kind: "shape", shape: "roundRect", rect: { x, y, w: cw, h: oh }, fill: p.panel, line: p.panelLine });
        items.push(badge(LETTERS[i]!, { x: x + 24, y: y + oh / 2 - 38, w: 76, h: 76 }, p));
        items.push(text(`options.${i}`, { x: x + 120, y, w: cw - 140, h: oh }, [richPara(o.text, p)], p, { inset: 16, valign: "middle" }, ts));
      });
      const ansText = `${LETTERS[c.answer]}. ${plain(c.options[c.answer]?.text ?? "")}`;
      notes.answers.push(
        byLang(lang, `答案：${ansText}`, `Answer: ${ansText}`, `答案 Answer：${ansText}`),
        byLang(lang, `解释：${plain(c.explain)}`, `Explain: ${plain(c.explain)}`, `解释 Explain：${plain(c.explain)}`),
      );
      const mis = c.options.map((o, i) => (o.misconception ? `${LETTERS[i]}${lang === "en" ? ": " : "："}${plain(o.misconception)}` : "")).filter(Boolean);
      if (mis.length) {
        const joinedMis = mis.join(lang === "en" ? "; " : "；");
        notes.answers.push(byLang(lang, `误区：${joinedMis}`, `Misconceptions: ${joinedMis}`, `误区 Misconceptions：${joinedMis}`));
      }
      if (c.poll) {
        notes.degraded.push("poll");
        notes.interaction.push(
          byLang(
            lang,
            "先投票：让全班举手（或举 A/B/C/D 卡），数出每个选项的人数，可直接写在选项旁；讨论后再揭示答案。HTML 课件可录入人数并在投影上显示分布。",
            "Hinge poll: count hands per option, then reveal the answer.",
            "先投票：让全班举手（或举 A/B/C/D 卡），数出每个选项的人数，可直接写在选项旁；讨论后再揭示答案。HTML 课件可录入人数并在投影上显示分布。· Hinge poll: count hands per option, then reveal the answer.",
          ),
        );
      } else {
        notes.interaction.push(
          byLang(
            lang,
            "HTML 课件里点选项会即时反馈，“下一步”揭示答案；PPT 里答案只在讲稿中。",
            "The answer is only in these notes.",
            "HTML 课件里点选项会即时反馈，“下一步”揭示答案；PPT 里答案只在讲稿中。· The answer is only in these notes.",
          ),
        );
      }
      return items;
    }
    case "questions": {
      const items: Item[] = [title(c.title, p)];
      const n = c.items.length;
      const gap = 20;
      const h = (BODY_H - gap * (n - 1)) / n;
      c.items.forEach((q, i) => {
        const y = BODY_Y + i * (h + gap);
        items.push(badge(String(i + 1), { x: M, y: y + 8, w: 68, h: 68 }, p));
        items.push(text(`items.${i}.q`, { x: M + 92, y, w: W - 92, h }, [richPara(q.q, p)], p, { inset: 4 }, ts));
      });
      const ansList = c.items.map((q, i) => `${i + 1}. ${plain(q.a)}`).join(lang === "en" ? "; " : "；");
      notes.answers.push(byLang(lang, `答案：${ansList}`, `Answers: ${ansList}`, `答案 Answers：${ansList}`));
      notes.interaction.push(
        byLang(lang, "答案在 HTML 里逐题揭示；PPT 里答案只在讲稿中。", "Answers are only in these notes.", "答案在 HTML 里逐题揭示；PPT 里答案只在讲稿中。· Answers are only in these notes."),
      );
      return items;
    }
    case "order": {
      const items: Item[] = [title(c.title, p)];
      const n = c.items.length;
      const gap = 8;
      const h = (BODY_H + 16 - gap * (n - 1)) / n;
      const order = shuffledOrder(c.items.map((i) => i.text));
      notes.degraded.push("order");
      if (c.mode === "match") {
        const cw = (W - 96) / 2;
        const right = shuffledOrder(c.items.map((i) => i.match));
        c.items.forEach((it, i) => {
          const y = BODY_Y + i * (h + gap);
          items.push(text(`items.${i}`, { x: M, y, w: cw, h }, [richPara(it.text, p)], p, { fontPx: ts.card, minFontPx: ts.cardMin, fill: p.panel, line: p.panelLine, inset: 10, valign: "middle", shape: "roundRect", lineFactor: 1.12 }, ts));
          const m = c.items[right[i]!]!;
          items.push(text(`items.${right[i]}.match`, { x: M + cw + 96, y, w: cw, h }, [richPara(m.match, p)], p, { fontPx: ts.card, minFontPx: ts.cardMin, fill: p.panel, line: p.accent, inset: 10, valign: "middle", shape: "roundRect", lineFactor: 1.12 }, ts));
        });
        const pairs = c.items.map((it) => `${plain(it.text)} ↔ ${plain(it.match)}`).join(lang === "en" ? "; " : "；");
        notes.answers.push(byLang(lang, `配对：${pairs}`, `Matches: ${pairs}`, `配对 Matches：${pairs}`));
        notes.interaction.push(
          byLang(
            lang,
            "配对：右边的卡片已打乱。PPT 编辑模式下每张卡片都是可拖动的形状；放映时让学生口头配对，再按讲稿揭示。HTML 课件可拖动 / 点两张交换，“下一步”自动归位。",
            "Cards are separate shapes; drag them in edit mode or reveal verbally from these notes.",
            "配对：右边的卡片已打乱。PPT 编辑模式下每张卡片都是可拖动的形状；放映时让学生口头配对，再按讲稿揭示。HTML 课件可拖动 / 点两张交换，“下一步”自动归位。· Cards are separate shapes; drag them in edit mode.",
          ),
        );
      } else {
        order.forEach((src, i) => {
          const y = BODY_Y + i * (h + gap);
          items.push(text(`items.${src}`, { x: M + 160, y, w: W - 320, h }, [richPara(c.items[src]!.text, p)], p, { fontPx: ts.card, minFontPx: ts.cardMin, fill: p.panel, line: p.panelLine, inset: 10, valign: "middle", align: "center", shape: "roundRect", lineFactor: 1.12 }, ts));
        });
        const seq = c.items.map((it, i) => `${i + 1}. ${plain(it.text)}`).join(" → ");
        notes.answers.push(byLang(lang, `正确顺序：${seq}`, `Correct order: ${seq}`, `正确顺序 Correct order：${seq}`));
        notes.interaction.push(
          byLang(
            lang,
            "排序：卡片已打乱。PPT 编辑模式下每张卡片都是可拖动的形状；放映时让学生说出顺序，再按讲稿揭示。HTML 课件可拖动 / 点两张交换，“下一步”自动归位。",
            "Cards are separate shapes; drag them in edit mode or reveal verbally from these notes.",
            "排序：卡片已打乱。PPT 编辑模式下每张卡片都是可拖动的形状；放映时让学生说出顺序，再按讲稿揭示。HTML 课件可拖动 / 点两张交换，“下一步”自动归位。· Cards are separate shapes; drag them in edit mode.",
          ),
        );
      }
      return items;
    }
    case "summary": {
      const items: Item[] = [title(c.title, p)];
      const n = c.nodes.length;
      const gap = 48;
      const w = (W - gap * (n - 1)) / n;
      const headScale = ts.large ? 60 / ts.compact : 56 / 48;
      c.nodes.forEach((node, i) => {
        const x = M + i * (w + gap);
        items.push(text(`nodes.${i}`, { x, y: BODY_Y, w, h: BODY_H }, [richPara(node.head, p, { bold: true, color: p.accent, scale: headScale }), ...(node.detail ? [richPara(node.detail, p, { gap: 24 })] : [])], p, { fontPx: ts.compact, minFontPx: ts.compactMin, fill: p.panel, line: p.panelLine, inset: 28, shape: "roundRect", lineFactor: 1.15 }, ts));
        if (i < n - 1) items.push({ kind: "shape", shape: "rightArrow", rect: { x: x + w + 6, y: BODY_Y + BODY_H / 2 - 18, w: gap - 12, h: 36 }, fill: p.accent });
      });
      notes.interaction.push(
        byLang(lang, "结构图在 HTML 里逐块揭示；PPT 里一次全部显示。", "Nodes appear all at once here.", "结构图在 HTML 里逐块揭示；PPT 里一次全部显示。· Nodes appear all at once here."),
      );
      return items;
    }
  }
}

function unverifiedNote(u: Unverified[] | undefined, lang?: TeachingLanguage): string[] {
  if (!u?.length) return [];
  const joined = u.map((x) => `${plain(x.text)}${x.detail ? `（${plain(x.detail)}）` : ""}`).join(lang === "en" ? "; " : "；");
  return [byLang(lang, `待核实：${joined}`, `To verify: ${joined}`, `待核实 To verify：${joined}`)];
}

/** One deck slide → its PPTX objects and speaker notes. Never throws for schema-valid content. */
export function planSlide(slide: Pick<Slide, "content" | "notes" | "sources" | "unverified"> & { pageType?: PageType }, ctx: PlanContext): SlidePlan {
  const p = PALETTES[ctx.theme] ?? PALETTES.classic;
  const lang = ctx.language;
  const ts = scaleFor(resolveFontScale(ctx));
  const notes: Notes = { answers: [], interaction: [], other: [], degraded: [] };
  const items = body(slide.content, p, notes, ts, slide.pageType, lang);
  const src = sourcesLine(slide as Slide, ctx, p);
  if (src) items.push(src);
  for (const it of items) if (it.kind === "text") it.fontPx = fitFont(it).fontPx;
  for (const it of items) if (it.kind === "image") it.fallback.fontPx = fitFont(it.fallback).fontPx;
  const answerHead = byLang(lang, "【答案 · 只在讲稿里】", "[Answers — speaker notes only]", "【答案 · 只在讲稿里】");
  const interactionHead = byLang(lang, "【互动 · 和 HTML 课件的区别】", "[Interactions — differences from HTML deck]", "【互动 · 和 HTML 课件的区别】");
  const sections = [
    plain(slide.notes.trim()),
    notes.answers.length ? `${answerHead}\n${notes.answers.join("\n")}` : "",
    notes.interaction.length ? `${interactionHead}\n${notes.interaction.join("\n")}` : "",
    [...notes.other, ...unverifiedNote(slide.unverified, lang)].join("\n"),
  ].filter(Boolean);
  return { items, notes: sections.join("\n\n"), degraded: notes.degraded };
}

/** Every text box's estimated fit (unit tests and the export summary). */
export function overflowingSlots(plan: SlidePlan): string[] {
  return plan.items.filter((it): it is TextItem => it.kind === "text" && !fitFont(it).fits).map((it) => it.slot);
}
