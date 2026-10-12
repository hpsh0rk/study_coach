import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export function parseArgs(argv: string[]): { positional: string[]; opts: Record<string, string> } {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
    if (inline !== undefined) opts[k] = inline;
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) opts[k] = argv[++i]!;
    else opts[k] = "true";
  }
  return { positional, opts };
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export interface ScoreIssue {
  rule: string;
  level: "W" | "E" | "I";
  slideId?: string;
  msg: string;
}
export interface ScoreReport {
  ruleScore: number;
  gatesPassed: boolean;
  gates: Record<string, boolean>;
  metrics: Record<string, unknown>;
  issues: ScoreIssue[];
}
export interface Scorer {
  score(deck: unknown): ScoreReport;
}

/** The standalone rule scorer (score.ts + rubric.json + pdfs/ in the eval dir), loaded at runtime. */
export async function loadScorer(evalDir: string): Promise<Scorer> {
  const mod = (await import(pathToFileURL(path.resolve(evalDir, "score.ts")).href)) as {
    scoreDeck: (deck: unknown, rubric: unknown, pages?: unknown, minutes?: number, expect?: unknown) => ScoreReport;
  };
  const rubric = readJson(path.join(evalDir, "rubric.json"));
  const scenarios = readJson<{ scenarios: { id: string; expect?: unknown }[] }>(path.join(evalDir, "manifest.json")).scenarios;
  const pages = new Map<string, unknown>();
  return {
    score(deck) {
      const lesson = (deck as { lesson?: { sourceId?: string; scenarioId?: string } }).lesson ?? {};
      const p = lesson.sourceId ? path.join(evalDir, "pdfs", `${lesson.sourceId}.pages.json`) : "";
      if (p && !pages.has(p)) pages.set(p, fs.existsSync(p) ? readJson(p) : undefined);
      return mod.scoreDeck(deck, rubric, p ? pages.get(p) : undefined, undefined, scenarios.find((s) => s.id === lesson.scenarioId)?.expect);
    },
  };
}

/** Deck files in a results directory (one per scenario × run). */
export function deckFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^S\d+.*\.json$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}
