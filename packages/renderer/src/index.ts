import katex from "katex";
import {
  CANVAS,
  type Color,
  type Element,
  type ExperimentEl,
  type FormulaEl,
  type ImageEl,
  type Paragraph,
  type RevealEl,
  type Run,
  type ShapeEl,
  type Slide,
  type TableEl,
  type TextEl,
  type ThemeTokens,
} from "@kj/schema";

export type RenderMode = "present" | "share" | "thumbnail" | "speaker";

export interface RenderContext {
  theme: ThemeTokens;
  mode: RenderMode;
  resolveAsset(assetId: string): string;
  doc?: Document;
}

export const FONT_STACK_LATIN_FIRST = (latin: string, ea: string) =>
  `"${latin}", "${ea}", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;

export function themeCssVars(theme: ThemeTokens): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme.color)) vars[`--kj-color-${k}`] = v;
  vars["--kj-font-heading"] = FONT_STACK_LATIN_FIRST(theme.font.heading.latin, theme.font.heading.ea);
  vars["--kj-font-body"] = FONT_STACK_LATIN_FIRST(theme.font.body.latin, theme.font.body.ea);
  vars["--kj-font-mono"] = theme.font.mono;
  vars["--kj-lh-body"] = String(theme.lineHeight.body);
  vars["--kj-lh-heading"] = String(theme.lineHeight.heading);
  vars["--kj-radius"] = `${theme.shape.radius}px`;
  vars["--kj-zh-color"] = theme.bilingual.zhColor;
  return vars;
}

export function resolveColor(color: Color | undefined, fallback = "inherit"): string {
  if (!color) return fallback;
  return color.startsWith("token:") ? `var(--kj-color-${color.slice(6)})` : color;
}

function h<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string, style?: Partial<Record<string, string>>): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (style) for (const [k, v] of Object.entries(style)) if (v !== undefined) node.style.setProperty(k, v);
  return node;
}

function px(n: number): string {
  return `${Math.round(n * 100) / 100}px`;
}

function fontSize(pt: number): string {
  return `calc(${pt}px * var(--kj-fit, 1))`;
}

function renderRun(doc: Document, run: Run, theme: ThemeTokens): HTMLElement {
  const span = h(doc, "span", "kj-run");
  span.dataset.id = run.id;
  if (run.lang === "zh") span.lang = "zh-CN";
  else if (run.lang === "en") span.lang = "en";
  const m = run.marks ?? {};
  if (m.bold) span.style.fontWeight = "700";
  if (m.italic) span.style.fontStyle = "italic";
  if (m.underline) span.style.textDecoration = "underline";
  if (m.color) span.style.color = resolveColor(m.color);
  if (m.sizePt) span.style.fontSize = fontSize(m.sizePt);
  if (m.fontRole === "heading") span.style.fontFamily = "var(--kj-font-heading)";
  if (m.fontRole === "mono") span.style.fontFamily = "var(--kj-font-mono)";
  if (m.sup || m.sub) {
    span.style.verticalAlign = m.sup ? "super" : "sub";
    span.style.fontSize = "0.7em";
  }
  if (run.lang === "zh" && theme.bilingual.termStyle === "zhInParens" && !m.color) span.classList.add("kj-zh");
  if (run.math) {
    span.classList.add("kj-math");
    span.innerHTML = katex.renderToString(run.math.latex, { throwOnError: false, output: "html" });
  } else if (m.link) {
    const a = h(doc, "a");
    a.href = m.link;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = run.text;
    span.append(a);
  } else {
    span.textContent = run.text;
  }
  return span;
}

function renderParagraphs(doc: Document, paragraphs: Paragraph[], theme: ThemeTokens, baseSize: number): HTMLElement {
  const wrap = h(doc, "div", "kj-paras");
  let number = 0;
  for (const p of paragraphs) {
    const node = h(doc, "p", "kj-p", {
      "text-align": p.align ?? "left",
      "margin-left": p.level ? px(p.level * 28) : undefined,
      "margin-bottom": px(p.spaceAfterPt ?? theme.spacing.paragraphAfter),
      "line-height": p.lineHeightPt ? fontSize(p.lineHeightPt) : undefined,
      "font-size": fontSize(p.runs[0]?.marks?.sizePt ?? baseSize),
    });
    node.dataset.id = p.id;
    if (p.bullet && p.bullet.kind !== "none") {
      node.classList.add("kj-bullet");
      const marker = h(doc, "span", "kj-marker");
      marker.textContent = p.bullet.kind === "number" ? `${++number}.` : "•";
      node.append(marker);
    } else {
      number = 0;
    }
    for (const r of p.runs) node.append(renderRun(doc, r, theme));
    wrap.append(node);
  }
  return wrap;
}

function frameStyle(el: Element, offset = { x: 0, y: 0 }): Record<string, string | undefined> {
  const f = el.frame;
  return {
    left: px(f.x - offset.x),
    top: px(f.y - offset.y),
    width: px(f.w),
    height: px(f.h),
    transform: f.rot ? `rotate(${f.rot}deg)` : undefined,
  };
}

function renderText(doc: Document, el: TextEl, ctx: RenderContext): HTMLElement {
  const node = h(doc, "div", "kj-el kj-text", {
    "justify-content": el.vAlign === "middle" ? "center" : el.vAlign === "bottom" ? "flex-end" : "flex-start",
    background: el.fill ? resolveColor(el.fill) : undefined,
    border: el.stroke ? `${px(el.stroke.width)} solid ${resolveColor(el.stroke.color)}` : undefined,
    "border-radius": el.radius !== undefined ? px(el.radius) : undefined,
    padding: el.padding !== undefined ? px(el.padding) : undefined,
  });
  if (el.role === "title") node.classList.add("kj-title");
  node.dataset.fit = el.fit.mode;
  node.dataset.minSize = String(el.fit.minSize);
  node.append(renderParagraphs(doc, el.body, ctx.theme, ctx.theme.typeScale.body));
  return node;
}

function renderImage(doc: Document, el: ImageEl, ctx: RenderContext): HTMLElement {
  const node = h(doc, "div", "kj-el kj-image", {
    "border-radius": el.radius !== undefined ? px(el.radius) : undefined,
    border: el.border ? `${px(el.border.width)} solid ${resolveColor(el.border.color)}` : undefined,
  });
  const img = h(doc, "img");
  img.src = ctx.resolveAsset(el.assetId);
  img.alt = el.alt ?? "";
  img.draggable = false;
  if (el.crop) {
    const wScale = 1 / Math.max(0.05, 1 - el.crop.l - el.crop.r);
    const hScale = 1 / Math.max(0.05, 1 - el.crop.t - el.crop.b);
    Object.assign(img.style, {
      position: "absolute",
      width: `${wScale * 100}%`,
      height: `${hScale * 100}%`,
      left: `${-el.crop.l * wScale * 100}%`,
      top: `${-el.crop.t * hScale * 100}%`,
      objectFit: "fill",
    });
  } else {
    img.style.objectFit = el.fit;
  }
  node.append(img);
  return node;
}

function renderTable(doc: Document, el: TableEl, ctx: RenderContext): HTMLElement {
  const node = h(doc, "div", "kj-el kj-table");
  const table = h(doc, "table");
  const colgroup = h(doc, "colgroup");
  const totalW = el.columns.reduce((s, c) => s + c.width, 0);
  for (const c of el.columns) {
    const col = h(doc, "col");
    col.style.width = `${(c.width / totalW) * 100}%`;
    col.dataset.id = c.id;
    colgroup.append(col);
  }
  table.append(colgroup);
  const tbody = h(doc, "tbody");
  for (const row of el.rows) {
    const tr = h(doc, "tr", row.header ? "kj-th-row" : undefined, { height: px(row.height) });
    tr.dataset.id = row.id;
    for (const cell of row.cells) {
      const td = h(doc, row.header ? "th" : "td", undefined, { background: cell.fill ? resolveColor(cell.fill) : undefined });
      td.dataset.id = cell.id;
      if (cell.colSpan) td.colSpan = cell.colSpan;
      if (cell.rowSpan) td.rowSpan = cell.rowSpan;
      td.append(renderParagraphs(doc, cell.body, ctx.theme, ctx.theme.typeScale.small));
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  node.append(table);
  return node;
}

function renderFormula(doc: Document, el: FormulaEl): HTMLElement {
  const node = h(doc, "div", "kj-el kj-formula", { "font-size": fontSize(el.sizePt) });
  node.innerHTML = katex.renderToString(el.latex, { throwOnError: false, displayMode: el.display, output: "html" });
  return node;
}

function renderShape(doc: Document, el: ShapeEl, ctx: RenderContext): HTMLElement {
  const node = h(doc, "div", "kj-el kj-shape");
  const { w, hgt } = { w: Math.max(el.frame.w, 1), hgt: Math.max(el.frame.h, 1) };
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(svgNs, "svg");
  const stroke = el.stroke ? resolveColor(el.stroke.color) : "none";
  const strokeW = el.stroke?.width ?? 0;
  const fill = el.fill ? resolveColor(el.fill) : "none";
  const isLine = el.geometry === "line" || el.geometry === "arrow";
  // A zero-height frame is a horizontal line; a 100%-height SVG would collapse to nothing.
  const flat = isLine && el.frame.h === 0;
  const pad = Math.max(strokeW || 2, 2) * 3;
  if (flat) {
    svg.setAttribute("viewBox", `0 ${-pad} ${w} ${pad * 2}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", px(pad * 2));
    Object.assign(svg.style, { position: "absolute", left: "0", top: px(-pad) });
  } else {
    svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
  }
  svg.style.overflow = "visible";
  let shape: SVGElement;
  if (isLine) {
    shape = doc.createElementNS(svgNs, "line");
    shape.setAttribute("x1", "0");
    shape.setAttribute("y1", "0");
    shape.setAttribute("x2", String(w));
    shape.setAttribute("y2", flat ? "0" : String(hgt));
    shape.setAttribute("stroke", el.stroke ? stroke : "currentColor");
    shape.setAttribute("stroke-width", String(strokeW || 2));
    shape.setAttribute("vector-effect", "non-scaling-stroke");
    if (el.geometry === "arrow") {
      const markerId = `kj-arrow-${el.id}`;
      const defs = doc.createElementNS(svgNs, "defs");
      const marker = doc.createElementNS(svgNs, "marker");
      marker.setAttribute("id", markerId);
      marker.setAttribute("viewBox", "0 0 10 10");
      marker.setAttribute("refX", "8");
      marker.setAttribute("refY", "5");
      marker.setAttribute("markerWidth", "5");
      marker.setAttribute("markerHeight", "5");
      marker.setAttribute("orient", "auto-start-reverse");
      const path = doc.createElementNS(svgNs, "path");
      path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
      path.setAttribute("fill", el.stroke ? stroke : "currentColor");
      marker.append(path);
      defs.append(marker);
      svg.append(defs);
      shape.setAttribute("marker-end", `url(#${markerId})`);
    }
  } else if (el.geometry === "ellipse") {
    shape = doc.createElementNS(svgNs, "ellipse");
    shape.setAttribute("cx", String(w / 2));
    shape.setAttribute("cy", String(hgt / 2));
    shape.setAttribute("rx", String(Math.max(0, w / 2 - strokeW / 2)));
    shape.setAttribute("ry", String(Math.max(0, hgt / 2 - strokeW / 2)));
  } else {
    shape = doc.createElementNS(svgNs, "rect");
    shape.setAttribute("x", String(strokeW / 2));
    shape.setAttribute("y", String(strokeW / 2));
    shape.setAttribute("width", String(Math.max(0, w - strokeW)));
    shape.setAttribute("height", String(Math.max(0, hgt - strokeW)));
    if (el.geometry === "roundRect") shape.setAttribute("rx", String(ctx.theme.shape.radius));
  }
  if (el.geometry !== "line" && el.geometry !== "arrow") {
    shape.setAttribute("fill", fill);
    shape.setAttribute("stroke", stroke);
    shape.setAttribute("stroke-width", String(strokeW));
  }
  svg.append(shape);
  node.append(svg);
  if (el.body?.length) {
    const label = h(doc, "div", "kj-shape-label");
    label.append(renderParagraphs(doc, el.body, ctx.theme, ctx.theme.typeScale.small));
    node.append(label);
  }
  return node;
}

function renderExperiment(doc: Document, el: ExperimentEl): HTMLElement {
  const node = h(doc, "div", "kj-el kj-experiment");
  node.dataset.provider = el.provider;
  node.dataset.component = el.componentId;
  node.dataset.locale = el.params.locale;
  if (el.params.initial) node.dataset.initial = JSON.stringify(el.params.initial);
  const card = h(doc, "div", "kj-exp-fallback");
  const icon = h(doc, "div", "kj-exp-icon");
  icon.textContent = "▶";
  const en = h(doc, "div", "kj-exp-caption");
  en.textContent = el.fallback.caption.en;
  const zh = h(doc, "div", "kj-exp-caption-zh");
  zh.lang = "zh-CN";
  zh.textContent = el.fallback.caption.zh;
  const code = h(doc, "div", "kj-exp-code");
  code.textContent = `Interactive · 交互实验 · ${el.fallback.shortCode}`;
  card.append(icon, en, zh, code);
  node.append(card);
  if (el.attribution) {
    const attr = h(doc, "div", "kj-exp-attribution");
    attr.textContent = el.attribution;
    node.append(attr);
  }
  return node;
}

function renderReveal(doc: Document, el: RevealEl): HTMLElement {
  const node = h(doc, "button", "kj-el kj-reveal");
  node.type = "button";
  node.dataset.reveal = el.revealIds.join(" ");
  node.textContent = el.label ?? "Show answer · 显示答案";
  if (el.trigger.kind === "hotspot") node.classList.add("kj-reveal-hotspot");
  return node;
}

function renderElement(doc: Document, el: Element, ctx: RenderContext, offset = { x: 0, y: 0 }): HTMLElement | null {
  if (el.hidden) return null;
  let node: HTMLElement;
  switch (el.type) {
    case "text":
      node = renderText(doc, el, ctx);
      break;
    case "image":
      node = renderImage(doc, el, ctx);
      break;
    case "table":
      node = renderTable(doc, el, ctx);
      break;
    case "formula":
      node = renderFormula(doc, el);
      break;
    case "shape":
      node = renderShape(doc, el, ctx);
      break;
    case "experiment":
      node = renderExperiment(doc, el);
      break;
    case "reveal":
      node = renderReveal(doc, el);
      break;
    case "group": {
      node = h(doc, "div", "kj-el kj-group");
      for (const child of el.children) {
        const c = renderElement(doc, child, ctx, { x: el.frame.x, y: el.frame.y });
        if (c) node.append(c);
      }
      break;
    }
  }
  for (const [k, v] of Object.entries(frameStyle(el, offset))) if (v !== undefined) node.style.setProperty(k, v);
  node.dataset.id = el.id;
  node.dataset.type = el.type;
  if (el.role) node.dataset.role = el.role;
  if (el.alt && el.type !== "image") node.setAttribute("aria-label", el.alt);
  return node;
}

/**
 * Renders one slide into a fixed 960×540 logical box. Callers scale it with CSS transforms;
 * 1 logical px == 1 pt of the deck coordinate system.
 */
export function renderSlide(slide: Slide, ctx: RenderContext): HTMLElement {
  const doc = ctx.doc ?? document;
  const root = h(doc, "div", `kj-slide kj-mode-${ctx.mode}`, {
    width: px(CANVAS.width),
    height: px(CANVAS.height),
  });
  for (const [k, v] of Object.entries(themeCssVars(ctx.theme))) root.style.setProperty(k, v);
  root.dataset.slideId = slide.id;
  root.lang = "en";

  for (const el of slide.elements) {
    const node = renderElement(doc, el, ctx);
    if (node) root.append(node);
  }

  const interactive = ctx.mode === "present" || ctx.mode === "share";
  for (const build of slide.builds ?? []) {
    for (const id of build.elementIds) {
      const node = root.querySelector<HTMLElement>(`[data-id="${id}"]`);
      if (!node) continue;
      node.dataset.buildOrder = String(build.order);
      node.dataset.buildEffect = build.effect;
    }
  }

  root.querySelectorAll<HTMLElement>(".kj-reveal").forEach((btn) => {
    const ids = (btn.dataset.reveal ?? "").split(" ").filter(Boolean);
    const targets = ids.map((id) => root.querySelector<HTMLElement>(`[data-id="${id}"]`)).filter((n): n is HTMLElement => !!n);
    if (!interactive) return;
    for (const t of targets) t.classList.add("kj-reveal-hidden");
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const hidden = targets.some((t) => t.classList.contains("kj-reveal-hidden"));
      for (const t of targets) t.classList.toggle("kj-reveal-hidden", !hidden);
      btn.classList.toggle("kj-reveal-open", hidden);
    });
  });

  if (ctx.theme.branding.slideNumber || ctx.theme.branding.footer) {
    const footer = h(doc, "div", "kj-footer");
    if (ctx.theme.branding.footer) {
      const f = h(doc, "span", "kj-footer-text");
      f.textContent = ctx.theme.branding.footer;
      footer.append(f);
    }
    const num = h(doc, "span", "kj-slide-number");
    footer.append(num);
    root.append(footer);
  }
  return root;
}

export function setSlideNumber(root: HTMLElement, n: number, total: number): void {
  const node = root.querySelector<HTMLElement>(".kj-slide-number");
  if (node) node.textContent = `${n} / ${total}`;
}

/** Applies build visibility for a given step (0 = nothing built yet). Returns the max step. */
export function applyBuildStep(root: HTMLElement, step: number): number {
  let max = 0;
  root.querySelectorAll<HTMLElement>("[data-build-order]").forEach((node) => {
    const order = Number(node.dataset.buildOrder);
    max = Math.max(max, order);
    const effect = node.dataset.buildEffect;
    if (effect === "highlight") {
      node.classList.toggle("kj-build-highlight", order === step);
    } else {
      node.classList.toggle("kj-build-pending", order > step);
    }
  });
  return max;
}

export function maxBuildStep(slide: Slide): number {
  return (slide.builds ?? []).reduce((m, b) => Math.max(m, b.order), 0);
}

/**
 * Shrinks text boxes marked shrinkOnOverflow until their content fits, never below minSize.
 * Needs a laid-out DOM (attached and with fonts loaded); returns ids that still overflow.
 */
export function fitText(root: HTMLElement): string[] {
  const overflowing: string[] = [];
  root.querySelectorAll<HTMLElement>('.kj-text[data-fit="shrinkOnOverflow"]').forEach((node) => {
    node.style.setProperty("--kj-fit", "1");
    if (node.scrollHeight <= node.clientHeight + 1) return;
    const sizes = [...node.querySelectorAll<HTMLElement>(".kj-p")].map((p) => parseFloat(p.style.fontSize.replace(/[^\d.]/g, "")) || 20);
    const largest = Math.max(...sizes, 1);
    const minScale = Math.min(1, Number(node.dataset.minSize ?? 14) / largest);
    let scale = 1;
    while (node.scrollHeight > node.clientHeight + 1 && scale > minScale) {
      scale = Math.max(minScale, scale - 0.04);
      node.style.setProperty("--kj-fit", scale.toFixed(3));
    }
    if (node.scrollHeight > node.clientHeight + 1) overflowing.push(node.dataset.id ?? "?");
  });
  return overflowing;
}

/** Text of an element for quick assertions, measurement reports and accessibility. */
export function textContentOf(root: HTMLElement, id: string): string {
  return root.querySelector<HTMLElement>(`[data-id="${id}"]`)?.textContent ?? "";
}
