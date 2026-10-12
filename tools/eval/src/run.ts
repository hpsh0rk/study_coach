/**
 * Runs eval scenarios through the outline → slide generation pipeline and writes one deck JSON per
 * scenario × run, in the format internal/eval/score.ts reads.
 *
 *   pnpm eval:run --eval-dir <dir with manifest.json + pdfs/> [--scenarios S01,S03 | --all]
 *                 [--runs 3] [--variant B0] [--flags writerSource=none,...]
 *                 [--reuse-outlines results/B0] [--out results/B0] [--concurrency 4]
 *                 [--noise realistic|heavy|none[,overBudget=0.3,fixRate=0.7,...]] [--seed kj]
 *
 * Provider: KJ_EVAL_API_KEY (+ KJ_EVAL_PROVIDER deepseek|glm|custom, KJ_EVAL_MODEL, KJ_EVAL_BASE_URL),
 * or DEEPSEEK_API_KEY / GLM_API_KEY. Without a key every call uses the deterministic stubs.
 * --noise replaces the provider with the fault-injecting stub (noisy.ts), even when a key is set.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createAiLayer, PROVIDER_PRESETS, type AiCallRecord, type AiConfig, type ProviderKind } from "@kj/ai";
import { draftOutline, OUTLINE_PROMPT_VERSION, OUTLINE_SOURCE_CHARS, SLIDE_PROMPT_VERSION, sourcePagesFor, stubOutline, stubSlide, workedSpecFor, writeSlide, type DraftInput, type PlannerSection } from "@kj/generation";
import { pagesInRanges, sourceForRanges } from "@kj/pdf-structure";
import { LessonParams, Outline, type PageRange, type PageText, type SlideSpec } from "@kj/schema";
import { layoutForPageType } from "@kj/templates";
import { parseArgs, readJson, writeJson } from "./common.ts";
import { DIRECT_PROMPT_VERSION, writeDeckDirect } from "./direct.ts";
import { parseFlags, pipelineOptions, type AblationFlags } from "./flags.ts";
import { createNoisyAi, parseNoise, withSpec, type NoiseConfig } from "./noisy.ts";

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
  if (!apiKey && env.DEEPSEEK_API_KEY) {
    apiKey = env.DEEPSEEK_API_KEY;
    kind ??= "deepseek";
  }
  if (!apiKey && (env.GLM_API_KEY || env.ZHIPU_API_KEY)) {
    apiKey = env.GLM_API_KEY || env.ZHIPU_API_KEY;
    kind ??= "glm";
  }
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
  /** Fault-injecting stub instead of the provider (see noisy.ts). */
  noise?: NoiseConfig;
  seed?: string;
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
  const meter = { record: async (r: AiCallRecord) => void calls.push(r) };
  const noisy = o.noise ? createNoisyAi(o.noise, `${scenario.id}-r${o.run}`, meter, o.seed) : null;
  const ai =
    noisy?.ai ??
    createAiLayer({
      config: { load: async () => o.provider?.config ?? { providers: [], routes: {} } },
      meter,
      allowStubFallback: true,
    });

  const options = pipelineOptions(flags);
  const draftInput: DraftInput = { lessonTitle, params, sections, pages, ctx, options };
  const started = Date.now();
  let outline: Outline | null = null;
  let slides: Record<string, unknown>[];
  const warnings: string[] = [];

  if (flags.renderMode !== "templates") throw new Error(`renderMode=${flags.renderMode} is not implemented in this pipeline`);
  if (!flags.autoConfirm) throw new Error("autoConfirm=false (A9) needs a teacher in the loop; run it through the web app");

  if (flags.outline === "skip") {
    const sourceText = sourceForRanges(allPages, ranges, OUTLINE_SOURCE_CHARS).text;
    const res = await writeDeckDirect(ai, { lessonTitle, params, sourceText, validPages: pages.map((p) => p.no), ctx, options }, () => {
      const plan = stubOutline(draftInput);
      return {
        objectives: plan.objectives,
        slides: plan.slides.map((s, i) => {
          const spec = { ...s, id: `sp${i + 1}`, layout: layoutForPageType(s.pageType) } as SlideSpec;
          const own = pages.filter((p) => s.sourcePages.includes(p.no));
          const written = stubSlide({ spec, outline: { objectives: plan.objectives, slides: [], glossary: plan.glossary, notCovered: [] }, lessonTitle, pages: own });
          return { pageType: s.pageType, minutes: s.minutes, sourcePages: s.sourcePages, content: written.content, notes: written.notes };
        }),
      };
    });
    slides = res.slides.map((s, i) => ({ id: `s${i + 1}`, specId: null, layout: s.content.layout, pageType: s.pageType, minutes: s.minutes, content: s.content, notes: s.notes, sources: s.sources, warnings: s.warnings }));
  } else {
    if (o.reuseDir) {
      const prev = readJson<{ outline?: Outline }>(path.join(o.reuseDir, `${scenario.id}-r${o.run}.json`));
      if (!prev.outline) throw new Error(`${o.reuseDir}: ${scenario.id}-r${o.run}.json has no outline to reuse`);
      outline = Outline.parse(prev.outline);
    } else {
      // An outline call that fails JSON repair is regenerated, as a teacher would click again.
      let drafted: Awaited<ReturnType<typeof draftOutline>> | undefined;
      for (let attempt = 0; !drafted; attempt++) {
        try {
          drafted = await draftOutline(ai, draftInput);
        } catch (err) {
          if (!noisy || attempt >= 2) throw err;
          warnings.push(`outline regenerated: ${(err as Error).message.slice(0, 120)}`);
        }
      }
      outline = drafted.outline;
      warnings.push(...drafted.warnings.map((w) => `${w.code}: ${w.message}`));
    }
    const confirmed = outline;
    const specs = outline.slides;
    slides = new Array(specs.length);
    const problems = new Map<string, string>();
    const write = async (spec: SlideSpec) => {
      const i = specs.indexOf(spec);
      const worked = workedSpecFor(confirmed, spec.id);
      const input = { lessonTitle, params, pages, ctx, options, workedProblem: worked ? problems.get(worked) : undefined };
      const base = { id: `s${i + 1}`, specId: spec.id, layout: spec.layout, pageType: spec.pageType, minutes: spec.minutes };
      try {
        const w = await withSpec(spec.id, () => writeSlide(ai, confirmed, spec.id, input));
        if (w.content.layout === "steps" && spec.pageType === "worked") problems.set(spec.id, w.content.problem);
        slides[i] = { ...base, content: w.content, notes: w.notes, sources: w.sources, warnings: w.warnings };
      } catch (err) {
        // The web app leaves such a slide in an error state for the teacher to regenerate; keep the
        // deck scorable with the clean stub and flag it.
        const stub = stubSlide({ spec, outline: confirmed, lessonTitle, pages: sourcePagesFor(spec, input) });
        slides[i] = { ...base, content: stub.content, notes: stub.notes, sources: spec.sourcePages, warnings: [], failed: (err as Error).message.slice(0, 200) };
      }
      if (noisy) {
        const first = noisy.log.find((e) => e.spec === spec.id && e.attempt === 0 && e.turn === "first");
        const marker = noisy.log.filter((e) => e.spec === spec.id && e.marker).pop()?.marker;
        slides[i]!.noise = { injected: first?.faults ?? [], marker, attempts: new Set(noisy.log.filter((e) => e.spec === spec.id).map((e) => e.attempt)).size };
      }
    };
    // Worked examples first, so faded/practice pages can mirror them (as in the web app's generate-all).
    await pool(specs.filter((s) => s.pageType === "worked"), o.concurrency, write);
    await pool(specs.filter((s) => s.pageType !== "worked"), o.concurrency, write);
  }

  const ok = calls.filter((c) => c.status === "ok");
  return {
    lesson: { scenarioId: scenario.id, sourceId: item.id, title: lessonTitle, pageRanges: tuples, minutes: params.minutes, level: params.level, lessonType: params.lessonType, language: params.language },
    meta: {
      variant: o.variant,
      flags,
      run: o.run,
      model: noisy ? `noisy-stub:${o.noise!.profile}` : (o.provider?.label ?? "stub"),
      stub: !!noisy || ok.every((c) => c.providerId === "stub"),
      ...(noisy
        ? {
            noise: { ...o.noise, seed: o.seed },
            httpRequests: noisy.requests(),
            failedSlides: (slides as { failed?: string }[]).filter((s) => s.failed).length,
            outlineFaults: noisy.log.filter((e) => e.spec === "outline"),
          }
        : {}),
      promptVersions: { planner: OUTLINE_PROMPT_VERSION, writer: SLIDE_PROMPT_VERSION, direct: DIRECT_PROMPT_VERSION },
      reusedOutlineFrom: o.reuseDir ?? null,
      tokensIn: calls.reduce((n, c) => n + c.inputTokens, 0),
      tokensOut: calls.reduce((n, c) => n + c.outputTokens, 0),
      calls: calls.length,
      failedCalls: calls.length - ok.length,
      byCapability: Object.fromEntries(
        [...new Set(calls.map((c) => c.capability))].map((cap) => {
          const cs = calls.filter((c) => c.capability === cap);
          return [cap, { calls: cs.length, tokens: cs.reduce((n, c) => n + c.inputTokens + c.outputTokens, 0) }];
        }),
      ),
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
  const noise = opts.noise ? parseNoise(opts.noise) : undefined;
  const seed = opts.seed ?? "kj";
  const provider = noise ? null : providerFromEnv();
  const concurrency = Number(opts.concurrency ?? (provider ? 4 : 1));
  const label = noise ? `noisy-stub (${noise.profile}, seed ${seed})` : (provider?.label ?? "stub (no KJ_EVAL_API_KEY / DEEPSEEK_API_KEY / GLM_API_KEY)");

  console.log(`eval:run variant=${variant} provider=${label} scenarios=${ids.join(",")} runs=${runs} → ${out}`);
  console.log(`flags=${JSON.stringify(flags)}`);
  let failed = 0;
  for (const scenario of scenarios) {
    for (let run = 1; run <= runs; run++) {
      const file = path.join(out, `${scenario.id}-r${run}.json`);
      try {
        const deck = await runScenario({ manifest, evalDir, scenario, run, variant, flags, reuseDir: opts["reuse-outlines"], concurrency, provider, noise, seed });
        writeJson(file, deck);
        const minutes = (deck.slides as { minutes: number }[]).reduce((n, s) => n + s.minutes, 0);
        console.log(`  ${scenario.id} r${run}: ${deck.slides.length} slides, ${minutes} min, ${deck.meta.calls} calls, ${deck.meta.tokensIn + deck.meta.tokensOut} tokens, ${deck.meta.latencyMs} ms${noise ? `, ${deck.meta.failedSlides} failed slides` : ""}`);
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
