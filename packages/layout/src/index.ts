import { CANVAS, newId, SlideSlots, type Element, type Paragraph, type Run, type Slide, type ThemeTokens } from "@kj/schema";

export { SlideSlots };

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;

export function detectLang(text: string): "en" | "zh" | "auto" {
  let cjk = 0;
  let latin = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else if (/[A-Za-z]/.test(ch)) latin++;
  }
  if (cjk && latin) return "auto";
  return cjk ? "zh" : "en";
}

/**
 * Splits mixed text into language runs so the renderer can set `lang` per run
 * (line breaking and punctuation compression differ between en and zh-CN).
 */
export function splitRuns(text: string, marks?: Run["marks"]): Run[] {
  const runs: Run[] = [];
  let buf = "";
  let cur: "en" | "zh" | null = null;
  const flush = () => {
    if (buf) runs.push({ id: newId("r"), text: buf, lang: cur ?? "en", ...(marks ? { marks } : {}) });
    buf = "";
  };
  for (const ch of text) {
    const kind = CJK.test(ch) ? "zh" : /[A-Za-z0-9]/.test(ch) ? "en" : null;
    if (kind && cur && kind !== cur) flush();
    if (kind) cur = kind;
    buf += ch;
  }
  flush();
  return runs;
}

/** Rough advance-width estimate in em units; the renderer still shrinks on real overflow. */
export function estimateTextWidthEm(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (CJK.test(ch)) w += 1;
    else if (/[MW@]/.test(ch)) w += 0.85;
    else if (/[A-Z]/.test(ch)) w += 0.68;
    else if (/[ il.,;:'!|]/.test(ch)) w += 0.28;
    else w += 0.52;
  }
  return w;
}

export function estimateLines(text: string, sizePt: number, widthPt: number): number {
  const perLine = Math.max(1, widthPt / sizePt);
  return Math.max(1, Math.ceil(estimateTextWidthEm(text) / perLine));
}

/** Largest size between body and minimum that fits the box, by estimate. */
export function fitFontSize(paragraphs: string[], box: { w: number; h: number }, theme: ThemeTokens, startPt: number): number {
  for (let size = startPt; size >= theme.typeScale.minimum; size -= 1) {
    const lineH = size * theme.lineHeight.body;
    const total = paragraphs.reduce((h, p) => h + estimateLines(p, size, box.w - size * 1.4) * lineH + theme.spacing.paragraphAfter, 0);
    if (total <= box.h) return size;
  }
  return theme.typeScale.minimum;
}

function para(text: string, opts: Partial<Paragraph> & { marks?: Run["marks"] } = {}): Paragraph {
  const { marks, ...rest } = opts;
  return { id: newId("p"), level: 0, runs: splitRuns(text, marks), ...rest };
}

export interface LayoutInput {
  slots: SlideSlots;
  theme: ThemeTokens;
  outlineItemId: string;
  aiCallId: string;
  specHash: string;
}

export function layoutSlide({ slots, theme, outlineItemId, aiCallId, specHash }: LayoutInput): Slide {
  const pad = theme.spacing.slidePadding;
  const gap = theme.spacing.gap;
  const elements: Element[] = [];
  const contentW = CANVAS.width - pad * 2;

  if (slots.layout === "title") {
    elements.push({
      id: newId("el"),
      type: "shape",
      role: "decor",
      geometry: "rect",
      frame: { x: 0, y: 0, w: CANVAS.width, h: CANVAS.height },
      fill: "token:primary",
    });
    elements.push({
      id: newId("el"),
      type: "text",
      role: "title",
      frame: { x: pad, y: 170, w: contentW, h: 120 },
      fit: { mode: "shrinkOnOverflow", minSize: theme.typeScale.h1 },
      vAlign: "bottom",
      body: [para(slots.title, { marks: { sizePt: theme.typeScale.title + 8, bold: true, fontRole: "heading", color: "token:textOnPrimary" } })],
    });
    if (slots.subtitle) {
      elements.push({
        id: newId("el"),
        type: "text",
        role: "subtitle",
        frame: { x: pad, y: 300, w: contentW, h: 60 },
        fit: { mode: "shrinkOnOverflow", minSize: theme.typeScale.small },
        body: [para(slots.subtitle, { marks: { sizePt: theme.typeScale.h2, color: "token:textOnPrimary" } })],
      });
    }
    return finish(elements, []);
  }

  const titleH = 64;
  elements.push({
    id: newId("el"),
    type: "text",
    role: "title",
    frame: { x: pad, y: pad - 12, w: contentW, h: titleH },
    fit: { mode: "shrinkOnOverflow", minSize: theme.typeScale.h2 },
    vAlign: "middle",
    body: [para(slots.title, { marks: { sizePt: theme.typeScale.h1, bold: true, fontRole: "heading", color: "token:primary" } })],
  });
  elements.push({
    id: newId("el"),
    type: "shape",
    role: "decor",
    geometry: "rect",
    frame: { x: pad, y: pad - 12 + titleH + 4, w: 72, h: 4 },
    fill: "token:accent",
  });

  const bodyTop = pad + titleH + gap;
  const bodyH = CANVAS.height - bodyTop - pad - 8;
  const hasTerms = slots.layout === "title-bullets-terms" && slots.terms.length > 0;
  const termsW = hasTerms ? 280 : 0;
  const bulletsW = contentW - (hasTerms ? termsW + gap * 1.5 : 0);
  const bulletBox = { w: bulletsW, h: bodyH };
  const size = fitFontSize(slots.bullets, bulletBox, theme, theme.typeScale.body + 4);
  const bulletEl: Element = {
    id: newId("el"),
    type: "text",
    role: "body",
    frame: { x: pad, y: bodyTop, w: bulletsW, h: bodyH },
    fit: { mode: "shrinkOnOverflow", minSize: theme.typeScale.minimum },
    vAlign: "top",
    body: slots.bullets.map((b) =>
      para(b, { bullet: { kind: "disc" }, spaceAfterPt: theme.spacing.paragraphAfter + 4, marks: { sizePt: size } }),
    ),
  };
  elements.push(bulletEl);

  const builds: NonNullable<Slide["builds"]> = [];
  if (hasTerms) {
    const termsEl: Element = {
      id: newId("el"),
      type: "text",
      role: "terms",
      frame: { x: CANVAS.width - pad - termsW, y: bodyTop, w: termsW, h: Math.min(bodyH, 60 + slots.terms.length * 44) },
      fit: { mode: "shrinkOnOverflow", minSize: theme.typeScale.minimum },
      fill: "token:surface",
      radius: theme.shape.radius,
      padding: 16,
      body: [
        para("Key terms · 关键术语", { marks: { sizePt: theme.typeScale.small, bold: true, color: "token:secondary" }, spaceAfterPt: 8 }),
        ...slots.terms.map((t) => ({
          id: newId("p"),
          level: 0 as const,
          spaceAfterPt: 6,
          runs: [
            { id: newId("r"), text: t.term, lang: "en" as const, marks: { bold: true, sizePt: theme.typeScale.small + 2 } },
            { id: newId("r"), text: `  ${t.zh}`, lang: "zh" as const, marks: { color: "token:secondary", sizePt: theme.typeScale.small } },
          ],
        })),
      ],
    };
    elements.push(termsEl);
    builds.push({ id: newId("b"), order: 1, elementIds: [termsEl.id], effect: theme.motion.buildEffect });
  }

  return finish(elements, builds);

  function finish(els: Element[], b: NonNullable<Slide["builds"]>): Slide {
    return {
      id: newId("sl"),
      outlineItemId,
      layoutId: slots.layout,
      elements: els,
      ...(b.length ? { builds: b } : {}),
      transition: theme.motion.transition,
      notes: { en: slots.notes.en, zhTerms: slots.notes.zhTerms },
      status: "ready",
      provenance: { aiCallId, specHash },
    };
  }
}
