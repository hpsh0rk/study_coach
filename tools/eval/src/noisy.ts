/**
 * "Noisy stub" provider for ablations without a real model: answers every call with the pipeline's
 * own deterministic stub output, then injects realistic LLM failure modes at configurable rates.
 * It sits behind the real AI layer (as its fetch), so JSON repair, slide/outline check-retry,
 * truncation, normalisation and rebalancing all run exactly as in production.
 *
 * Faults are seeded by (seed, scenario, run, spec id, attempt), not by the prompt text, so variants
 * that only change what happens after the first call see identical first answers (paired runs).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createAiLayer, type AiConfig, type AiLayer, type ChatMessage, type Meter, type StructuredRequest } from "@kj/ai";
import { problemsOf } from "@kj/generation";
import { countWords, type PageType, type SlideContent } from "@kj/schema";
import { BUDGETS } from "@kj/templates";

export const SLIDE_FAULTS = ["overBudget", "tooManyItems", "badVisual", "wrongNumber", "cliche", "fadeFrom", "invalidJson"] as const;
export const OUTLINE_FAULTS = ["timingDrift", "missingCfu", "badSourcePages", "outlineNoVisual", "invalidJson"] as const;
export type SlideFault = (typeof SLIDE_FAULTS)[number];
export type OutlineFault = (typeof OUTLINE_FAULTS)[number];
export type FaultId = SlideFault | OutlineFault;
const ALL_FAULTS = [...new Set<FaultId>([...SLIDE_FAULTS, ...OUTLINE_FAULTS])];

export interface NoiseConfig {
  profile: string;
  rates: Record<FaultId, number>;
  /** On a check-retry, a fault named in the problem list is fixed with this probability. */
  fixRate: number;
  /** On the AI layer's JSON-repair turn, broken JSON / missing fields are fixed with this probability. */
  jsonRepair: number;
  /** On a check-retry, faults the previous answer did not have appear at this fraction of their base rate. */
  retryNewRate: number;
}

const zero = Object.fromEntries(ALL_FAULTS.map((f) => [f, 0])) as Record<FaultId, number>;

/** Assumed per-call rates for a mid-tier model on long structured prompts; the catch matrix does not depend on them. */
const REALISTIC: Record<FaultId, number> = {
  overBudget: 0.25,
  tooManyItems: 0.15,
  badVisual: 0.1,
  wrongNumber: 0.1,
  cliche: 0.1,
  fadeFrom: 0.3,
  invalidJson: 0.06,
  timingDrift: 0.3,
  missingCfu: 0.2,
  badSourcePages: 0.15,
  outlineNoVisual: 0.2,
};

export const NOISE_PROFILES: Record<string, Omit<NoiseConfig, "profile">> = {
  none: { rates: zero, fixRate: 0.7, jsonRepair: 0.85, retryNewRate: 0.5 },
  realistic: { rates: REALISTIC, fixRate: 0.7, jsonRepair: 0.85, retryNewRate: 0.5 },
  heavy: { rates: Object.fromEntries(ALL_FAULTS.map((f) => [f, Math.min(0.9, REALISTIC[f] * 2)])) as Record<FaultId, number>, fixRate: 0.6, jsonRepair: 0.75, retryNewRate: 0.5 },
};

/** "realistic" | "heavy,overBudget=0.5,fixRate=0.5" | "none,wrongNumber=1" */
export function parseNoise(spec: string): NoiseConfig {
  const [profile = "realistic", ...overrides] = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const base = NOISE_PROFILES[profile];
  if (!base) throw new Error(`unknown noise profile "${profile}"; known: ${Object.keys(NOISE_PROFILES).join(", ")}`);
  const cfg: NoiseConfig = { profile: spec, rates: { ...base.rates }, fixRate: base.fixRate, jsonRepair: base.jsonRepair, retryNewRate: base.retryNewRate };
  for (const o of overrides) {
    const [k, v] = o.split("=", 2) as [string, string | undefined];
    const n = Number(v);
    if (!(n >= 0 && n <= 1)) throw new Error(`noise ${k} must be a number in [0, 1]`);
    if (k === "fixRate" || k === "jsonRepair" || k === "retryNewRate") cfg[k] = n;
    else if ((ALL_FAULTS as string[]).includes(k)) cfg.rates[k as FaultId] = n;
    else throw new Error(`unknown noise key "${k}"; known: ${ALL_FAULTS.join(", ")}, fixRate, jsonRepair, retryNewRate`);
  }
  return cfg;
}

// ---------- deterministic randomness ----------

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export type Rng = () => number;
export function rngFor(key: string): Rng {
  let a = hash(key);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;

// ---------- slide faults ----------

interface ListRef {
  items: () => string[];
  set: (i: number, s: string) => void;
  add: (s: string) => void;
  max: number;
  itemMax: number;
}

/** The on-screen list of a layout, as editable strings. */
function listOf(c: SlideContent): ListRef | null {
  const B = BUDGETS;
  switch (c.layout) {
    case "title":
      return { items: () => c.objectives, set: (i, s) => (c.objectives[i] = s), add: (s) => c.objectives.push(s), max: B.title.objectives.max, itemMax: B.title.objectives.item.max };
    case "statement":
      return { items: () => c.bullets, set: (i, s) => (c.bullets[i] = s), add: (s) => c.bullets.push(s), max: B.statement.bullets.max, itemMax: B.statement.bullets.item.max };
    case "chart":
      return { items: () => c.takeaways, set: (i, s) => (c.takeaways[i] = s), add: (s) => c.takeaways.push(s), max: B.chart.takeaways.max, itemMax: B.chart.takeaways.item.max };
    case "steps":
      return { items: () => c.steps.map((x) => x.text), set: (i, s) => (c.steps[i]!.text = s), add: (s) => c.steps.push({ text: s, why: "" }), max: B.steps.steps.max, itemMax: B.steps.steps.item.max };
    case "experiment":
      return { items: () => c.observe, set: (i, s) => (c.observe[i] = s), add: (s) => c.observe.push(s), max: B.experiment.observe.max, itemMax: B.experiment.observe.item.max };
    case "quiz":
      return { items: () => c.options.map((o) => o.text), set: (i, s) => (c.options[i]!.text = s), add: (s) => c.options.push({ text: s, misconception: "" }), max: B.quiz.options.max, itemMax: B.quiz.options.item.max };
    case "questions":
      return { items: () => c.items.map((x) => x.q), set: (i, s) => (c.items[i]!.q = s), add: (s) => c.items.push({ q: s, a: "See notes" }), max: B.questions.items.max, itemMax: B.questions.items.item.max };
    case "order":
      return { items: () => c.items.map((x) => x.text), set: (i, s) => (c.items[i]!.text = s), add: (s) => c.items.push({ text: s, match: c.mode === "match" ? "See notes" : "" }), max: B.order.items.max, itemMax: B.order.items.item.max };
    case "summary":
      return { items: () => c.nodes.map((n) => n.head), set: (i, s) => (c.nodes[i]!.head = s), add: (s) => c.nodes.push({ head: s, detail: "" }), max: B.summary.nodes.max, itemMax: B.summary.nodes.item.max };
  }
}

const FILLER =
  "which is one of the most important ideas in this chapter and explains many everyday observations that students can make at home or in the laboratory".split(" ");

function wordsFrom(source: string, rng: Rng, n: number): string[] {
  const words = source.replace(/\[p\.\d+\]/g, " ").split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z,'-]*$/.test(w));
  if (words.length < n + 5) return FILLER.slice(0, n);
  const start = Math.floor(rng() * (words.length - n));
  return words.slice(start, start + n);
}

const CLICHES = ["Let's explore", "In this lesson,", "Dive into", "It is important to note that"];
const BROKEN_EXPR = ["A*sin(2*pi*x/L", "A*sin(2*pi*x/L) + foo(x)", "y = A*sin(x)"];

export interface Injected {
  faults: SlideFault[];
  /** wrongNumber: the invented number now on screen. */
  marker?: string;
  /** invalidJson mode, or "omit" when badVisual dropped the visual field (structural). */
  jsonMode?: "fence" | "truncated" | "schema";
  structural: boolean;
}

/** Applies the chosen faults to a clean slide answer in place. Faults that do not apply to the layout are dropped. */
export function injectSlide(out: { content: SlideContent; notes: string }, want: SlideFault[], rng: Rng, ctx: { source: string; faded: boolean }): Injected {
  const c = out.content as SlideContent & Record<string, unknown>;
  const done: Injected = { faults: [], structural: false };
  const list = listOf(c);
  for (const f of want) {
    switch (f) {
      case "overBudget": {
        const items = list?.items() ?? [];
        if (!list || !items.length) break;
        const i = Math.floor(rng() * items.length);
        const target = Math.ceil(list.itemMax * (1.4 + rng() * 0.8));
        const have = countWords(items[i]!);
        list.set(i, `${items[i]} ${wordsFrom(ctx.source, rng, Math.max(2, target - have)).join(" ")}`.replace(/[,;]$/, ""));
        done.faults.push(f);
        break;
      }
      case "tooManyItems": {
        if (!list) break;
        const extra = list.max - list.items().length + 1 + Math.floor(rng() * 2);
        for (let k = 0; k < extra; k++) list.add(wordsFrom(ctx.source, rng, Math.max(2, list.itemMax - 2)).join(" ").replace(/[,;]$/, ""));
        done.faults.push(f);
        break;
      }
      case "badVisual": {
        const slot = c.layout === "statement" ? "visual" : c.layout === "chart" ? "chart" : c.layout === "experiment" ? "sim" : null;
        if (!slot) break;
        if (c.layout === "statement" && rng() < 0.5) {
          delete (c as Record<string, unknown>).visual;
          done.structural = true;
        } else {
          c[slot] = { kind: "function", expr: pick(rng, BROKEN_EXPR), x: [0, 4], y: [-3, 3], xLabel: "x", yLabel: "y", params: [] };
        }
        done.faults.push(f);
        break;
      }
      case "wrongNumber": {
        if (c.layout !== "statement" && c.layout !== "chart") break;
        const items = list!.items();
        if (!items.length) break;
        const i = Math.floor(rng() * items.length);
        const m = /\d+(?:\.\d+)?/.exec(items[i]!);
        let marker: string;
        if (m && (m[0].length >= 2 || m[0].includes("."))) {
          marker = String(Math.round(parseFloat(m[0]) * (1.3 + rng() * 0.6) * 10) / 10);
          list!.set(i, items[i]!.replace(m[0], marker));
        } else {
          do marker = String(12 + Math.floor(rng() * 86));
          while (new RegExp(`\\b${marker}\\b`).test(ctx.source));
          list!.set(i, `${items[i]} (about ${marker}%)`);
        }
        done.marker = marker;
        done.faults.push(f);
        break;
      }
      case "cliche": {
        const key = c.layout === "quiz" ? "question" : "title";
        if (typeof c[key] !== "string") break;
        c[key] = `${pick(rng, CLICHES)} ${c[key] as string}`;
        done.faults.push(f);
        break;
      }
      case "fadeFrom":
        if (c.layout === "steps" && ctx.faded && c.fadeFrom !== undefined) {
          delete (c as Record<string, unknown>).fadeFrom;
          done.faults.push(f);
        }
        break;
      case "invalidJson":
        done.jsonMode = pick(rng, ["fence", "truncated", "schema"] as const);
        done.faults.push(f);
        break;
    }
  }
  return done;
}

/**
 * The pipeline stubs overshoot some word budgets (e.g. 8-word takeaways where 7 is the max); a clean
 * model answer must not, so over-budget strings are clipped to their limit before any fault is injected.
 */
export function fitToBudget(content: SlideContent): SlideContent {
  const c = structuredClone(content) as unknown as Record<string, unknown>;
  for (let pass = 0; pass < 3; pass++) {
    const errors = problemsOf(c as unknown as SlideContent).errors;
    let changed = false;
    for (const e of errors) {
      const m = /^([\w.]+): [^:]+: at most (\d+) words/.exec(e);
      if (!m) continue;
      const keys = m[1]!.split(".");
      let parent: any = c;
      for (const k of keys.slice(0, -1)) parent = parent?.[k];
      const last = keys[keys.length - 1]!;
      if (typeof parent?.[last] !== "string") continue;
      const max = Number(m[2]) - pass;
      parent[last] = (parent[last] as string).split(/\s+/).slice(0, Math.max(1, max)).join(" ").replace(/[,;:]$/, "");
      changed = true;
    }
    if (!changed) break;
  }
  return c as unknown as SlideContent;
}

/** Which product check message a slide fault shows up as (problemsOf errors). */
export function classifyProblem(msg: string): SlideFault | "other" {
  if (/屏幕上不应出现/.test(msg)) return "cliche";
  if (/^fadeFrom/.test(msg)) return "fadeFrom";
  if (/^widget:/.test(msg)) return "badVisual";
  if (/not on the cited pages|does not compute|待核实/.test(msg)) return "wrongNumber";
  if (/at most \d+ words|expected string to have <=/.test(msg)) return "overBudget";
  if (/expected array to have <=/.test(msg)) return "tooManyItems";
  return "other";
}

/** Defects left in a finished slide: product-detectable ones via problemsOf, plus the invented number if still on screen. */
export function slideDefects(content: SlideContent, pageType: PageType | undefined, marker?: string): SlideFault[] {
  const out = new Set<SlideFault>();
  for (const e of problemsOf(content, pageType).errors) {
    const k = classifyProblem(e);
    if (k !== "other") out.add(k);
  }
  if (marker && new RegExp(`(?<![\\d.])${marker.replace(".", "\\.")}(?![\\d])`).test(JSON.stringify(content))) out.add("wrongNumber");
  return [...out];
}

// ---------- outline faults ----------

interface DraftSlide {
  pageType: PageType;
  title: string;
  keyPoints: string[];
  visual: string;
  minutes: number;
  sourcePages: number[];
  loop?: number;
  [k: string]: unknown;
}
interface Draft {
  slides: DraftSlide[];
  [k: string]: unknown;
}

export interface OutlineInjected {
  faults: OutlineFault[];
  modes: Partial<Record<OutlineFault, string>>;
  jsonMode?: "fence" | "truncated" | "schema";
  structural: boolean;
}

const SKELETON = new Set<PageType>(["cover", "retrieval", "summary", "exit"]);

export function injectOutline(d: Draft, want: OutlineFault[], rng: Rng): OutlineInjected {
  const done: OutlineInjected = { faults: [], modes: {}, structural: false };
  for (const f of want) {
    switch (f) {
      case "timingDrift": {
        const mode = pick(rng, ["inflate", "deflate", "drop"] as const);
        if (mode === "drop") {
          const removable = d.slides.map((s, i) => (SKELETON.has(s.pageType) ? -1 : i)).filter((i) => i >= 0);
          const drop = new Set(removable.filter(() => rng() < 0.45));
          d.slides = d.slides.filter((_, i) => !drop.has(i));
        } else {
          const k = mode === "inflate" ? 1.3 + rng() * 0.4 : 0.5 + rng() * 0.2;
          for (const s of d.slides) s.minutes = Math.round(s.minutes * k * 2) / 2 || 0.5;
        }
        done.modes[f] = mode;
        done.faults.push(f);
        break;
      }
      case "missingCfu": {
        const checks = d.slides.filter((s) => s.pageType === "check");
        if (!checks.length) break;
        for (const s of checks) Object.assign(s, { pageType: "concept", visual: "flow", title: s.title.replace(/^Check:\s*/i, "") });
        done.faults.push(f);
        break;
      }
      case "badSourcePages": {
        const mode = pick(rng, ["outOfRange", "shifted"] as const);
        const valid = [...new Set(d.slides.flatMap((s) => s.sourcePages))].sort((a, b) => a - b);
        const shift = Math.max(1, Math.ceil(valid.length / 2));
        for (const s of d.slides) {
          if (!s.sourcePages.length || rng() < 0.5) continue;
          s.sourcePages =
            mode === "outOfRange" ? s.sourcePages.map((p) => p + 180) : s.sourcePages.map((p) => valid[(valid.indexOf(p) + shift) % valid.length]!);
        }
        done.modes[f] = mode;
        done.faults.push(f);
        break;
      }
      case "outlineNoVisual":
        for (const s of d.slides) if (["concept", "process", "data"].includes(s.pageType)) s.visual = "none";
        done.faults.push(f);
        break;
      case "invalidJson":
        done.jsonMode = pick(rng, ["fence", "truncated", "schema"] as const);
        done.faults.push(f);
        break;
    }
  }
  return done;
}

// ---------- serialisation ----------

function serialise(output: unknown, mode: Injected["jsonMode"] | undefined): string {
  const json = JSON.stringify(output);
  switch (mode) {
    case "fence":
      return `Here is the JSON you asked for:\n\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\``;
    case "truncated":
      return json.slice(0, Math.floor(json.length * 0.8));
    case "schema": {
      const broken = structuredClone(output) as Record<string, any>;
      if (broken.content) broken.content.layout = "slide";
      else if (Array.isArray(broken.slides)) broken.slides = broken.slides.map((s: any) => ({ ...s, minutes: `${s.minutes} min` }));
      return JSON.stringify(broken);
    }
    default:
      return json;
  }
}

const tokensOf = (s: string) => Math.ceil((s.match(/[\u3400-\u9fff]/g)?.length ?? 0) + s.replace(/[\u3400-\u9fff]/g, "").length / 4);

// ---------- provider ----------

export interface FaultEvent {
  spec: string;
  attempt: number;
  turn: "first" | "repair";
  faults: FaultId[];
  modes?: Record<string, string>;
  marker?: string;
  repaired?: boolean;
}

const specScope = new AsyncLocalStorage<string>();
const reqScope = new AsyncLocalStorage<{ req: StructuredRequest<unknown>; spec: string; attempt: number }>();

/** Runs fn with the slide spec id visible to the noisy provider (fault seeds are per spec). */
export const withSpec = <T>(specId: string, fn: () => Promise<T>): Promise<T> => specScope.run(specId, fn);

/** Fault types a check-retry prompt names (the model was told about them). */
function namedInRetry(messages: ChatMessage[]): Set<FaultId> {
  const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  const named = new Set<FaultId>();
  const m = /(?:Your previous answer had these problems|Your previous outline broke these rules)[^\n]*\n([\s\S]*)$/.exec(user);
  if (!m) return named;
  for (const line of m[1]!.split("\n")) {
    const k = classifyProblem(line.replace(/^- /, ""));
    if (k !== "other") named.add(k);
    if (/±15%/.test(line)) named.add("timingDrift");
  }
  return named;
}

function sourceOf(messages: ChatMessage[]): string {
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  return /<source>([\s\S]*?)<\/source>/.exec(user)?.[1] ?? "";
}

export interface NoisyAi {
  ai: AiLayer;
  log: FaultEvent[];
  requests: () => number;
}

/** An AI layer whose only provider is the noisy stub. runKey = "<scenario>-r<run>". */
export function createNoisyAi(noise: NoiseConfig, runKey: string, meter: Meter, seed = "kj"): NoisyAi {
  const log: FaultEvent[] = [];
  let requests = 0;
  const config: AiConfig = { active: { provider: { id: "noisy", kind: "custom", name: "noisy-stub", baseUrl: "http://noisy.invalid/v1", apiKey: "none" }, model: `noisy:${noise.profile}` } };

  const fakeFetch = async (_url: string, init: RequestInit): Promise<Response> => {
    requests++;
    const scope = reqScope.getStore();
    if (!scope) throw new Error("noisy provider called outside callStructured");
    const { req, spec, attempt } = scope;
    const body = JSON.parse(String(init.body)) as { messages: ChatMessage[] };
    const last = body.messages[body.messages.length - 1]!;
    const repair = last.role === "user" && last.content.startsWith("Your JSON was invalid");
    const key = `${seed}|${runKey}|${spec}|a${attempt}`;
    const rng = rngFor(key);
    const named = attempt > 0 ? namedInRetry(body.messages) : new Set<FaultId>();
    const prev = attempt > 0 ? log.filter((e) => e.spec === spec && e.attempt === attempt - 1).pop() : undefined;
    const outline = req.capability === "outline.draft";
    const kinds = outline ? OUTLINE_FAULTS : SLIDE_FAULTS;
    // A retry rewrites the previous answer: its faults persist unless the prompt names them and the
    // model fixes them; new faults appear less often than in a first answer.
    const want = kinds.filter((f) => {
      const r = rng();
      if (prev?.faults.includes(f) && f !== "invalidJson") return named.has(f) ? r >= noise.fixRate : true;
      return r < noise.rates[f] * (attempt > 0 ? noise.retryNewRate : 1);
    });
    const clean = structuredClone(req.stub()) as any;
    let event: FaultEvent;
    let text: string;
    if (outline) {
      const inj = injectOutline(clean as Draft, want as OutlineFault[], rng);
      const fixed = repair && rngFor(`${key}|repair`)() < noise.jsonRepair;
      event = { spec, attempt, turn: repair ? "repair" : "first", faults: inj.faults, modes: inj.modes, repaired: repair ? fixed : undefined };
      text = serialise(clean, fixed ? undefined : inj.jsonMode);
    } else {
      const system = body.messages[0]?.content ?? "";
      const out = clean as { content: SlideContent; notes: string };
      out.content = fitToBudget(out.content);
      const inj = injectSlide(out, want as SlideFault[], rng, { source: sourceOf(body.messages), faded: system.includes("This is a faded example") });
      const fixed = repair && rngFor(`${key}|repair`)() < noise.jsonRepair;
      if (fixed && inj.structural) (out.content as any).visual = (req.stub() as any).content.visual;
      event = { spec, attempt, turn: repair ? "repair" : "first", faults: inj.faults, marker: inj.marker, repaired: repair ? fixed : undefined };
      text = serialise(out, fixed ? undefined : inj.jsonMode);
    }
    log.push(event);
    const prompt = body.messages.map((m) => m.content).join("\n");
    const payload = { model: `noisy:${noise.profile}`, choices: [{ message: { content: text } }], usage: { prompt_tokens: tokensOf(prompt), completion_tokens: tokensOf(text) } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };

  const base = createAiLayer({ config: { load: async () => config }, meter, fetch: fakeFetch, allowStubFallback: false });
  const attempts = new Map<string, number>();
  const ai: AiLayer = {
    callStructured: (req) => {
      const spec = specScope.getStore() ?? (req.capability === "outline.draft" ? "outline" : "deck");
      const attempt = attempts.get(spec) ?? 0;
      attempts.set(spec, attempt + 1);
      return reqScope.run({ req: req as StructuredRequest<unknown>, spec, attempt }, () => base.callStructured(req));
    },
  };
  return { ai, log, requests: () => requests };
}
