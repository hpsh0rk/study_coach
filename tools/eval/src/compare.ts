/**
 * Scores result directories with score.ts and compares each with a baseline: per-variant means and
 * paired differences (variant − base, matched by scenario × run) with a stratified bootstrap 95% CI.
 *
 *   pnpm eval:compare --eval-dir <dir> --base results/N0 results/A4 results/A4b ... [--out results/compare]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { PageType, SlideContent } from "@kj/schema";
import { deckFiles, loadScorer, parseArgs, readJson, writeJson, type Scorer } from "./common.ts";
import { rngFor, SLIDE_FAULTS, slideDefects } from "./noisy.ts";

interface Slide {
  pageType: PageType;
  content: SlideContent;
  overflow?: string[];
  overflowError?: string;
  failed?: string;
  noise?: { injected: string[]; marker?: string; attempts: number };
}
interface Deck {
  lesson: { scenarioId: string };
  slides: Slide[];
  meta: { calls: number; tokensIn: number; tokensOut: number; httpRequests?: number; failedSlides?: number; variant?: string; byCapability?: Record<string, { calls: number; tokens: number }> };
}

export type Row = Record<string, number>;

/** Per-deck numbers every comparison uses. Rates are per slide unless named per deck. */
export function deckRow(deck: Deck, scorer: Scorer): Row {
  const r = scorer.score(deck);
  const m = r.metrics as Record<string, number>;
  const n = deck.slides.length;
  const defects: Record<string, number> = Object.fromEntries(SLIDE_FAULTS.map((f) => [f, 0]));
  let anyDefect = 0;
  for (const s of deck.slides) {
    const d = s.failed ? [] : slideDefects(s.content, s.pageType, s.noise?.marker);
    for (const f of d) defects[f]!++;
    if (d.length || s.failed) anyDefect++;
  }
  const measured = deck.slides.filter((s) => Array.isArray(s.overflow));
  return {
    gatePass: r.gatesPassed ? 1 : 0,
    gateTime: r.gates.time ? 1 : 0,
    gateCfu: r.gates.cfu ? 1 : 0,
    gateSource: r.gates.sourceCoverage ? 1 : 0,
    ruleScore: r.ruleScore,
    overflowMeasured: measured.length ? measured.filter((s) => s.overflow!.length).length / measured.length : NaN,
    renderErrors: deck.slides.filter((s) => s.overflowError).length,
    densityOk: m.M2_densityOkRate!,
    timeDev: m.M4_timeDeviation!,
    maxLectureRun: m.maxLectureRunMinutes!,
    sourceCoverage: m.sourceCoverage!,
    numericGrounding: m.M5_numericGrounding ?? NaN,
    defectSlideRate: anyDefect / n,
    ...Object.fromEntries(Object.entries(defects).map(([f, k]) => [`defect.${f}`, k / n])),
    failedSlides: deck.slides.filter((s) => s.failed).length,
    calls: deck.meta.calls,
    requests: deck.meta.httpRequests ?? deck.meta.calls,
    tokens: deck.meta.tokensIn + deck.meta.tokensOut,
    outlineCalls: deck.meta.byCapability?.["outline.draft"]?.calls ?? NaN,
    writerCalls: deck.meta.byCapability?.["slide.write"]?.calls ?? NaN,
    writerTokens: deck.meta.byCapability?.["slide.write"]?.tokens ?? NaN,
  };
}

const mean = (xs: number[]) => {
  const ys = xs.filter((x) => Number.isFinite(x));
  return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : NaN;
};

/** Paired bootstrap over decks, resampling within each scenario. */
export function pairedCi(pairs: { stratum: string; d: number }[], iters = 10_000, seed = "ci"): [number, number] {
  const groups = new Map<string, number[]>();
  for (const p of pairs) if (Number.isFinite(p.d)) groups.set(p.stratum, [...(groups.get(p.stratum) ?? []), p.d]);
  const gs = [...groups.values()];
  if (!gs.length) return [NaN, NaN];
  const rng = rngFor(seed);
  const total = gs.reduce((n, g) => n + g.length, 0);
  const stats: number[] = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    for (const g of gs) for (let k = 0; k < g.length; k++) sum += g[Math.floor(rng() * g.length)]!;
    stats.push(sum / total);
  }
  stats.sort((a, b) => a - b);
  return [stats[Math.floor(iters * 0.025)]!, stats[Math.floor(iters * 0.975)]!];
}

const SHOW: [string, string, (x: number) => string][] = [
  ["gatePass", "gates pass", (x) => `${Math.round(x * 100)}%`],
  ["gateTime", "time gate", (x) => `${Math.round(x * 100)}%`],
  ["gateCfu", "CFU gate", (x) => `${Math.round(x * 100)}%`],
  ["overflowMeasured", "overflow (measured)", (x) => `${(x * 100).toFixed(1)}%`],
  ["densityOk", "M2 density ok", (x) => `${Math.round(x * 100)}%`],
  ["timeDev", "M4 |time dev|", (x) => `${(x * 100).toFixed(1)}%`],
  ["numericGrounding", "M5 numbers", (x) => `${Math.round(x * 100)}%`],
  ["defectSlideRate", "slides w/ defect", (x) => `${(x * 100).toFixed(1)}%`],
  ["outlineCalls", "outline calls/deck", (x) => x.toFixed(2)],
  ["writerCalls", "writer calls/deck", (x) => x.toFixed(1)],
  ["requests", "HTTP requests/deck", (x) => x.toFixed(1)],
  ["writerTokens", "writer tokens/deck", (x) => `${(x / 1000).toFixed(1)}k`],
];

export async function compare(dirs: string[], base: string, evalDir: string) {
  const scorer = await loadScorer(evalDir);
  const load = (dir: string) => new Map(deckFiles(dir).map((f) => [path.basename(f), deckRow(readJson<Deck>(f), scorer)] as const));
  const baseRows = load(base);
  const out: { variant: string; n: number; mean: Row; diff: Record<string, { d: number; ci: [number, number] }> }[] = [];
  for (const dir of [base, ...dirs.filter((d) => d !== base)]) {
    const rows = dir === base ? baseRows : load(dir);
    const keys = Object.keys([...rows.values()][0] ?? {});
    const m: Row = Object.fromEntries(keys.map((k) => [k, mean([...rows.values()].map((r) => r[k]!))]));
    const diff: Record<string, { d: number; ci: [number, number] }> = {};
    if (dir !== base) {
      for (const k of keys) {
        const pairs = [...rows.entries()].filter(([f]) => baseRows.has(f)).map(([f, r]) => ({ stratum: f.split("-")[0]!, d: r[k]! - baseRows.get(f)![k]! }));
        diff[k] = { d: mean(pairs.map((p) => p.d)), ci: pairedCi(pairs) };
      }
    }
    out.push({ variant: path.basename(dir), n: rows.size, mean: m, diff });
  }
  return out;
}

export function markdown(res: Awaited<ReturnType<typeof compare>>): string {
  const head = `| variant | n | ${SHOW.map(([, l]) => l).join(" | ")} |`;
  const lines = [head, `|${"---|".repeat(SHOW.length + 2)}`];
  for (const r of res) lines.push(`| ${r.variant} | ${r.n} | ${SHOW.map(([k, , f]) => (Number.isFinite(r.mean[k]!) ? f(r.mean[k]!) : "–")).join(" | ")} |`);
  lines.push("", `| variant − ${res[0]?.variant} | ${SHOW.map(([, l]) => l).join(" | ")} |`, `|${"---|".repeat(SHOW.length + 1)}`);
  const pp = (k: string, x: number) => (["outlineCalls", "writerCalls", "requests"].includes(k) ? x.toFixed(2) : k === "writerTokens" ? `${(x / 1000).toFixed(1)}k` : `${(x * 100).toFixed(1)}`);
  for (const r of res.slice(1)) {
    lines.push(
      `| ${r.variant} | ${SHOW.map(([k]) => {
        const d = r.diff[k];
        return d && Number.isFinite(d.d) ? `${d.d >= 0 ? "+" : ""}${pp(k, d.d)} [${pp(k, d.ci[0])}, ${pp(k, d.ci[1])}]` : "–";
      }).join(" | ")} |`,
    );
  }
  lines.push("", "Differences: percentage points for rates (calls, requests and tokens in their own units), 95% CI from a paired bootstrap stratified by scenario. Variants run with --reuse-outlines make no outline call; HTTP requests include JSON-repair turns and outline calls.");
  const defectHead = `| variant | ${SLIDE_FAULTS.map((f) => f).join(" | ")} | failed slides/deck | render errors/deck |`;
  lines.push("", "Defects left in finished slides (per 100 slides):", "", defectHead, `|${"---|".repeat(SLIDE_FAULTS.length + 3)}`);
  for (const r of res) lines.push(`| ${r.variant} | ${SLIDE_FAULTS.map((f) => (r.mean[`defect.${f}`]! * 100).toFixed(1)).join(" | ")} | ${r.mean.failedSlides!.toFixed(2)} | ${r.mean.renderErrors!.toFixed(2)} |`);
  return lines.join("\n");
}

async function main(argv: string[]) {
  const { positional, opts } = parseArgs(argv);
  const evalDir = opts["eval-dir"] ?? process.env.KJ_EVAL_DIR;
  if (!evalDir || !opts.base) throw new Error("usage: pnpm eval:compare --eval-dir <dir> --base <results dir> <results dir>... [--out dir]");
  const res = await compare(positional, opts.base, evalDir);
  const md = markdown(res);
  if (opts.out) {
    fs.mkdirSync(opts.out, { recursive: true });
    writeJson(path.join(opts.out, "compare.json"), res);
    fs.writeFileSync(path.join(opts.out, "compare.md"), md + "\n");
  }
  console.log(md);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
