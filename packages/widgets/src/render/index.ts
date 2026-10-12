import katex from "katex";
import { BarChart, LineChart, ScatterChart } from "echarts/charts";
import { GridComponent, LegendComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import type { FlowSpec, FormulaSpec, FunctionSpec, PlaceholderSpec, SimSpec, TableSpec, WidgetSpec } from "@kj/schema";
import { chartOption, functionOption, initialValues, resolveEmbed, type Palette } from "../index.ts";

echarts.use([BarChart, LineChart, ScatterChart, GridComponent, LegendComponent, SVGRenderer]);

export interface WidgetHandle {
  dispose(): void;
}

export interface WidgetContext {
  /** Thumbnails and measurement render static (no iframes, no slider handlers). */
  interactive: boolean;
}

let embedHtml: Record<string, string> | null = null;

/** Self-contained decks (offline export) ship each simulation's HTML and load it via srcdoc. */
export function inlineEmbeds(html: Record<string, string>): void {
  embedHtml = html;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Plain text with inline $...$ math rendered by KaTeX. Never interprets HTML. */
export function renderRichText(target: HTMLElement, text: string): HTMLElement {
  target.replaceChildren();
  const parts = text.split(/(\$[^$]{1,200}\$)/g);
  for (const part of parts) {
    if (part.length > 2 && part.startsWith("$") && part.endsWith("$")) {
      const span = document.createElement("span");
      span.className = "kj-math";
      try {
        katex.render(part.slice(1, -1), span, { throwOnError: false, output: "html", strict: "ignore", trust: false });
      } catch {
        span.textContent = part.slice(1, -1);
      }
      target.append(span);
    } else if (part) {
      target.append(document.createTextNode(part));
    }
  }
  return target;
}

export function paletteFrom(node: HTMLElement): Palette {
  const css = getComputedStyle(node);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    accent: v("--kj-accent", "#1f5fbf"),
    series: [v("--kj-series-1", "#1f5fbf"), v("--kj-series-2", "#e07b00"), v("--kj-series-3", "#2a9d5c"), v("--kj-series-4", "#8e44ad")],
    muted: v("--kj-muted", "#b9c0cc"),
    text: v("--kj-text", "#1b2330"),
    grid: v("--kj-grid", "#e3e7ee"),
    fontFamily: v("--kj-font", "sans-serif"),
  };
}

function mountChart(host: HTMLElement, option: () => Record<string, unknown>): { chart: echarts.ECharts; dispose(): void } {
  const chart = echarts.init(host, null, { renderer: "svg" });
  chart.setOption(option());
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => chart.resize()) : null;
  ro?.observe(host);
  return {
    chart,
    dispose() {
      ro?.disconnect();
      chart.dispose();
    },
  };
}

function renderFunction(spec: FunctionSpec, host: HTMLElement, ctx: WidgetContext): WidgetHandle {
  const values = initialValues(spec);
  const plot = el("div", "kj-plot");
  host.append(plot);
  let controls: HTMLElement | null = null;
  if (spec.params.length) {
    controls = el("div", "kj-sliders");
    host.append(controls);
    host.classList.add("has-sliders");
  }
  const palette = paletteFrom(host);
  const mounted = mountChart(plot, () => functionOption(spec, values, palette));
  if (controls) {
    for (const p of spec.params) {
      const row = el("label", "kj-slider");
      const name = el("span", "kj-slider-name");
      const out = el("output", "kj-slider-value");
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(p.min);
      input.max = String(p.max);
      input.step = String(p.step);
      input.value = String(p.value);
      input.disabled = !ctx.interactive;
      input.setAttribute("aria-label", p.label);
      renderRichText(name, p.label);
      const show = () => (out.textContent = Number(values[p.name]).toFixed(p.step < 1 ? 1 : 0));
      show();
      input.addEventListener("input", () => {
        values[p.name] = Number(input.value);
        show();
        mounted.chart.setOption(functionOption(spec, values, palette));
      });
      row.append(name, input, out);
      controls.append(row);
    }
  }
  return { dispose: () => mounted.dispose() };
}

function renderFlow(spec: FlowSpec, host: HTMLElement): WidgetHandle {
  const list = el("ol", "kj-flow");
  spec.steps.forEach((s, i) => {
    const li = el("li", "kj-flow-step");
    if (i > 0) li.dataset.step = String(i);
    renderRichText(li, s);
    list.append(li);
  });
  host.append(list);
  return { dispose() {} };
}

function renderFormula(spec: FormulaSpec, host: HTMLElement): WidgetHandle {
  const box = el("div", "kj-formula");
  const math = el("div", "kj-formula-tex");
  try {
    katex.render(spec.tex, math, { displayMode: true, throwOnError: false, strict: "ignore", trust: false });
  } catch {
    math.textContent = spec.tex;
  }
  box.append(math);
  if (spec.caption) box.append(renderRichText(el("div", "kj-formula-caption"), spec.caption));
  host.append(box);
  return { dispose() {} };
}

function renderSim(spec: SimSpec, host: HTMLElement, ctx: WidgetContext): WidgetHandle {
  const entry = resolveEmbed(spec.embedId);
  const frame = el("div", "kj-sim");
  if (!entry) {
    frame.append(el("div", "kj-sim-missing", `Simulation "${spec.embedId}" is not available`));
  } else if (!ctx.interactive) {
    frame.append(el("div", "kj-sim-placeholder", `▶ ${entry.title.en} · ${entry.title.zh}`));
  } else {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.title = entry.title.en;
    const inline = embedHtml?.[entry.id];
    if (inline !== undefined) iframe.srcdoc = inline;
    else iframe.src = entry.src;
    frame.append(iframe);
  }
  if (entry) frame.append(el("div", "kj-sim-credit", spec.caption || entry.attribution));
  host.append(frame);
  return { dispose() {} };
}

function renderTable(spec: TableSpec, host: HTMLElement): WidgetHandle {
  const table = el("table", "kj-table");
  const head = el("tr", "");
  for (const c of spec.columns) head.append(renderRichText(el("th", ""), c));
  table.append(el("thead", ""), el("tbody", ""));
  table.tHead!.append(head);
  for (const r of spec.rows) {
    const tr = el("tr", "");
    for (const c of r) tr.append(renderRichText(el("td", ""), c));
    table.tBodies[0]!.append(tr);
  }
  host.append(table);
  if (spec.caption) host.append(renderRichText(el("div", "kj-table-caption"), spec.caption));
  return { dispose() {} };
}

function renderPlaceholder(spec: PlaceholderSpec, host: HTMLElement): WidgetHandle {
  const box = el("div", "kj-visual-todo");
  box.append(el("b", "", "图示待补 · Visual to add"));
  if (spec.hint) box.append(renderRichText(el("span", ""), spec.hint));
  host.append(box);
  return { dispose() {} };
}

/** Renders a widget into `host` (which must already have its final size). */
/** Renders a widget; a spec that throws (e.g. an expression that does not compile) shows the 图示待补 placeholder instead. */
export function renderWidget(spec: WidgetSpec, host: HTMLElement, ctx: WidgetContext): WidgetHandle {
  try {
    return renderWidgetUnchecked(spec, host, ctx);
  } catch (e) {
    host.replaceChildren();
    host.classList.remove(`kj-widget-${spec.kind}`);
    host.classList.add("kj-widget-placeholder", "kj-widget-failed");
    host.dataset.error = (e as Error).message.slice(0, 200);
    return renderPlaceholder({ kind: "placeholder", hint: "图示无法显示，请在编辑器里修改 · visual could not be drawn" }, host);
  }
}

function renderWidgetUnchecked(spec: WidgetSpec, host: HTMLElement, ctx: WidgetContext): WidgetHandle {
  host.classList.add("kj-widget", `kj-widget-${spec.kind}`);
  switch (spec.kind) {
    case "chart": {
      const plot = el("div", "kj-plot");
      host.append(plot);
      const palette = paletteFrom(host);
      const mounted = mountChart(plot, () => chartOption(spec, palette));
      return { dispose: () => mounted.dispose() };
    }
    case "function":
      return renderFunction(spec, host, ctx);
    case "flow":
      return renderFlow(spec, host);
    case "formula":
      return renderFormula(spec, host);
    case "sim":
      return renderSim(spec, host, ctx);
    case "table":
      return renderTable(spec, host);
    case "placeholder":
      return renderPlaceholder(spec, host);
  }
}
