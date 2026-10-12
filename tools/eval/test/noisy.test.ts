import { describe, expect, it } from "vitest";
import { draftOutline, problemsOf, stubOutline, writeSlide, type DraftInput } from "@kj/generation";
import { DEFAULT_PARAMS, type SlideContent } from "@kj/schema";
import { classifyProblem, createNoisyAi, fitToBudget, injectOutline, injectSlide, parseNoise, rngFor, SLIDE_FAULTS, slideDefects, withSpec, type FaultEvent } from "../src/noisy.ts";
import { pairedCi } from "../src/compare.ts";

const pages = Array.from({ length: 6 }, (_, i) => ({
  no: i + 1,
  text: `Page ${i + 1}. A wave transfers energy without transferring matter. The wave speed is v = f x lambda. Frequency is measured in hertz and the speed of sound in air is 343 m/s.`,
}));
const input: DraftInput = {
  lessonTitle: "Waves",
  params: { ...DEFAULT_PARAMS, minutes: 40 },
  sections: [{ title: "13.1 Types of Waves", pageStart: 1, pageEnd: 6 }],
  pages,
  ctx: { orgId: "o", userId: "u" },
};
const statement = (): { content: SlideContent; notes: string } => ({
  content: { layout: "statement", title: "Waves carry energy", bullets: ["Energy moves, matter stays", "Speed is 343 m/s"], visual: { kind: "flow", steps: ["Source", "Medium"] }, terms: [] },
  notes: "",
});

describe("noise config", () => {
  it("parses profiles and overrides, and rejects unknown keys", () => {
    const n = parseNoise("realistic,overBudget=0.5,fixRate=0.2");
    expect(n.rates.overBudget).toBe(0.5);
    expect(n.fixRate).toBe(0.2);
    expect(parseNoise("none").rates.wrongNumber).toBe(0);
    expect(() => parseNoise("loud")).toThrow(/unknown noise profile/);
    expect(() => parseNoise("none,nope=1")).toThrow(/unknown noise key/);
    expect(() => parseNoise("none,cliche=2")).toThrow(/\[0, 1\]/);
  });
});

describe("slide faults", () => {
  it.each(SLIDE_FAULTS.filter((f) => !["fadeFrom", "invalidJson", "badVisual"].includes(f)))("%s is what the product checks (or the number marker) report", (fault) => {
    const out = statement();
    const inj = injectSlide(out, [fault], rngFor(fault), { source: pages.map((p) => p.text).join(" "), faded: false });
    expect(inj.faults).toEqual([fault]);
    expect(slideDefects(out.content, "concept", inj.marker)).toContain(fault);
    expect(slideDefects(statement().content, "concept", inj.marker)).toEqual([]);
  });

  it("a broken visual is either structural (JSON repair) or a widget error (check-retry)", () => {
    for (let k = 0; k < 6; k++) {
      const out = statement();
      const inj = injectSlide(out, ["badVisual"], rngFor(`v${k}`), { source: "", faded: false });
      if (inj.structural) expect((out.content as { visual?: unknown }).visual).toBeUndefined();
      else expect(problemsOf(out.content, "concept").errors.some((e) => classifyProblem(e) === "badVisual")).toBe(true);
    }
  });

  it("fitToBudget clips over-budget strings so a clean answer has no errors", () => {
    const over = { ...statement().content, bullets: ["one two three four five six seven eight nine ten eleven"] } as SlideContent;
    expect(problemsOf(over).errors.length).toBeGreaterThan(0);
    expect(problemsOf(fitToBudget(over)).errors).toEqual([]);
  });
});

describe("outline faults", () => {
  it("timing drift and missing checks change the plan as described", () => {
    const clean = stubOutline(input);
    const drift = structuredClone(clean);
    const inj = injectOutline(drift as never, ["timingDrift"], rngFor("d"));
    expect(inj.modes.timingDrift).toBeDefined();
    const sum = (o: typeof clean) => o.slides.reduce((n, s) => n + s.minutes, 0);
    expect(sum(drift)).not.toBe(sum(clean));
    const cfu = structuredClone(clean);
    injectOutline(cfu as never, ["missingCfu"], rngFor("c"));
    expect(cfu.slides.some((s) => s.pageType === "check")).toBe(false);
  });
});

describe("noisy provider", () => {
  it("runs behind the real AI layer, is deterministic, and logs what it injected", async () => {
    const run = async () => {
      const calls: unknown[] = [];
      const n = createNoisyAi(parseNoise("heavy"), "S01-r1", { record: async (r) => void calls.push(r) });
      const { outline } = await draftOutline(n.ai, input);
      const spec = outline.slides.find((s) => s.layout === "statement")!;
      const w = await withSpec(spec.id, () => writeSlide(n.ai, outline, spec.id, { ...input, options: {} }));
      return { outline, w, log: n.log as FaultEvent[], requests: n.requests(), calls: calls.length };
    };
    const a = await run();
    const b = await run();
    expect(a.log).toEqual(b.log);
    expect(a.w.content).toEqual(b.w.content);
    expect(a.requests).toBeGreaterThanOrEqual(a.calls);
    expect(a.log.length).toBeGreaterThan(0);
  });

  it("with no noise the first answer is accepted: one call per slide", async () => {
    const n = createNoisyAi(parseNoise("none"), "S01-r1", { record: async () => undefined });
    const { outline } = await draftOutline(n.ai, input);
    for (const spec of outline.slides) await withSpec(spec.id, () => writeSlide(n.ai, outline, spec.id, { ...input, options: {} }));
    expect(n.requests()).toBe(outline.slides.length + 1);
    expect(n.log.every((e) => e.faults.length === 0)).toBe(true);
  });
});

describe("paired bootstrap", () => {
  it("brackets the mean difference and collapses for constant differences", () => {
    const pairs = Array.from({ length: 18 }, (_, i) => ({ stratum: `S${Math.floor(i / 3)}`, d: 0.1 + (i % 3) * 0.05 }));
    const [lo, hi] = pairedCi(pairs, 2000);
    expect(lo).toBeLessThanOrEqual(0.15);
    expect(hi).toBeGreaterThanOrEqual(0.15);
    expect(pairedCi([{ stratum: "S", d: 2 }], 100)).toEqual([2, 2]);
  });
});
