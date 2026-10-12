import PptxGenJS from "pptxgenjs";
import { LINE, type ChartItem, type ImageItem, type Item, type Palette, type SlidePlan, type TableItem, type TextItem } from "./plan.ts";
import { hasCjk } from "./text.ts";

const inch = (px: number) => px / 144;
const pt = (px: number) => px / 2;

export interface WriteOptions {
  title: string;
  fontFace: string;
  palette: Palette;
  /** PNG data URL for a chart a native PPTX chart cannot express; null keeps the text fallback. */
  chartImage?: (item: ImageItem) => Promise<string | null>;
  /** Text boxes grow to fit their text (`spAutoFit`) so a renderer reports the height it needs; for the overflow test only. */
  probe?: boolean;
}

const box = (it: { rect: { x: number; y: number; w: number; h: number } }) => ({ x: inch(it.rect.x), y: inch(it.rect.y), w: inch(it.rect.w), h: inch(it.rect.h) });

function addText(pptx: PptxGenJS, slide: PptxGenJS.Slide, it: TextItem, font: string, probe = false): void {
  const runs: PptxGenJS.TextProps[] = [];
  it.paras.forEach((p, pi) => {
    const size = pt(it.fontPx * (p.runs[0]?.scale ?? 1));
    p.runs.forEach((r, ri) => {
      const last = ri === p.runs.length - 1 && pi < it.paras.length - 1;
      runs.push({
        text: r.text,
        options: {
          fontSize: pt(it.fontPx * (r.scale ?? 1)),
          bold: r.bold ?? it.bold ?? false,
          color: r.color ?? it.color,
          lang: hasCjk(r.text) ? "zh-CN" : "en-US",
          ...(ri === 0 ? { lineSpacing: size * (it.lineFactor ?? LINE), paraSpaceBefore: pi > 0 ? pt(p.gap ?? 0) : 0, ...(p.bullet ? { bullet: { indent: size * 0.9 } } : {}) } : {}),
          ...(last ? { breakLine: true } : {}),
        },
      });
    });
  });
  const inset = pt(it.inset ?? 0);
  slide.addText(runs, {
    ...box(it),
    fontFace: font,
    fontSize: pt(it.fontPx),
    color: it.color,
    align: it.align ?? "left",
    valign: it.valign ?? "top",
    margin: [inset, inset, inset, inset],
    fit: probe ? "resize" : "none",
    objectName: it.slot,
    ...(it.fill ? { fill: { color: it.fill } } : {}),
    ...(it.line ? { line: { color: it.line, width: 1.5, ...(it.dashed ? { dashType: "dash" as const } : {}) } } : {}),
    ...(it.shape === "roundRect" ? { shape: pptx.ShapeType.roundRect, rectRadius: 0.12 } : it.shape === "ellipse" ? { shape: pptx.ShapeType.ellipse } : {}),
  });
}

function addTable(slide: PptxGenJS.Slide, it: TableItem, font: string, p: Palette): void {
  const cell = (text: string, header: boolean): PptxGenJS.TableCell => ({
    text,
    options: { bold: header, fill: { color: header ? p.panel : p.bg }, color: p.text, lang: hasCjk(text) ? "zh-CN" : "en-US" },
  });
  const rows = [it.header.map((h) => cell(h, true)), ...it.rows.map((r) => r.map((c) => cell(c, false)))];
  const cols = it.header.length;
  slide.addTable(rows, {
    ...box(it),
    colW: Array.from({ length: cols }, () => inch(it.rect.w / cols)),
    rowH: Array.from({ length: rows.length }, () => inch(it.rowPx)),
    fontFace: font,
    fontSize: pt(it.fontPx),
    valign: "middle",
    margin: 0.08,
    border: { type: "solid", pt: 1.5, color: p.panelLine },
  });
}

function addChart(pptx: PptxGenJS, slide: PptxGenJS.Slide, it: ChartItem, font: string, p: Palette): void {
  const label = 18;
  const common: PptxGenJS.IChartOpts = {
    ...box(it),
    chartColors: it.series.map((s) => s.color),
    showLegend: it.series.length > 1,
    legendPos: "t",
    legendFontFace: font,
    legendFontSize: label,
    legendColor: p.text,
    showCatAxisTitle: !!it.xLabel,
    catAxisTitle: it.xLabel,
    showValAxisTitle: !!it.yLabel,
    valAxisTitle: it.yLabel,
    catAxisTitleFontFace: font,
    valAxisTitleFontFace: font,
    catAxisTitleFontSize: label,
    valAxisTitleFontSize: label,
    catAxisTitleColor: p.text,
    valAxisTitleColor: p.text,
    catAxisLabelFontFace: font,
    valAxisLabelFontFace: font,
    catAxisLabelFontSize: label,
    valAxisLabelFontSize: label,
    catAxisLabelColor: p.text,
    valAxisLabelColor: p.text,
    valGridLine: { color: p.panelLine, size: 1 },
    catGridLine: { style: "none" },
    catAxisLabelPos: "low",
    ...(it.yRange ? { valAxisMinVal: it.yRange[0], valAxisMaxVal: it.yRange[1] } : {}),
  };
  if (it.type === "scatter") {
    const data = [{ name: "X", values: it.x ?? [] }, ...it.series.map((s) => ({ name: s.name, values: s.values }))];
    slide.addChart(pptx.ChartType.scatter, data, {
      ...common,
      lineSize: it.smoothLine ? 4 : 0,
      lineDataSymbol: it.smoothLine ? "none" : "circle",
      lineDataSymbolSize: 10,
      ...(it.xRange ? { catAxisMinVal: it.xRange[0], catAxisMaxVal: it.xRange[1] } : {}),
    });
    return;
  }
  slide.addChart(it.type === "bar" ? pptx.ChartType.bar : pptx.ChartType.line, it.series.map((s) => ({ name: s.name, labels: s.labels, values: s.values })), {
    ...common,
    barDir: "col",
    lineSize: 4,
    lineDataSymbolSize: 10,
    showValue: it.dataLabels,
    dataLabelFontFace: font,
    dataLabelFontSize: label,
    dataLabelColor: p.text,
    dataLabelPosition: "outEnd",
  });
}

async function addItem(pptx: PptxGenJS, slide: PptxGenJS.Slide, it: Item, o: WriteOptions): Promise<void> {
  const p = o.palette;
  switch (it.kind) {
    case "text":
      return addText(pptx, slide, it, o.fontFace, o.probe);
    case "shape":
      slide.addShape(pptx.ShapeType[it.shape], { ...box(it), fill: it.fill ? { color: it.fill } : { type: "none" }, line: it.line ? { color: it.line, width: 1.5, ...(it.dashed ? { dashType: "dash" as const } : {}) } : { type: "none" } });
      return;
    case "table":
      return addTable(slide, it, o.fontFace, p);
    case "chart":
      return addChart(pptx, slide, it, o.fontFace, p);
    case "image": {
      const data = await o.chartImage?.(it).catch(() => null);
      if (data) slide.addImage({ data, ...box(it), sizing: { type: "contain", w: inch(it.rect.w), h: inch(it.rect.h) } });
      else addText(pptx, slide, it.fallback, o.fontFace, o.probe);
      return;
    }
  }
}

/** Writes planned slides into a 16:9 .pptx (one PPTX slide per plan). */
export async function writePptx(plans: SlidePlan[], o: WriteOptions): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = o.title;
  pptx.company = "AI 课件工坊";
  pptx.theme = { headFontFace: o.fontFace, bodyFontFace: o.fontFace };
  for (const plan of plans) {
    const slide = pptx.addSlide();
    slide.background = { color: o.palette.bg };
    for (const it of plan.items) await addItem(pptx, slide, it, o);
    if (plan.notes) slide.addNotes(plan.notes);
  }
  return (await pptx.write({ outputType: "uint8array" })) as Uint8Array;
}
