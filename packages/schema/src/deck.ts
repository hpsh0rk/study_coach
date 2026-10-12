import { z } from "zod";

export const DECK_SCHEMA_VERSION = 2 as const;
export const CANVAS = { width: 960, height: 540 } as const;

export const Id = z.string().min(3).max(64).regex(/^[a-z]{1,6}_[A-Za-z0-9_-]+$/, "typed id, e.g. el_abc123");
export type Id = z.infer<typeof Id>;

export const Color = z.union([
  z.string().regex(/^token:[a-zA-Z][a-zA-Z0-9]*$/),
  z.string().regex(/^#[0-9a-fA-F]{3,8}$/),
]);
export type Color = z.infer<typeof Color>;

export const Frame = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
  rot: z.number().optional(),
});
export type Frame = z.infer<typeof Frame>;

export const RunMarks = z.object({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  color: Color.optional(),
  sizePt: z.number().positive().optional(),
  fontRole: z.enum(["heading", "body", "mono"]).optional(),
  sup: z.boolean().optional(),
  sub: z.boolean().optional(),
  link: z.string().url().optional(),
});
export type RunMarks = z.infer<typeof RunMarks>;

export const Run = z.object({
  id: Id,
  text: z.string(),
  lang: z.enum(["en", "zh", "auto"]).optional(),
  marks: RunMarks.optional(),
  math: z.object({ latex: z.string() }).optional(),
});
export type Run = z.infer<typeof Run>;

export const Paragraph = z.object({
  id: Id,
  level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  align: z.enum(["left", "center", "right"]).optional(),
  bullet: z.object({ kind: z.enum(["none", "disc", "number"]) }).optional(),
  lineHeightPt: z.number().positive().optional(),
  spaceAfterPt: z.number().nonnegative().optional(),
  runs: z.array(Run),
});
export type Paragraph = z.infer<typeof Paragraph>;

export const SourceRef = z.object({
  chapterId: Id,
  page: z.number().int().positive(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});

const elementBase = {
  id: Id,
  frame: Frame,
  role: z.string().optional(),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  groupId: Id.optional(),
  alt: z.string().optional(),
  sourceRefs: z.array(SourceRef).optional(),
  assetRef: z.object({ assetId: Id, assetVersion: z.number().int().nonnegative() }).optional(),
};

export const TextEl = z.object({
  ...elementBase,
  type: z.literal("text"),
  body: z.array(Paragraph),
  fit: z.object({ mode: z.enum(["fixed", "shrinkOnOverflow"]), minSize: z.number().positive() }),
  vAlign: z.enum(["top", "middle", "bottom"]).optional(),
  fill: Color.optional(),
  stroke: z.object({ width: z.number().nonnegative(), color: Color }).optional(),
  radius: z.number().nonnegative().optional(),
  padding: z.number().nonnegative().optional(),
});
export type TextEl = z.infer<typeof TextEl>;

export const ImageEl = z.object({
  ...elementBase,
  type: z.literal("image"),
  assetId: Id,
  crop: z.object({ l: z.number(), t: z.number(), r: z.number(), b: z.number() }).optional(),
  fit: z.enum(["cover", "contain"]),
  radius: z.number().nonnegative().optional(),
  border: z.object({ width: z.number().nonnegative(), color: Color }).optional(),
});
export type ImageEl = z.infer<typeof ImageEl>;

export const TableCell = z.object({
  id: Id,
  colSpan: z.number().int().positive().optional(),
  rowSpan: z.number().int().positive().optional(),
  body: z.array(Paragraph),
  fill: Color.optional(),
});
export const TableRow = z.object({
  id: Id,
  height: z.number().positive(),
  header: z.boolean().optional(),
  cells: z.array(TableCell),
});
export const TableEl = z.object({
  ...elementBase,
  type: z.literal("table"),
  columns: z.array(z.object({ id: Id, width: z.number().positive() })).min(1),
  rows: z.array(TableRow).min(1),
});
export type TableEl = z.infer<typeof TableEl>;

export const FormulaEl = z.object({
  ...elementBase,
  type: z.literal("formula"),
  latex: z.string().min(1),
  display: z.boolean(),
  sizePt: z.number().positive(),
});
export type FormulaEl = z.infer<typeof FormulaEl>;

export const ExperimentEl = z.object({
  ...elementBase,
  type: z.literal("experiment"),
  provider: z.enum(["phet", "ai_sim", "url"]),
  componentId: z.string().min(1),
  params: z.object({
    locale: z.enum(["en", "zh_CN"]),
    initial: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  }),
  fallback: z.object({
    screenshotAssetId: Id.optional(),
    shortCode: z.string().min(4),
    caption: z.object({ en: z.string(), zh: z.string() }),
  }),
  attribution: z.string().optional(),
});
export type ExperimentEl = z.infer<typeof ExperimentEl>;

export const RevealEl = z.object({
  ...elementBase,
  type: z.literal("reveal"),
  trigger: z.object({ kind: z.enum(["click", "hotspot"]), targetId: Id.optional() }),
  revealIds: z.array(Id).min(1),
  label: z.string().optional(),
});
export type RevealEl = z.infer<typeof RevealEl>;

export const ShapeEl = z.object({
  ...elementBase,
  type: z.literal("shape"),
  geometry: z.enum(["rect", "roundRect", "ellipse", "line", "arrow"]),
  fill: Color.optional(),
  stroke: z.object({ width: z.number().nonnegative(), color: Color }).optional(),
  body: z.array(Paragraph).optional(),
});
export type ShapeEl = z.infer<typeof ShapeEl>;

export type GroupEl = {
  id: Id;
  type: "group";
  frame: Frame;
  role?: string;
  locked?: boolean;
  hidden?: boolean;
  groupId?: Id;
  alt?: string;
  children: Element[];
};

export type Element = TextEl | ImageEl | TableEl | FormulaEl | ExperimentEl | RevealEl | ShapeEl | GroupEl;

export const GroupEl: z.ZodType<GroupEl> = z.lazy(() =>
  z.object({
    ...elementBase,
    type: z.literal("group"),
    children: z.array(Element),
  }),
) as z.ZodType<GroupEl>;

export const Element: z.ZodType<Element> = z.lazy(() =>
  z.union([TextEl, ImageEl, TableEl, FormulaEl, ExperimentEl, RevealEl, ShapeEl, GroupEl]),
) as z.ZodType<Element>;

export const Build = z.object({
  id: Id,
  order: z.number().int().positive(),
  elementIds: z.array(Id).min(1),
  effect: z.enum(["appear", "fade", "highlight"]),
});
export type Build = z.infer<typeof Build>;

export const SlideNotes = z.object({
  en: z.array(z.string()),
  zhTerms: z.array(z.object({ term: z.string(), zh: z.string(), note: z.string().optional() })),
});
export type SlideNotes = z.infer<typeof SlideNotes>;

export const Slide = z.object({
  id: Id,
  outlineItemId: Id,
  layoutId: z.string(),
  elements: z.array(Element),
  builds: z.array(Build).optional(),
  transition: z.enum(["none", "fade", "push"]).optional(),
  notes: SlideNotes,
  status: z.enum(["pending", "generating", "ready", "failed"]),
  provenance: z.object({ aiCallId: z.string(), specHash: z.string() }),
});
export type Slide = z.infer<typeof Slide>;

export const Deck = z.object({
  id: Id,
  schemaVersion: z.literal(DECK_SCHEMA_VERSION),
  projectId: Id,
  version: z.number().int().nonnegative(),
  title: z.string().optional(),
  theme: z.object({ themeId: z.string(), themeVersion: z.number().int().nonnegative() }),
  outlineVersionId: Id,
  slides: z.array(Slide),
});
export type Deck = z.infer<typeof Deck>;

export const ElementRef = z.object({
  slideId: Id,
  elementId: Id,
  sub: z.object({ kind: z.enum(["paragraph", "run", "row", "col", "cell"]), id: Id }).optional(),
  textRange: z.object({ runId: Id, start: z.number().int(), end: z.number().int() }).optional(),
});
export type ElementRef = z.infer<typeof ElementRef>;

export function walkElements(elements: Element[], visit: (el: Element) => void): void {
  for (const el of elements) {
    visit(el);
    if (el.type === "group") walkElements(el.children, visit);
  }
}

/** Ids must be unique across the deck so element refs stay unambiguous. */
export function collectDuplicateIds(deck: Deck): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  const add = (id: string) => (seen.has(id) ? dupes.add(id) : seen.add(id));
  for (const slide of deck.slides) {
    add(slide.id);
    walkElements(slide.elements, (el) => {
      add(el.id);
      const paragraphs =
        el.type === "text" ? el.body : el.type === "shape" ? (el.body ?? []) : el.type === "table" ? el.rows.flatMap((r) => r.cells.flatMap((c) => c.body)) : [];
      for (const p of paragraphs) {
        add(p.id);
        for (const r of p.runs) add(r.id);
      }
      if (el.type === "table") {
        for (const c of el.columns) add(c.id);
        for (const r of el.rows) {
          add(r.id);
          for (const c of r.cells) add(c.id);
        }
      }
    });
    for (const b of slide.builds ?? []) add(b.id);
  }
  return [...dupes];
}

/** Builds and reveals may only reference elements on their own slide. */
export function collectDanglingRefs(deck: Deck): string[] {
  const problems: string[] = [];
  for (const slide of deck.slides) {
    const ids = new Set<string>();
    walkElements(slide.elements, (el) => ids.add(el.id));
    for (const b of slide.builds ?? []) for (const id of b.elementIds) if (!ids.has(id)) problems.push(`${slide.id}: build ${b.id} -> ${id}`);
    walkElements(slide.elements, (el) => {
      if (el.type !== "reveal") return;
      for (const id of el.revealIds) if (!ids.has(id)) problems.push(`${slide.id}: reveal ${el.id} -> ${id}`);
      if (el.trigger.targetId && !ids.has(el.trigger.targetId)) problems.push(`${slide.id}: reveal ${el.id} target -> ${el.trigger.targetId}`);
    });
  }
  return problems;
}

export function validateDeck(input: unknown): { ok: true; deck: Deck } | { ok: false; errors: string[] } {
  const parsed = Deck.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const errors = [
    ...collectDuplicateIds(parsed.data).map((id) => `duplicate id: ${id}`),
    ...collectDanglingRefs(parsed.data).map((p) => `dangling ref: ${p}`),
  ];
  return errors.length ? { ok: false, errors } : { ok: true, deck: parsed.data };
}

/** Student share view must never carry teacher notes. */
export function stripNotes(deck: Deck): Deck {
  return { ...deck, slides: deck.slides.map((s) => ({ ...s, notes: { en: [], zhTerms: [] } })) };
}
