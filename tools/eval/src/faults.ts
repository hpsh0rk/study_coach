/**
 * Catch matrix: which deterministic safeguard catches which LLM failure mode, independent of how
 * often the model makes it. Injects each fault into every eligible slide / outline of clean decks
 * and runs every safeguard on the result.
 *
 *   pnpm eval:faults --from results/clean --eval-dir <dir> --out results/faults [--seeds 8] [--no-render]
 *
 * Slides: AI-layer structural schema (→ JSON repair), problemsOf (→ slide check-retry), the number-source
 * check (verifyNumbers → writer retry + 待核实), truncateLists, sanitizeWidgets, experiment sim pinning,
 * browser overflow (eval:render), and the rule scorer (score.ts).
 * Outlines: normalizeOutline (source-page check, check cadence), checkOutline errors (→ outline check-retry) /
 * warnings (UI only), rebalanceMinutes, and the resulting time / check-cadence / source gates.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { checkSourceText, normalizeOutline, problemsOf, rebalanceMinutes, sanitizeWidgets, truncateLists } from "@kj/generation";
import { checkOutline, outlineTiming, PAGE_TYPES, verifyNumbers } from "@kj/pedagogy";
import { LessonParams, SlideContent, type Outline, type PageType } from "@kj/schema";
import { findEmbed } from "@kj/widgets";
import { deckFiles, loadScorer, parseArgs, readJson, writeJson, type ScoreIssue } from "./common.ts";
import { classifyProblem, injectOutline, injectSlide, OUTLINE_FAULTS, rngFor, SLIDE_FAULTS, type OutlineFault, type SlideFault } from "./noisy.ts";

interface DeckSlide {
  id: string;
  specId: string | null;
  pageType: PageType;
  layout: string;
  minutes: number;
  content: SlideContent;
  notes: string;
  sources: number[];
  overflow?: string[];
  failed?: string;
  inject?: { fault: SlideFault; marker?: string; jsonMode?: string; structural: boolean };
}
interface Deck {
  lesson: { scenarioId: string; sourceId: string; minutes: number; level: string; language: string; lessonType: string; pageRanges: [number, number][] };
  outline: Outline | null;
  slides: DeckSlide[];
  meta: Record<string, unknown>;
}

const ROWS_SLIDE = SLIDE_FAULTS.filter((f) => f !== "invalidJson");
type Pages = { no: number; text: string }[];
const pagesOf = (evalDir: string, sourceId: string) => readJson<{ pages: Pages }>(path.join(evalDir, "pdfs", `${sourceId}.pages.json`)).pages;
/** Number / calculation flags of the 待核实 check (what the writer retries on). */
const numberFlags = (s: Pick<DeckSlide, "content" | "notes" | "sources" | "pageType">, pages: Pages) =>
  new Set(
    verifyNumbers(s.content, checkSourceText(s.sources, pages), { pageType: s.pageType, notes: s.notes })
      .filter((u) => u.kind === "number" || u.kind === "calc")
      .map((u) => `${u.kind}:${u.text}`),
  );
const has = (content: SlideContent, pageType: PageType, f: SlideFault) => {
  try {
    return problemsOf(content, pageType).errors.some((e) => classifyProblem(e) === f);
  } catch (e) {
    throw new Error(`${JSON.stringify(content).slice(0, 300)}: ${(e as Error).message}`);
  }
};

function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("no object");
  return JSON.parse(t.slice(a, b + 1));
}

/** Phase 1: decks with one fault type injected into every eligible slide (written for eval:render). */
function writeInjected(from: string, out: string, evalDir: string): string[] {
  const written: string[] = [];
  for (const file of deckFiles(from)) {
    const deck = readJson<Deck>(file);
    const pages = readJson<{ pages: { no: number; text: string }[] }>(path.join(evalDir, "pdfs", `${deck.lesson.sourceId}.pages.json`)).pages;
    const sourceText = (n: number[]) => pages.filter((p) => n.includes(p.no)).map((p) => `[p.${p.no}] ${p.text}`).join("\n");
    for (const fault of ROWS_SLIDE) {
      const copy = structuredClone(deck);
      let any = false;
      copy.slides.forEach((s, i) => {
        if (s.failed) return;
        const rng = rngFor(`faults|${path.basename(file)}|${s.id}|${fault}`);
        const out = { content: structuredClone(s.content), notes: s.notes };
        const inj = injectSlide(out, [fault], rng, { source: sourceText(s.sources), faded: s.pageType === "faded" });
        if (!inj.faults.length) return;
        any = true;
        copy.slides[i] = { ...s, content: out.content, inject: { fault, marker: inj.marker, structural: inj.structural } };
        delete copy.slides[i]!.overflow;
      });
      if (!any) continue;
      const f = path.join(out, `${path.basename(file, ".json")}.${fault}.json`);
      writeJson(f, copy);
      written.push(f);
    }
  }
  return written;
}

interface Tally {
  n: number;
  [k: string]: number;
}
const bump = (t: Tally, k: string, v = 1) => void (t[k] = (t[k] ?? 0) + v);

async function slideMatrix(from: string, injectedFiles: string[], evalDir: string) {
  const scorer = await loadScorer(evalDir);
  const rows: Record<string, Tally> = {};
  const scoreOf = (deck: Deck) => scorer.score(deck);
  const cleanIssues = new Map<string, Set<string>>();
  const cleanNumbers = new Map<string, Set<string>>();
  const falseFlags: Tally = { n: 0 };
  for (const file of deckFiles(from)) {
    const deck = readJson<Deck>(file);
    const pages = pagesOf(evalDir, deck.lesson.sourceId);
    for (const s of deck.slides) {
      if (s.failed) continue;
      const flags = numberFlags(s, pages);
      cleanNumbers.set(`${path.basename(file, ".json")}|${s.id}`, flags);
      falseFlags.n++;
      if (flags.size) bump(falseFlags, "flagged");
    }
    const r = scoreOf(deck);
    for (const i of r.issues) if (i.slideId && i.level !== "I") cleanIssues.set(`${path.basename(file, ".json")}|${i.slideId}`, (cleanIssues.get(`${path.basename(file, ".json")}|${i.slideId}`) ?? new Set()).add(`${i.rule}:${i.msg}`));
  }
  for (const file of injectedFiles) {
    const deck = readJson<Deck>(file);
    const base = path.basename(file).split(".")[0]!;
    const report = scoreOf(deck);
    const pages = pagesOf(evalDir, deck.lesson.sourceId);
    for (const s of deck.slides) {
      if (!s.inject) continue;
      const f = s.inject.fault;
      const row = (rows[f] ??= { n: 0 });
      row.n++;
      const structural = !SlideContent.safeParse(s.content).success;
      if (structural) bump(row, "layerSchema");
      const checked = !structural && has(s.content, s.pageType, f);
      if (checked) bump(row, "problemsOf");
      if (!structural && checked && !has(truncateLists(s.content, s.pageType), s.pageType, f)) bump(row, "truncate");
      if (!structural) {
        const clean = cleanNumbers.get(`${base}|${s.id}`) ?? new Set<string>();
        if ([...numberFlags(s, pages)].some((k) => !clean.has(k))) bump(row, "numberCheck");
      }
      if (!structural && checked && f === "badVisual" && !has(sanitizeWidgets(s.content).content, s.pageType, f)) bump(row, "sanitize");
      if (f === "badVisual" && s.layout === "experiment") {
        const spec = deck.outline?.slides.find((x) => x.id === s.specId);
        if (spec && findEmbed(`${spec.title} ${spec.keyPoints.join(" ")}`)) bump(row, "pinSim");
      }
      if (Array.isArray(s.overflow)) {
        bump(row, "rendered");
        if (s.overflow.length) bump(row, "overflow");
      } else if ((s as { overflowError?: string }).overflowError?.startsWith("render threw")) bump(row, "renderThrows");
      const before = cleanIssues.get(`${base}|${s.id}`) ?? new Set<string>();
      const fresh = report.issues.filter((i: ScoreIssue) => i.slideId === s.id && i.level !== "I" && !before.has(`${i.rule}:${i.msg}`));
      if (fresh.length) bump(row, "scorer");
      for (const rule of new Set(fresh.map((i) => i.rule))) bump(row, `rule:${rule}`);
    }
  }
  // invalidJson: what the AI layer's parser accepts without a repair turn.
  const json: Tally = { n: 0 };
  for (const file of deckFiles(from)) {
    const deck = readJson<Deck>(file);
    for (const s of deck.slides) {
      for (const mode of ["fence", "truncated", "schema"] as const) {
        const text =
          mode === "fence"
            ? `Here is the JSON:\n\`\`\`json\n${JSON.stringify({ content: s.content, notes: s.notes }, null, 2)}\n\`\`\``
            : mode === "truncated"
              ? JSON.stringify({ content: s.content, notes: s.notes }).slice(0, -Math.ceil(JSON.stringify(s.content).length * 0.2))
              : JSON.stringify({ content: { ...s.content, layout: "slide" }, notes: s.notes });
        json.n++;
        bump(json, `mode:${mode}`);
        let ok = false;
        try {
          ok = SlideContent.safeParse((extractJson(text) as { content: unknown }).content).success;
        } catch {}
        if (!ok) {
          bump(json, "layerSchema");
          bump(json, `repair:${mode}`);
        }
      }
    }
  }
  rows.invalidJson = json;
  return { rows, falseFlags };
}

interface DraftSlide {
  pageType: PageType;
  title: string;
  purpose: string;
  keyPoints: string[];
  visual: string;
  minutes: number;
  sourcePages: number[];
  loop: number;
}

function maxLectureRun(o: Outline): number {
  let run = 0;
  let max = 0;
  for (const s of o.slides) {
    const mode = PAGE_TYPES[s.pageType].mode;
    if (mode === "lecture") max = Math.max(max, (run += s.minutes));
    else if (mode === "practice") run = 0;
  }
  return max;
}

function outlineMatrix(from: string, seeds: number, evalDir: string) {
  const rows: Record<string, Tally> = {};
  const clean: Tally = { n: 0 };
  for (const file of deckFiles(from)) {
    const deck = readJson<Deck>(file);
    if (!deck.outline) continue;
    const allPages = pagesOf(evalDir, deck.lesson.sourceId);
    const params = LessonParams.parse({ minutes: deck.lesson.minutes, level: deck.lesson.level, lessonType: deck.lesson.lessonType, language: deck.lesson.language });
    const validPages = [...new Set(deck.lesson.pageRanges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i)))];
    const simAvailable = deck.outline.slides.some((s) => s.pageType === "experiment");
    const pages = allPages.filter((p) => validPages.includes(p.no));
    const original = deck.outline.slides.map((s) => s.sourcePages.join(","));
    {
      const draft = { ...deck.outline, slides: deck.outline.slides.map(({ id: _id, layout: _l, sourceIssue: _s, ...s }) => structuredClone(s) as DraftSlide) };
      const norm = normalizeOutline(draft as never, { validPages, simAvailable, pages });
      const content = norm.slides.filter((s) => s.pageType !== "cover" && !s.id.startsWith("cfu"));
      bump(clean, "slides", content.length);
      bump(clean, "flagged", content.filter((s) => s.sourceIssue).length);
      clean.n++;
    }
    for (const fault of OUTLINE_FAULTS.filter((f) => f !== "invalidJson")) {
      for (let k = 0; k < seeds; k++) {
        const draft = { ...deck.outline, slides: deck.outline.slides.map(({ id: _id, layout: _l, sourceIssue: _s, ...s }) => structuredClone(s) as DraftSlide) };
        const keyed = draft.slides.map((s, i) => ({ ...s, _i: i }));
        draft.slides = keyed;
        const inj = injectOutline(draft as never, [fault as OutlineFault], rngFor(`faults|${path.basename(file)}|${fault}|${k}`));
        if (!inj.faults.length) continue;
        const kept = (draft.slides as (DraftSlide & { _i: number })[]).map((s) => s._i);
        const label = inj.modes[fault as OutlineFault] ? `${fault}/${inj.modes[fault as OutlineFault]}` : fault;
        const row = (rows[label] ??= { n: 0 });
        row.n++;
        const norm = normalizeOutline(draft as never, { validPages, simAvailable, pages });
        if (norm.slides.some((s) => s.id.startsWith("cfu"))) bump(row, "cfuInserted");
        const violations = checkOutline(norm, params);
        const t0 = outlineTiming(norm, params);
        if (Math.abs(t0.deviation) > 0.15) bump(row, "timeOffDraft");
        if (violations.some((v) => v.level === "error")) bump(row, "checkError");
        const warned = violations.filter((v) => v.level === "warning").map((v) => v.code);
        if (fault === "missingCfu" && warned.includes("check-cadence")) bump(row, "checkWarning");
        if (fault === "outlineNoVisual" && norm.slides.every((s) => !["concept", "process", "data"].includes(s.pageType) || s.visual !== "none")) bump(row, "normalize");
        if (fault === "outlineNoVisual" && warned.includes("visual")) bump(row, "checkWarning");
        const final = t0.needsAck ? rebalanceMinutes(norm, params) : norm;
        const t1 = outlineTiming(final, params);
        if (Math.abs(t0.deviation) > 0.15 && Math.abs(t1.deviation) <= 0.15) bump(row, "rebalanceFixes");
        if (Math.abs(t1.deviation) > 0.15) bump(row, "timeOffFinal");
        if (maxLectureRun(final) > 10) bump(row, "cfuGateFail");
        if (fault === "badSourcePages") {
          const content = final.slides.filter((s) => s.pageType !== "cover");
          const empty = content.filter((s) => s.sourcePages.length === 0 && !s.sourceIssue).length;
          const lecture = final.slides.filter((s) => !s.id.startsWith("cfu"));
          const wrong = lecture.filter((s, j) => s.sourcePages.length && s.sourcePages.join(",") !== original[kept[j]!]);
          bump(row, "slides", content.length);
          bump(row, "sourcesDropped", empty);
          bump(row, "sourcesWrongUndetected", wrong.filter((s) => !s.sourceIssue).length);
          bump(row, "sourcesFlagged", final.slides.filter((s) => s.sourceIssue).length);
        }
      }
    }
  }
  return { rows, clean };
}

const pct = (a: number | undefined, n: number) => (n ? `${Math.round((100 * (a ?? 0)) / n)}%` : "–");

function markdown(slide: Record<string, Tally>, outline: Record<string, Tally>, falseFlags: Tally, cleanOutline: Tally): string {
  const s = [
    "| slide fault | n | AI-layer schema → JSON repair | problemsOf → check-retry | 待核实 number check → retry | truncate fixes | sanitize fixes | pinSim | overflow (measured) | renderer throws | scorer flags | scorer rules |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...Object.entries(slide).map(([f, t]) => {
      const rules = Object.keys(t).filter((k) => k.startsWith("rule:")).map((k) => `${k.slice(5)} ${pct(t[k], t.n)}`).join(", ");
      return `| ${f} | ${t.n} | ${pct(t.layerSchema, t.n)} | ${pct(t.problemsOf, t.n)} | ${f === "invalidJson" ? "–" : pct(t.numberCheck, t.n)} | ${pct(t.truncate, t.n)} | ${f === "badVisual" ? pct(t.sanitize, t.n) : "–"} | ${pct(t.pinSim, t.n)} | ${t.rendered ? pct(t.overflow, t.rendered) : "–"} | ${f === "invalidJson" ? "–" : pct(t.renderThrows, t.n)} | ${f === "invalidJson" ? "–" : pct(t.scorer, t.n)} | ${rules} |`;
    }),
  ];
  const o = [
    "| outline fault | n | time off (draft) | checkOutline error → retry | warning only | normalize fixes | CFU inserted | rebalance fixes time | time off (final) | CFU gate fails | sources dropped | sources flagged 待核实 | wrong sources undetected |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...Object.entries(outline)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([f, t]) =>
          `| ${f} | ${t.n} | ${pct(t.timeOffDraft, t.n)} | ${pct(t.checkError, t.n)} | ${pct(t.checkWarning, t.n)} | ${pct(t.normalize, t.n)} | ${pct(t.cfuInserted, t.n)} | ${pct(t.rebalanceFixes, t.n)} | ${pct(t.timeOffFinal, t.n)} | ${pct(t.cfuGateFail, t.n)} | ${t.slides ? pct(t.sourcesDropped, t.slides) : "–"} | ${t.slides ? pct(t.sourcesFlagged, t.slides) : "–"} | ${t.slides ? pct(t.sourcesWrongUndetected, t.slides) : "–"} |`,
      ),
  ];
  const fp = [
    `False flags on clean decks: number check ${pct(falseFlags.flagged, falseFlags.n)} of ${falseFlags.n} slides; source-page check ${pct(cleanOutline.flagged, cleanOutline.slides ?? 0)} of ${cleanOutline.slides ?? 0} outline slides (${cleanOutline.n} outlines).`,
  ];
  return [...s, "", ...o, "", ...fp].join("\n");
}

async function main(argv: string[]) {
  const { opts } = parseArgs(argv);
  const from = opts.from;
  const evalDir = opts["eval-dir"] ?? process.env.KJ_EVAL_DIR;
  if (!from || !evalDir) throw new Error("usage: pnpm eval:faults --from <clean results dir> --eval-dir <dir> [--out results/faults] [--seeds 8] [--no-render]");
  const out = opts.out ?? path.join(path.dirname(from), "faults");
  fs.rmSync(out, { recursive: true, force: true });
  const injected = writeInjected(from, out, evalDir);
  if (!opts["no-render"]) execFileSync("pnpm", ["-s", "eval:render", out, "--no-build"], { stdio: "inherit" });
  const { rows: slide, falseFlags } = await slideMatrix(from, injected, evalDir);
  const { rows: outline, clean } = outlineMatrix(from, Number(opts.seeds ?? 8), evalDir);
  writeJson(path.join(out, "matrix.json"), { slide, outline, falseFlags, cleanOutline: clean });
  const md = markdown(slide, outline, falseFlags, clean);
  fs.writeFileSync(path.join(out, "matrix.md"), md + "\n");
  console.log(md);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
