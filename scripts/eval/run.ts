/**
 * Runs eval scenarios through the planner → writer pipeline and writes one deck JSON per
 * scenario × run, in the format internal/eval/score.ts reads.
 *
 *   pnpm eval:run --eval-dir <dir with manifest.json + pdfs/> [--scenarios S01,S03 | --all]
 *                 [--runs 3] [--variant B0] [--flags writerSource=none,...]
 *                 [--reuse-outlines results/B0] [--out results/B0] [--concurrency 4]
 *
 * Provider: KJ_EVAL_API_KEY (+ KJ_EVAL_PROVIDER deepseek|glm|custom, KJ_EVAL_MODEL, KJ_EVAL_BASE_URL),
 * or DEEPSEEK_API_KEY / GLM_API_KEY. Without a key every call uses the deterministic stubs.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createAiLayer, PROVIDER_PRESETS, type AiCallRecord, type AiConfig, type ProviderKind } from "@kj/ai";
import { pagesInRanges, textForRanges } from "@kj/pdf-structure";
import { draftOutline, stubOutline, type DraftInput, type PlannerSection } from "@kj/planner";
import { LessonParams, type AblationFlags, type ConfirmedOutline, type Outline, type PageRange, type PageText, type SlideSpec } from "@kj/schema";
import { layoutForPageType } from "@kj/templates";
import { PROMPT_VERSION as WRITER_PROMPT, stubSlide, writeDeckDirect, writeSlide, DIRECT_PROMPT_VERSION } from "@kj/writer";
import { PROMPT_VERSION as PLANNER_PROMPT } from "@kj/planner";
import { parseArgs, parseFlags, readJson, writeJson } from "./common.ts";

interface ManifestSection {
  title: string;
  pdfPages: [number, number];
}
interface ManifestItem {
  id: string;
  file: string;
  title: string;
  pageCount: number;
  chapters: { title: string; pdfPages: [number, number]; sections: ManifestSection[] }[];
}
interface Scenario {
  id: string;
  core: boolean;
  itemId: string;
  sections: string[];
  pageRanges: [number, number][];
  params: { minutes: number; level: string; lessonType: string; language: string };
  goal?: string;
}
interface Manifest {
  items: ManifestItem[];
  scenarios: Scenario[];
}

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): { config: AiConfig; label: string } | null {
  let kind = env.KJ_EVAL_PROVIDER as ProviderKind | undefined;
  let apiKey = env.KJ_EVAL_API_KEY;
  if (!apiKey && env.DEEPSEEK_API_KEY) (apiKey = env.DEEPSEEK_API_KEY), (kind ??= "deepseek");
  if (!apiKey && (env.GLM_API_KEY || env.ZHIPU_API_KEY)) (apiKey = env.GLM_API_KEY || env.ZHIPU_API_KEY), (kind ??= "glm");
  if (!apiKey) return null;
  kind ??= "deepseek";
  const preset = PROVIDER_PRESETS[kind];
  const baseUrl = env.KJ_EVAL_BASE_URL || preset.baseUrl;
  const model = env.KJ_EVAL_MODEL || preset.models[0];
  if (!baseUrl || !model) throw new Error(`provider "${kind}" needs KJ_EVAL_BASE_URL and KJ_EVAL_MODEL`);
  return {
    label: `${kind}/${model}`,
    config: {
      providers: [{ id: "eval", kind, name: preset.label, baseUrl, apiKey, enabled: true }],
      routes: { default: { primary: { providerId: "eval", model } } },
    },
  };
}

function resolveEvalDir(opt: string | undefined): string {
  const dir = opt ?? process.env.KJ_EVAL_DIR ?? "eval";
  if (!fs.existsSync(path.join(dir, "manifest.json"))) throw new Error(`no manifest.json in ${path.resolve(dir)}; pass --eval-dir or set KJ_EVAL_DIR`);
  return dir;
}

function sectionsFor(item: ManifestItem, ids: string[] | "all"): PlannerSection[] {
  const all = item.chapters.flatMap((c) => c.sections);
  const picked = ids === "all" ? all : all.filter((s) => ids.some((id) => s.title.startsWith(`${id} `)));
  return picked.map((s) => ({ title: s.title, pageStart: s.pdfPages[0], pageEnd: s.pdfPages[1] }));
}

async function pool<T>(items: T[], limit: number, fn: (t: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]!, i);
      }
    }),
  );
}

interface RunOptions {
  manifest: Manifest;
  evalDir: string;
  scenario: Scenario;
  run: number;
  variant: string;
  flags: AblationFlags;
  reuseDir?: string;
  concurrency: number;
  provider: ReturnType<typeof providerFromEnv>;
}

export async function runScenario(o: RunOptions) {
  const { scenario, flags } = o;
  const item = o.manifest.items.find((i) => i.id === scenario.itemId);
  if (!item) throw new Error(`${scenario.id}: unknown item ${scenario.itemId}`);
  const allPages = readJson<{ pages: PageText[] }>(path.join(o.evalDir, "pdfs", `${item.id}.pages.json`)).pages;

  const whole = flags.scope === "wholeDocument";
  const tuples: [number, number][] = whole ? [[1, item.pageCount]] : scenario.pageRanges;
  const ranges: PageRange[] = tuples.map(([start, end]) => ({ start, end }));
  const inScope = new Set(pagesInRanges(ranges));
  const pages = allPages.filter((p) => inScope.has(p.no));
  const sections = sectionsFor(item, whole ? "all" : scenario.sections);
  const params = LessonParams.parse({ ...scenario.params, focus: (scenario.goal ?? "").slice(0, 200) });
  const lessonTitle = `${item.title.replace(/^OpenStax [^,]+, /, "")} — ${sections.map((s) => s.title).join("; ")}`.slice(0, 200);
  const ctx = { orgId: "eval", userId: "eval", lessonId: `${scenario.id}-r${o.run}` };

  const calls: AiCallRecord[] = [];
  const ai = createAiLayer({
    config: { load: async () => o.provider?.config ?? { providers: [], routes: {} } },
    meter: { record: async (r) => void calls.push(r) },
    allowStubFallback: true,
  });

  const draftInput: DraftInput = { lessonTitle, params, sections, pages, sourceText: textForRanges(allPages, ranges), ctx, flags };
  const started = Date.now();
  let outline: Outline | null = null;
  let slides: Record<string, unknown>[];
  const warnings: string[] = [];

  if (flags.renderMode !== "templates") throw new Error(`renderMode=${flags.renderMode} is not implemented in this pipeline`);
  if (!flags.autoConfirm) throw new Error("autoConfirm=false (A9) needs a teacher in the loop; run it through the web app");

  if (flags.outline === "skip") {
    const res = await writeDeckDirect(ai, { lessonTitle, params, sourceText: draftInput.sourceText, validPages: pages.map((p) => p.no), ctx, flags }, () => {
      const plan = stubOutline(draftInput);
      return {
        objectives: plan.objectives,
        slides: plan.slides.map((s, i) => {
          const spec = { ...s, id: `sp${i + 1}`, layout: layoutForPageType(s.pageType) } as SlideSpec;
          const own = pages.filter((p) => s.sourcePages.includes(p.no));
          const written = stubSlide({ spec, outline: { objectives: plan.objectives, slides: [] }, lessonTitle, pages: own.length ? own : pages });
          return { pageType: s.pageType, minutes: s.minutes, sourcePages: s.sourcePages, content: written.content, notes: written.notes };
        }),
      };
    });
    slides = res.slides.map((s, i) => ({ id: `s${i + 1}`, specId: null, layout: s.content.layout, pageType: s.pageType, minutes: s.minutes, content: s.content, notes: s.notes, sources: s.sources, warnings: s.warnings }));
  } else {
    if (o.reuseDir) {
      const prev = readJson<{ outline?: Outline }>(path.join(o.reuseDir, `${scenario.id}-r${o.run}.json`));
      if (!prev.outline) throw new Error(`${o.reuseDir}: ${scenario.id}-r${o.run}.json has no outline to reuse`);
      outline = prev.outline;
    } else {
      const drafted = await draftOutline(ai, draftInput);
      outline = drafted.outline;
      warnings.push(...drafted.warnings.map((w) => `${w.code}: ${w.message}`));
    }
    const confirmed = { versionId: `${ctx.lessonId}-v1`, lessonId: ctx.lessonId, outline, confirmedAt: Date.now() } as ConfirmedOutline;
    const specs = outline.slides;
    slides = new Array(specs.length);
    await pool(specs, o.concurrency, async (spec, i) => {
      const w = await writeSlide(ai, confirmed, spec.id, { lessonTitle, params, pages, ctx, flags });
      slides[i] = { id: `s${i + 1}`, specId: spec.id, layout: spec.layout, pageType: spec.pageType, minutes: spec.minutes, content: w.content, notes: w.notes, sources: w.sources, warnings: w.warnings };
    });
  }

  const ok = calls.filter((c) => c.status === "ok");
  return {
    lesson: { scenarioId: scenario.id, sourceId: item.id, title: lessonTitle, pageRanges: tuples, minutes: params.minutes, level: params.level, lessonType: params.lessonType, language: params.language },
    meta: {
      variant: o.variant,
      flags,
      run: o.run,
      model: o.provider?.label ?? "stub",
      stub: ok.every((c) => c.providerId === "stub"),
      promptVersions: { planner: PLANNER_PROMPT, writer: WRITER_PROMPT, direct: DIRECT_PROMPT_VERSION },
      reusedOutlineFrom: o.reuseDir ?? null,
      tokensIn: calls.reduce((n, c) => n + c.inputTokens, 0),
      tokensOut: calls.reduce((n, c) => n + c.outputTokens, 0),
      calls: calls.length,
      failedCalls: calls.length - ok.length,
      latencyMs: Date.now() - started,
      createdAt: new Date().toISOString(),
      warnings,
    },
    outline,
    slides,
  };
}

async function main(argv: string[]) {
  const { opts } = parseArgs(argv);
  const evalDir = resolveEvalDir(opts["eval-dir"]);
  const manifest = readJson<Manifest>(path.join(evalDir, "manifest.json"));
  const ids = opts.all ? manifest.scenarios.map((s) => s.id) : opts.scenarios ? opts.scenarios.split(",").map((s) => s.trim()) : manifest.scenarios.filter((s) => s.core).map((s) => s.id);
  const scenarios = ids.map((id) => {
    const s = manifest.scenarios.find((x) => x.id === id);
    if (!s) throw new Error(`unknown scenario ${id}`);
    return s;
  });
  const runs = Number(opts.runs ?? 1);
  const variant = opts.variant ?? "B0";
  const flags = parseFlags(opts.flags);
  const out = opts.out ?? path.join("results", variant);
  const provider = providerFromEnv();
  const concurrency = Number(opts.concurrency ?? (provider ? 4 : 1));

  console.log(`eval:run variant=${variant} provider=${provider?.label ?? "stub (no KJ_EVAL_API_KEY / DEEPSEEK_API_KEY / GLM_API_KEY)"} scenarios=${ids.join(",")} runs=${runs} → ${out}`);
  console.log(`flags=${JSON.stringify(flags)}`);
  let failed = 0;
  for (const scenario of scenarios) {
    for (let run = 1; run <= runs; run++) {
      const file = path.join(out, `${scenario.id}-r${run}.json`);
      try {
        const deck = await runScenario({ manifest, evalDir, scenario, run, variant, flags, reuseDir: opts["reuse-outlines"], concurrency, provider });
        writeJson(file, deck);
        const minutes = (deck.slides as { minutes: number }[]).reduce((n, s) => n + s.minutes, 0);
        console.log(`  ${scenario.id} r${run}: ${deck.slides.length} slides, ${minutes} min, ${deck.meta.calls} calls, ${deck.meta.tokensIn + deck.meta.tokensOut} tokens, ${deck.meta.latencyMs} ms`);
      } catch (err) {
        failed++;
        console.error(`  ${scenario.id} r${run}: FAILED ${(err as Error).message}`);
      }
    }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
