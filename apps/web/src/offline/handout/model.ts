import { LESSON_TYPE_LABEL, LEVEL_LABEL } from "@kj/pedagogy";
import { texToText } from "@kj/pptx";
import type {
  ChartSpec,
  GlossaryEntry,
  LessonParams,
  LessonType,
  Level,
  Outline,
  PageRange,
  Slide,
  SlideSpec,
  TableSpec,
  TeachingLanguage,
  VisualSpec,
} from "@kj/schema";
import { shuffledOrder, sourceRuns } from "@kj/templates/render";

export type HandoutCopy = "student" | "teacher";

export type HandoutRun =
  | { kind: "text"; text: string; bold?: boolean; highlight?: boolean }
  | { kind: "math"; tex: string; display?: boolean; bold?: boolean; highlight?: boolean }
  | { kind: "blank" };

export interface HandoutLessonMeta {
  title: string;
  grade?: string;
  subject?: string;
  duration?: string;
  minutes?: number;
  level?: Level;
  lessonType?: LessonType;
  language?: TeachingLanguage;
  params?: Partial<LessonParams>;
  pageRanges?: ([number, number] | PageRange)[];
  pageLabels?: Record<number, string>;
}

export interface HandoutMediaItem {
  dataUrl: string;
  pngBytes?: Uint8Array;
  width: number;
  height: number;
}

export interface HandoutInput {
  lesson: HandoutLessonMeta;
  outline: Outline;
  slides: Slide[];
  copy: HandoutCopy;
  media?: Record<string, HandoutMediaItem>;
}

export interface HandoutFigure {
  assetId: string;
  caption?: HandoutRun[];
  alt: string;
  dataUrl?: string;
  pngBytes?: Uint8Array;
  width: number;
  height: number;
}

export interface HandoutTable {
  caption?: HandoutRun[];
  headers: HandoutRun[][];
  rows: HandoutRun[][][];
}

export interface HandoutFormula {
  tex: string;
  caption?: HandoutRun[];
}

export interface HandoutNoteBlock {
  slideId: string;
  title: HandoutRun[];
  titleText: string;
  sourcesLabel: string;
  bullets: HandoutRun[][];
  tables: HandoutTable[];
  formulas: HandoutFormula[];
  flows: HandoutRun[][][];
  figures: HandoutFigure[];
}

export interface HandoutLoopGroup {
  loop: number;
  heading: string;
  blocks: HandoutNoteBlock[];
  /** Populated in `teacher` copy only; always `[]` in `student` copy. */
  misconceptions: HandoutRun[][];
}

export interface HandoutExampleStep {
  index: number;
  runs: HandoutRun[];
  why?: HandoutRun[];
  hiddenInStudent: boolean;
}

export interface HandoutExample {
  slideId: string;
  kind: "worked" | "faded";
  title: HandoutRun[];
  sourcesLabel: string;
  problem: HandoutRun[];
  steps: HandoutExampleStep[];
  workspaceLines: number;
}

export interface HandoutOption {
  letter: string;
  runs: HandoutRun[];
  isCorrect?: boolean;
}

export interface HandoutMatchRow {
  number: number;
  left: HandoutRun[];
  rightLetter: string;
  rightShuffled: HandoutRun[];
}

export interface HandoutQuestion {
  number: number;
  kind: "mcq" | "short" | "match" | "order";
  sourceTag: string;
  marks?: string;
  prompt: HandoutRun[];
  options?: HandoutOption[];
  matchPairs?: HandoutMatchRow[];
  matchRightOrder?: number[];
  orderCards?: HandoutOption[];
  ruledLines: number;
  /** Present in `teacher` copy only. */
  teacherAnswer?: HandoutRun[];
}

export interface HandoutAnswerEntry {
  heading: string;
  answer?: HandoutRun[];
  rationale?: HandoutRun[];
  misconceptions: HandoutRun[][];
  notes?: HandoutRun[];
}

export interface HandoutDoc {
  copy: HandoutCopy;
  language: TeachingLanguage;
  header: {
    title: string;
    titleRuns: HandoutRun[];
    grade: string;
    subject: string;
    duration: string;
    sourcesLabel: string;
    copyBadge: string;
    objectives: HandoutRun[][];
    glossary: GlossaryEntry[];
  };
  guidedNotes: HandoutLoopGroup[];
  examples: HandoutExample[];
  practices: HandoutQuestion[];
  /** `null` when `copy === "student"`; non-null array when `copy === "teacher"`. */
  answerKey: HandoutAnswerEntry[] | null;
}

const LETTERS = "ABCDEFGH";
const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff]/;

function findClosingSingleDollar(src: string, start: number): number {
  for (let j = start; j < src.length; j++) {
    if (src[j] === "\n") return -1;
    if (src[j] === "\\" && j + 1 < src.length) {
      j++;
      continue;
    }
    if (src[j] === "$") return j;
  }
  return -1;
}

function findClosingDelimiter(src: string, start: number, delim: "==" | "**" | "$$"): number {
  for (let j = start; j <= src.length - delim.length; j++) {
    if (delim !== "$$") {
      if (src.startsWith("$$", j)) {
        const endBlock = src.indexOf("$$", j + 2);
        if (endBlock > j + 2) {
          j = endBlock + 1;
          continue;
        }
      } else if (src[j] === "$") {
        const endInline = findClosingSingleDollar(src, j + 1);
        if (endInline > j + 1) {
          j = endInline;
          continue;
        }
      }
    }
    if (src.startsWith(delim, j)) return j;
  }
  return -1;
}

interface ParseInlineOptions {
  copy: HandoutCopy;
  blankHighlights?: boolean;
  forceHighlight?: boolean;
  glossaryTerms?: string[];
}

/**
 * Deterministically parses `$...$`, `$$...$$`, `==...==`, and `**...**` into typed runs while
 * stripping all raw markdown/math delimiters cleanly (even unmatched stray `**`, `==`, or `$`).
 */
export function parseInlineRuns(raw: string, opts: ParseInlineOptions): HandoutRun[] {
  let hadExplicitHighlight = false;

  const scan = (src: string, style: { bold?: boolean; highlight?: boolean }): HandoutRun[] => {
    const out: HandoutRun[] = [];
    let buf = "";
    const flush = () => {
      if (!buf) return;
      out.push({
        kind: "text",
        text: buf,
        ...(style.bold ? { bold: true } : {}),
        ...(style.highlight ? { highlight: true } : {}),
      });
      buf = "";
    };

    let i = 0;
    while (i < src.length) {
      if (src.startsWith("\\$", i)) {
        i += 2;
        continue;
      }
      if (src.startsWith("$$", i)) {
        const end = findClosingDelimiter(src, i + 2, "$$");
        if (end > i + 2) {
          flush();
          const tex = src.slice(i + 2, end).replace(/\$/g, "").trim();
          if (tex) {
            out.push({
              kind: "math",
              tex,
              display: true,
              ...(style.bold ? { bold: true } : {}),
              ...(style.highlight ? { highlight: true } : {}),
            });
          }
          i = end + 2;
          continue;
        }
        i += 2;
        continue;
      }
      if (src[i] === "$") {
        const end = findClosingSingleDollar(src, i + 1);
        if (end > i + 1) {
          flush();
          const tex = src.slice(i + 1, end).replace(/\\\$/g, "").replace(/\$/g, "").trim();
          if (tex) {
            out.push({
              kind: "math",
              tex,
              display: false,
              ...(style.bold ? { bold: true } : {}),
              ...(style.highlight ? { highlight: true } : {}),
            });
          }
          i = end + 1;
          continue;
        }
        i++;
        continue;
      }
      if (src.startsWith("==", i)) {
        const end = findClosingDelimiter(src, i + 2, "==");
        if (end > i + 2) {
          flush();
          hadExplicitHighlight = true;
          const inner = src.slice(i + 2, end);
          if (opts.blankHighlights && opts.copy === "student") {
            out.push({ kind: "blank" });
          } else if (opts.copy === "teacher") {
            out.push(...scan(inner, { bold: true, highlight: true }));
          } else {
            out.push(...scan(inner, { ...style, bold: true }));
          }
          i = end + 2;
          continue;
        }
        i += 2;
        continue;
      }
      if (src.startsWith("**", i)) {
        const end = findClosingDelimiter(src, i + 2, "**");
        if (end > i + 2) {
          flush();
          out.push(...scan(src.slice(i + 2, end), { ...style, bold: true }));
          i = end + 2;
          continue;
        }
        i += 2;
        continue;
      }
      buf += src[i]!;
      i++;
    }
    flush();
    return out;
  };

  const baseStyle = opts.forceHighlight ? { bold: true, highlight: true } : {};
  const runs = scan(raw, baseStyle);

  if (opts.blankHighlights && !hadExplicitHighlight && opts.glossaryTerms?.length) {
    return applyGlossaryFallback(runs, opts.glossaryTerms, opts.copy);
  }
  return runs;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyGlossaryFallback(runs: HandoutRun[], terms: string[], copy: HandoutCopy): HandoutRun[] {
  const candidates = [...new Set(terms.map((t) => t.trim()).filter((t) => (CJK_RE.test(t) ? t.length >= 2 : t.length >= 3)))].sort(
    (a, b) => b.length - a.length,
  );
  if (!candidates.length) return runs;

  const patterns = candidates.map((term) => {
    const escaped = escapeRegex(term);
    const leftBound = /^[A-Za-z0-9]/.test(term) ? "(?<![A-Za-z0-9])" : "";
    const rightBound = /[A-Za-z0-9]$/.test(term) ? "(?![A-Za-z0-9])" : "";
    return `${leftBound}${escaped}${rightBound}`;
  });
  const regex = new RegExp(`(${patterns.join("|")})`, "i");

  let matchedOnce = false;
  const out: HandoutRun[] = [];
  for (const run of runs) {
    if (matchedOnce || run.kind !== "text") {
      out.push(run);
      continue;
    }
    const m = regex.exec(run.text);
    if (!m || m.index === undefined) {
      out.push(run);
      continue;
    }
    matchedOnce = true;
    const before = run.text.slice(0, m.index);
    const hit = m[0];
    const after = run.text.slice(m.index + hit.length);
    if (before) out.push({ ...run, text: before });
    if (copy === "student") {
      out.push({ kind: "blank" });
    } else {
      out.push({ kind: "text", text: hit, bold: true, highlight: true });
    }
    if (after) out.push({ ...run, text: after });
  }
  return out;
}

export function runsToPlainText(runs: HandoutRun[]): string {
  return runs
    .map((r) => {
      if (r.kind === "text") return r.text;
      if (r.kind === "blank") return "____________";
      return texToText(r.tex).text.replace(/\$/g, "");
    })
    .join("");
}

function formatSources(pages: number[], pageLabels?: Record<number, string>): string {
  if (!pages.length) return "";
  const label = (p: number) => pageLabels?.[p] ?? String(p);
  return sourceRuns(pages)
    .map(([start, end]) => (end > start ? `p.${label(start)}–${label(end)}` : `p.${label(start)}`))
    .join(", ");
}

function formatPageRanges(ranges: ([number, number] | PageRange)[] | undefined, pageLabels?: Record<number, string>): string {
  if (!ranges?.length) return "";
  const label = (p: number) => pageLabels?.[p] ?? String(p);
  return ranges
    .map((r) => {
      const [start, end] = Array.isArray(r) ? r : [r.start, r.end];
      return end > start ? `p.${label(start)}–${label(end)}` : `p.${label(start)}`;
    })
    .join(", ");
}

function tableFromSpec(spec: TableSpec, copy: HandoutCopy): HandoutTable {
  return {
    ...(spec.caption ? { caption: parseInlineRuns(spec.caption, { copy }) } : {}),
    headers: spec.columns.map((col) => parseInlineRuns(col, { copy })),
    rows: spec.rows.map((row) => row.map((cell) => parseInlineRuns(cell, { copy, blankHighlights: true }))),
  };
}

function tableFromChart(spec: ChartSpec, copy: HandoutCopy, source = ""): HandoutTable {
  const xHead = spec.xLabel || "Category 类别";
  const headers: HandoutRun[][] = [
    parseInlineRuns(xHead, { copy }),
    ...spec.series.map((s) => parseInlineRuns(s.name || spec.yLabel || "Value", { copy })),
  ];
  const rowCount = spec.categories?.length ?? Math.max(0, ...spec.series.map((s) => s.data.length));
  const rows: HandoutRun[][][] = [];
  for (let i = 0; i < rowCount; i++) {
    const firstPoint = spec.series[0]?.data[i];
    const xCell = spec.categories?.[i] ?? (Array.isArray(firstPoint) ? String(firstPoint[0]) : String(i + 1));
    const valueCells = spec.series.map((s) => {
      const pt = s.data[i];
      const val = Array.isArray(pt) ? String(pt[1]) : pt !== undefined ? String(pt) : "—";
      return [{ kind: "text" as const, text: val }];
    });
    rows.push([parseInlineRuns(xCell, { copy }), ...valueCells]);
  }
  const captionParts = [
    spec.yLabel && spec.xLabel ? `${runsToPlainText(parseInlineRuns(spec.yLabel, { copy }))} — ${runsToPlainText(parseInlineRuns(spec.xLabel, { copy }))}` : "",
    source,
  ].filter(Boolean);
  return {
    ...(captionParts.length ? { caption: parseInlineRuns(captionParts.join(" · "), { copy }) } : {}),
    headers,
    rows,
  };
}

function extractVisualIntoBlock(
  visual: VisualSpec,
  copy: HandoutCopy,
  block: HandoutNoteBlock,
  media?: Record<string, HandoutMediaItem>,
): void {
  switch (visual.kind) {
    case "table":
      block.tables.push(tableFromSpec(visual, copy));
      break;
    case "chart":
      block.tables.push(tableFromChart(visual, copy));
      break;
    case "formula":
      block.formulas.push({
        tex: visual.tex.replace(/\$/g, "").trim(),
        ...(visual.caption ? { caption: parseInlineRuns(visual.caption, { copy }) } : {}),
      });
      break;
    case "flow":
      block.flows.push(visual.steps.map((step) => parseInlineRuns(step, { copy, blankHighlights: true })));
      break;
    case "function":
      block.bullets.push(
        parseInlineRuns(
          `函数模型 Function: ${visual.yLabel || "y"} = ${visual.expr} (${visual.xLabel || "x"}: ${visual.x[0]}–${visual.x[1]})`,
          { copy },
        ),
      );
      break;
    case "figure": {
      const resolved = media?.[visual.assetId];
      const capRuns = visual.caption ? parseInlineRuns(visual.caption, { copy }) : undefined;
      const altText =
        (visual.alt ? runsToPlainText(parseInlineRuns(visual.alt, { copy: "student" })) : "") ||
        (capRuns ? runsToPlainText(capRuns) : "") ||
        "Textbook figure";
      block.figures.push({
        assetId: visual.assetId,
        ...(capRuns ? { caption: capRuns } : {}),
        alt: altText,
        ...(resolved?.dataUrl ? { dataUrl: resolved.dataUrl } : {}),
        ...(resolved?.pngBytes ? { pngBytes: resolved.pngBytes } : {}),
        width: resolved?.width && resolved.width > 0 ? resolved.width : 640,
        height: resolved?.height && resolved.height > 0 ? resolved.height : 400,
      });
      break;
    }
    case "placeholder":
      break;
  }
}

function extractMarkBadge(raw: string): { marks?: string; numericMarks: number } {
  const m = /\[(\d+)(?:\s*(?:marks?|分))?\]/i.exec(raw);
  if (!m) return { numericMarks: 1 };
  return { marks: `[${m[1]}]`, numericMarks: Math.max(1, Number(m[1])) };
}

function collectGlossaryTerms(outline: Outline, slides: Slide[]): string[] {
  const terms: string[] = [];
  for (const g of outline.glossary) {
    if (g.term) terms.push(g.term);
    if (g.zh) terms.push(g.zh);
  }
  for (const s of slides) {
    if (s.content.layout === "statement") {
      for (const t of s.content.terms) {
        if (t.term) terms.push(t.term);
        if (t.zh) terms.push(t.zh);
      }
    }
  }
  return terms;
}

function collectHeaderGlossary(outline: Outline, slides: Slide[]): GlossaryEntry[] {
  if (outline.glossary.length > 0) {
    return outline.glossary.map((g) => ({
      term: runsToPlainText(parseInlineRuns(g.term, { copy: "student" })),
      zh: runsToPlainText(parseInlineRuns(g.zh, { copy: "student" })),
    }));
  }
  const seen = new Set<string>();
  const derived: GlossaryEntry[] = [];
  for (const s of slides) {
    if (s.content.layout !== "statement") continue;
    for (const t of s.content.terms) {
      if (!t.term || !t.zh) continue;
      const key = t.term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      derived.push({
        term: runsToPlainText(parseInlineRuns(t.term, { copy: "student" })),
        zh: runsToPlainText(parseInlineRuns(t.zh, { copy: "student" })),
      });
    }
  }
  return derived;
}

function orderedSlides(outline: Outline, slides: Slide[]): { slide: Slide; spec?: SlideSpec }[] {
  const bySpec = new Map<string, Slide>();
  for (const s of slides) bySpec.set(s.specId, s);
  const used = new Set<string>();
  const out: { slide: Slide; spec?: SlideSpec }[] = [];
  for (const spec of outline.slides) {
    const match = bySpec.get(spec.id);
    if (match) {
      used.add(match.id);
      out.push({ slide: match, spec });
    }
  }
  for (const s of slides) {
    if (!used.has(s.id)) out.push({ slide: s });
  }
  return out;
}

const TEACHING_PAGE_TYPES = new Set<string>(["concept", "process", "data", "experiment", "summary", "compare", "misconception"]);

function isTeachingSlide(slide: Slide): boolean {
  if (slide.pageType === "cover" || slide.content.layout === "title") return false;
  if (TEACHING_PAGE_TYPES.has(slide.pageType)) return true;
  return ["statement", "chart", "experiment", "summary"].includes(slide.content.layout);
}

/**
 * Deterministic single-source-of-truth compiler from `{ lesson, outline, slides, copy }` to `HandoutDoc`
 * with zero extra LLM calls, guaranteeing exact numeric, formula, and past-paper alignment with the slide deck.
 */
export function buildHandoutDoc(input: HandoutInput): HandoutDoc {
  const { lesson, outline, slides, copy, media } = input;
  const minutes = lesson.minutes ?? lesson.params?.minutes ?? 45;
  const level = lesson.level ?? lesson.params?.level ?? "intermediate";
  const lessonType = lesson.lessonType ?? lesson.params?.lessonType ?? "new";
  const language = lesson.language ?? lesson.params?.language ?? "en+zh";
  const pageLabels = lesson.pageLabels;

  const titleRuns = parseInlineRuns(lesson.title, { copy: "student" });
  const cleanTitle = runsToPlainText(titleRuns) || "课程讲义 Handout";
  const allCitedPages = slides.flatMap((s) => s.sources);
  const sourcesLabel = formatPageRanges(lesson.pageRanges, pageLabels) || formatSources(allCitedPages, pageLabels);

  const rawObjectives =
    outline.objectives.length > 0
      ? outline.objectives
      : (slides.find((s) => s.content.layout === "title")?.content as { objectives?: string[] } | undefined)?.objectives ?? [];
  const objectives = rawObjectives.map((obj) => parseInlineRuns(obj, { copy: "student" }));

  const headerGlossary = collectHeaderGlossary(outline, slides);
  const glossaryTerms = collectGlossaryTerms(outline, slides);
  const aligned = orderedSlides(outline, slides);

  // Collect loop-level misconceptions from quiz distractors for Teacher Guided Notes
  const loopMisconceptions = new Map<number, HandoutRun[][]>();
  if (copy === "teacher") {
    for (const { slide, spec } of aligned) {
      const loop = spec?.loop ?? 0;
      if (slide.content.layout === "quiz") {
        for (const [idx, opt] of slide.content.options.entries()) {
          if (idx !== slide.content.answer && opt.misconception.trim()) {
            const list = loopMisconceptions.get(loop) ?? [];
            const letter = LETTERS[idx] ?? String(idx + 1);
            list.push(parseInlineRuns(`易错辨析 Misconception（选项 ${letter}）：${opt.misconception}`, { copy: "teacher" }));
            loopMisconceptions.set(loop, list);
          }
        }
      }
    }
  }

  const loopGroups = new Map<number, HandoutLoopGroup>();
  const getLoopGroup = (loop: number, fallbackHeading: string): HandoutLoopGroup => {
    const existing = loopGroups.get(loop);
    if (existing) return existing;
    const created: HandoutLoopGroup = {
      loop,
      heading: loop > 0 ? `学习环 ${loop} · Learning Loop ${loop}` : fallbackHeading,
      blocks: [],
      misconceptions: copy === "teacher" ? (loopMisconceptions.get(loop) ?? []) : [],
    };
    loopGroups.set(loop, created);
    return created;
  };

  const examples: HandoutExample[] = [];
  const practices: HandoutQuestion[] = [];
  const answerKey: HandoutAnswerEntry[] = [];

  for (const { slide, spec } of aligned) {
    const c = slide.content;
    const srcLabel = formatSources(slide.sources, pageLabels);
    const notesRuns = copy === "teacher" && slide.notes.trim() ? parseInlineRuns(slide.notes.trim(), { copy: "teacher" }) : undefined;

    if (c.layout === "title") {
      if (copy === "teacher" && notesRuns) {
        answerKey.push({
          heading: `开场导引 · ${runsToPlainText(parseInlineRuns(c.title, { copy: "teacher" }))}`,
          misconceptions: [],
          notes: notesRuns,
        });
      }
      continue;
    }

    // Section 2: Guided Notes
    if (isTeachingSlide(slide)) {
      const loopKey = slide.pageType === "summary" && (spec?.loop ?? 0) === 0 ? 999 : (spec?.loop ?? 0);
      const group = getLoopGroup(
        loopKey,
        slide.pageType === "summary" ? "课堂小结 · Lesson Summary" : "核心导学 · Core Concepts",
      );
      const slideTerms =
        c.layout === "statement" ? [...c.terms.flatMap((t) => [t.term, t.zh]).filter(Boolean), ...glossaryTerms] : glossaryTerms;
      const rawBlockTitle = "title" in c ? c.title : c.question;
      const titleParsed = parseInlineRuns(rawBlockTitle, { copy });
      const block: HandoutNoteBlock = {
        slideId: slide.id,
        title: titleParsed,
        titleText: runsToPlainText(titleParsed),
        sourcesLabel: srcLabel,
        bullets: [],
        tables: [],
        formulas: [],
        flows: [],
        figures: [],
      };

      if (c.layout === "statement") {
        block.bullets = c.bullets.map((b) => parseInlineRuns(b, { copy, blankHighlights: true, glossaryTerms: slideTerms }));
        extractVisualIntoBlock(c.visual, copy, block, media);
      } else if (c.layout === "chart") {
        block.bullets = c.takeaways.map((t) => parseInlineRuns(t, { copy, blankHighlights: true, glossaryTerms: slideTerms }));
        if (c.chart.kind === "table") {
          block.tables.push(tableFromSpec(c.chart, copy));
        } else if (c.chart.kind === "chart") {
          block.tables.push(tableFromChart(c.chart, copy, c.source));
        } else if (c.chart.kind === "function" || c.chart.kind === "figure") {
          extractVisualIntoBlock(c.chart, copy, block, media);
        }
      } else if (c.layout === "summary") {
        block.bullets = c.nodes.map((node) => {
          const combined = node.detail ? `**${node.head}**：${node.detail}` : `**${node.head}**`;
          return parseInlineRuns(combined, { copy, blankHighlights: true, glossaryTerms: slideTerms });
        });
      } else if (c.layout === "experiment") {
        const optsText = c.predict.options.map((o, idx) => `${LETTERS[idx] ?? idx + 1}. ${o}`).join("   ");
        block.bullets.push(parseInlineRuns(`**① 预测 Predict**：${c.predict.question}（${optsText}）`, { copy }));
        for (const obs of c.observe) {
          block.bullets.push(parseInlineRuns(`**② 观察 Observe**：${obs}`, { copy }));
        }
        if (copy === "student") {
          block.bullets.push([
            { kind: "text", text: "③ 解释 Explain：", bold: true },
            { kind: "blank" },
            { kind: "text", text: " " },
            { kind: "blank" },
          ]);
        } else {
          const outcomeTag =
            c.outcome !== undefined && c.predict.options[c.outcome]
              ? `（验证结果 Outcome: ${LETTERS[c.outcome]}. ${c.predict.options[c.outcome]}） `
              : "";
          block.bullets.push([
            { kind: "text", text: "③ 解释 Explain：", bold: true },
            ...parseInlineRuns(`${outcomeTag}${c.explain}`, { copy: "teacher", forceHighlight: true }),
          ]);
        }
        if (c.sim.kind === "function") extractVisualIntoBlock(c.sim, copy, block);
      }

      group.blocks.push(block);

      if (copy === "teacher" && (notesRuns || c.layout === "experiment")) {
        answerKey.push({
          heading: `导学讲评 · ${block.titleText}`,
          ...(c.layout === "experiment"
            ? {
                answer: parseInlineRuns(
                  c.outcome !== undefined && c.predict.options[c.outcome]
                    ? `${LETTERS[c.outcome]}. ${c.predict.options[c.outcome]}`
                    : c.explain,
                  { copy: "teacher", forceHighlight: true },
                ),
                rationale: parseInlineRuns(c.explain, { copy: "teacher" }),
              }
            : {}),
          misconceptions: [],
          ...(notesRuns ? { notes: notesRuns } : {}),
        });
      }
      continue;
    }

    // Section 3: Worked & Faded Examples
    if (c.layout === "steps") {
      const isFaded = slide.pageType === "faded" || c.fadeFrom !== undefined;
      const fadeFrom = c.fadeFrom !== undefined ? c.fadeFrom : isFaded ? Math.max(0, c.steps.length - 1) : c.steps.length;
      const exTitle = parseInlineRuns(c.title, { copy });
      const steps: HandoutExampleStep[] = c.steps.map((st, idx) => {
        const hidden = idx >= fadeFrom;
        if (hidden && copy === "student") {
          return { index: idx + 1, runs: [], hiddenInStudent: true };
        }
        return {
          index: idx + 1,
          runs: parseInlineRuns(st.text, { copy, forceHighlight: hidden && copy === "teacher" }),
          ...(st.why.trim() ? { why: parseInlineRuns(st.why, { copy }) } : {}),
          hiddenInStudent: hidden,
        };
      });
      const hiddenCount = c.steps.filter((_, idx) => idx >= fadeFrom).length;
      examples.push({
        slideId: slide.id,
        kind: isFaded ? "faded" : "worked",
        title: exTitle,
        sourcesLabel: srcLabel,
        problem: parseInlineRuns(c.problem, { copy }),
        steps,
        workspaceLines: isFaded ? Math.max(3, hiddenCount * 2) : 2,
      });

      if (copy === "teacher") {
        const solSummary = c.steps
          .map((st, idx) => `(${idx + 1}) ${st.text}${st.why ? ` [${st.why}]` : ""}`)
          .join("；");
        answerKey.push({
          heading: `${isFaded ? "渐隐例题答案" : "例题示范讲评"} · ${runsToPlainText(exTitle)}`,
          answer: parseInlineRuns(solSummary, { copy: "teacher", forceHighlight: isFaded }),
          misconceptions: [],
          ...(notesRuns ? { notes: notesRuns } : {}),
        });
      }
      continue;
    }

    // Section 4: Check & Exam-Style Practice (`quiz`, `questions`, `order`)
    const tagMap: Record<string, string> = {
      retrieval: "课前回顾 Retrieval",
      check: "随堂检测 Check",
      practice: "配套真题 Practice",
      sequence: "配对排序 Sequence",
      exit: "出门测 Exit Ticket",
    };
    const sourceTag = [tagMap[slide.pageType] ?? "练习 Practice", srcLabel].filter(Boolean).join(" · ");

    if (c.layout === "quiz") {
      const qNo = practices.length + 1;
      const { marks } = extractMarkBadge(c.question);
      const correctOpt = c.answer >= 0 ? c.options[c.answer] : undefined;
      const correctLetter = c.answer >= 0 ? (LETTERS[c.answer] ?? String(c.answer + 1)) : "";
      const teacherAnsRuns =
        copy === "teacher" && correctOpt
          ? parseInlineRuns(`${correctLetter}. ${correctOpt.text}`, { copy: "teacher", forceHighlight: true })
          : undefined;

      practices.push({
        number: qNo,
        kind: "mcq",
        sourceTag,
        ...(marks ? { marks } : {}),
        prompt: parseInlineRuns(c.question, { copy }),
        options: c.options.map((o, idx) => ({
          letter: LETTERS[idx] ?? String(idx + 1),
          runs: parseInlineRuns(o.text, { copy, forceHighlight: copy === "teacher" && idx === c.answer }),
          ...(copy === "teacher" && idx === c.answer ? { isCorrect: true } : {}),
        })),
        ruledLines: 1,
        ...(teacherAnsRuns ? { teacherAnswer: teacherAnsRuns } : {}),
      });

      if (copy === "teacher") {
        const misc = c.options
          .map((o, idx) => ({ o, idx }))
          .filter(({ o, idx }) => idx !== c.answer && o.misconception.trim())
          .map(({ o, idx }) => parseInlineRuns(`误选 ${LETTERS[idx] ?? idx + 1}：${o.misconception}`, { copy: "teacher" }));
        answerKey.push({
          heading: `第 ${qNo} 题（${sourceTag}）`,
          ...(teacherAnsRuns ? { answer: teacherAnsRuns } : {}),
          ...(c.explain.trim() ? { rationale: parseInlineRuns(c.explain, { copy: "teacher" }) } : {}),
          misconceptions: misc,
          ...(notesRuns ? { notes: notesRuns } : {}),
        });
      }
    } else if (c.layout === "questions") {
      c.items.forEach((item, idx) => {
        const qNo = practices.length + 1;
        const { marks, numericMarks } = extractMarkBadge(item.q);
        const ansRuns = copy === "teacher" && item.a.trim() ? parseInlineRuns(item.a, { copy: "teacher", forceHighlight: true }) : undefined;
        practices.push({
          number: qNo,
          kind: "short",
          sourceTag,
          ...(marks ? { marks } : {}),
          prompt: parseInlineRuns(item.q, { copy }),
          ruledLines: Math.min(5, Math.max(2, numericMarks + 1)),
          ...(ansRuns ? { teacherAnswer: ansRuns } : {}),
        });
        if (copy === "teacher") {
          answerKey.push({
            heading: `第 ${qNo} 题（${sourceTag}）`,
            ...(ansRuns ? { answer: ansRuns } : {}),
            misconceptions: [],
            ...(idx === 0 && notesRuns ? { notes: notesRuns } : {}),
          });
        }
      });
    } else if (c.layout === "order") {
      const qNo = practices.length + 1;
      const perm = shuffledOrder(c.items.map((it) => `${it.text}|${it.match}`));
      if (c.mode === "match") {
        const pairs: HandoutMatchRow[] = c.items.map((it, rowIdx) => {
          const shuffledKey = perm[rowIdx] ?? rowIdx;
          return {
            number: rowIdx + 1,
            left: parseInlineRuns(it.text, { copy }),
            rightLetter: LETTERS[rowIdx] ?? String(rowIdx + 1),
            rightShuffled: parseInlineRuns(c.items[shuffledKey]?.match ?? "", { copy }),
          };
        });
        const keyStr = c.items
          .map((_, idx) => {
            const colPos = perm.indexOf(idx);
            return `${idx + 1} — ${LETTERS[colPos >= 0 ? colPos : idx]}`;
          })
          .join("，");
        const ansRuns = copy === "teacher" ? parseInlineRuns(keyStr, { copy: "teacher", forceHighlight: true }) : undefined;
        practices.push({
          number: qNo,
          kind: "match",
          sourceTag,
          prompt: parseInlineRuns(c.title, { copy }),
          matchPairs: pairs,
          matchRightOrder: perm,
          ruledLines: 1,
          ...(ansRuns ? { teacherAnswer: ansRuns } : {}),
        });
        if (copy === "teacher") {
          answerKey.push({
            heading: `第 ${qNo} 题 · 配对（${sourceTag}）`,
            ...(ansRuns ? { answer: ansRuns } : {}),
            misconceptions: [],
            ...(notesRuns ? { notes: notesRuns } : {}),
          });
        }
      } else {
        const orderCards: HandoutOption[] = perm.map((origIdx, dispIdx) => ({
          letter: LETTERS[dispIdx] ?? String(dispIdx + 1),
          runs: parseInlineRuns(c.items[origIdx]?.text ?? "", { copy }),
        }));
        const keyStr = c.items
          .map((_, origIdx) => {
            const dispIdx = perm.indexOf(origIdx);
            return LETTERS[dispIdx >= 0 ? dispIdx : origIdx] ?? String(origIdx + 1);
          })
          .join(" → ");
        const ansRuns = copy === "teacher" ? parseInlineRuns(keyStr, { copy: "teacher", forceHighlight: true }) : undefined;
        practices.push({
          number: qNo,
          kind: "order",
          sourceTag,
          prompt: parseInlineRuns(c.title, { copy }),
          orderCards,
          ruledLines: 1,
          ...(ansRuns ? { teacherAnswer: ansRuns } : {}),
        });
        if (copy === "teacher") {
          answerKey.push({
            heading: `第 ${qNo} 题 · 排序（${sourceTag}）`,
            ...(ansRuns ? { answer: ansRuns } : {}),
            misconceptions: [],
            ...(notesRuns ? { notes: notesRuns } : {}),
          });
        }
      }
    }
  }

  // Ensure any orphan loop misconceptions without teaching blocks still appear in Guided Notes if needed
  if (copy === "teacher") {
    for (const [loop, miscs] of loopMisconceptions.entries()) {
      if (!loopGroups.has(loop) && miscs.length > 0) {
        loopGroups.set(loop, {
          loop,
          heading: loop > 0 ? `学习环 ${loop} · Learning Loop ${loop}` : "核心导学 · Core Concepts",
          blocks: [],
          misconceptions: miscs,
        });
      }
    }
  }

  const sortedGuidedNotes = [...loopGroups.values()].sort((a, b) => a.loop - b.loop);

  return {
    copy,
    language,
    header: {
      title: cleanTitle,
      titleRuns,
      grade: lesson.grade?.trim() || LEVEL_LABEL[level],
      subject: lesson.subject?.trim() || LESSON_TYPE_LABEL[lessonType],
      duration: lesson.duration?.trim() || `${minutes} 分钟 · ${minutes} min`,
      sourcesLabel,
      copyBadge: copy === "student" ? "学生版 · Student Worksheet" : "教师答案版 · Teacher Answer Key",
      objectives,
      glossary: headerGlossary,
    },
    guidedNotes: sortedGuidedNotes,
    examples,
    practices,
    answerKey: copy === "teacher" ? answerKey : null,
  };
}
