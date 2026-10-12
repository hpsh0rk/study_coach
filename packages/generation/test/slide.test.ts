import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, type Outline, type SlideSpec } from "@kj/schema";
import { BUDGETS } from "@kj/templates";
import { fakeAi } from "../../ai/test/fake.ts";
import { buildSlideMessages as buildMessages, sourcePagesFor, writeSlide, type WriteInput } from "../src/index.ts";

const spec: SlideSpec = { id: "sp2", pageType: "concept", layout: "statement", title: "Waves carry energy, not matter", purpose: "", keyPoints: ["Energy moves"], visual: "formula", minutes: 3, sourcePages: [2], loop: 1 };
const outline: Outline = { objectives: ["Describe waves"], slides: [spec], glossary: [{ term: "wavelength", zh: "波长" }], notCovered: [] };
const pages = [1, 2, 3].map((no) => ({ no, text: `Page ${no}: the wave speed is v = f λ.` }));
const input = (options: WriteInput["options"] = {}): WriteInput => ({ lessonTitle: "Waves", params: DEFAULT_PARAMS, pages, ctx: { orgId: "o", userId: "u" }, options });

const overBudget = {
  content: {
    layout: "statement",
    title: "Waves carry energy, not matter",
    bullets: ["Energy moves along", "Particles oscillate", "Speed is f times λ", "Frequency in hertz", "Amplitude is height", "Sixth point here"],
    visual: { kind: "formula", tex: "v = f\\lambda", caption: "" },
    terms: [],
  },
  notes: "Ask the class what moves along the rope.",
};

describe("slide writer options", () => {
  it("selects source text per writerSource", () => {
    expect(sourcePagesFor(spec, input()).map((p) => p.no)).toEqual([2]);
    expect(sourcePagesFor(spec, input({ writerSource: "all" })).map((p) => p.no)).toEqual([1, 2, 3]);
    expect(sourcePagesFor(spec, input({ writerSource: "none" }))).toEqual([]);
    expect(buildMessages(spec, input({ writerSource: "none" }), outline)[1]!.content).not.toContain("Source pages");
  });

  it("default: retries with the violation list, then truncates to the hard budget", async () => {
    const a = fakeAi([overBudget]);
    const res = await writeSlide(a.ai, outline, "sp2", input());
    expect(a.requests).toHaveLength(2);
    expect(a.requests[1]!.at(-1)!.content).toContain("previous answer had these problems");
    expect(res.content.layout === "statement" && res.content.bullets.length).toBe(BUDGETS.statement.bullets.max);
  });

  it("slideCheckRetry=false makes one call; truncateFallback=false keeps the overflow", async () => {
    const a = fakeAi([overBudget]);
    const res = await writeSlide(a.ai, outline, "sp2", input({ slideCheckRetry: false, truncateFallback: false }));
    expect(a.requests).toHaveLength(1);
    expect(res.content.layout === "statement" && res.content.bullets.length).toBe(6);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it("budgetsInPrompt=false and visualPlanning=writer change the prompt only", () => {
    const sys = (f: WriteInput["options"]) => buildMessages(spec, input(f), outline)[0]!.content;
    expect(sys({})).toContain("Hard content budgets");
    expect(sys({ budgetsInPrompt: false })).not.toContain("Hard content budgets");
    expect(sys({ visualPlanning: "writer" })).toContain("Choose the visual kind");
  });
});

describe("slide writer context", () => {
  it("never falls back to the whole selection when a slide cites no pages", () => {
    expect(sourcePagesFor({ ...spec, sourcePages: [] }, input())).toEqual([]);
    const big = [{ no: 2, text: "x".repeat(20_000) }];
    expect(sourcePagesFor(spec, { pages: big })[0]!.text.length).toBe(12_000);
  });

  it("puts the glossary and neighbouring titles into the prompt and enforces glossary translations", async () => {
    const two: Outline = { ...outline, slides: [{ ...spec, id: "sp1", title: "Waves move" }, spec] };
    const [sys, user] = buildMessages(spec, input(), two);
    expect(sys!.content).toContain("wavelength = 波长");
    expect(user!.content).toContain('previous slide: "Waves move"');
    const reply = { ...overBudget, content: { ...overBudget.content, bullets: ["Energy moves along"], terms: [{ term: "Wavelength", zh: "波的长度" }] } };
    const res = await writeSlide(fakeAi([reply]).ai, two, "sp2", input());
    expect(res.content.layout === "statement" && res.content.terms[0]!.zh).toBe("波长");
  });

  it("requires fadeFrom on faded examples and repairs it deterministically", async () => {
    const faded: SlideSpec = { ...spec, id: "sp3", pageType: "faded", layout: "steps" };
    const steps = { content: { layout: "steps", title: "Finish the calculation", problem: "Find v when f = 4 Hz and λ = 0.5 m.", steps: [{ text: "v = f λ" }, { text: "v = 4 × 0.5" }, { text: "v = 2 m/s" }] }, notes: "" };
    const a = fakeAi([steps, steps]);
    const res = await writeSlide(a.ai, { ...outline, slides: [faded] }, "sp3", input());
    expect(a.requests).toHaveLength(2);
    expect(res.content.layout === "steps" && res.content.fadeFrom).toBe(2);
  });
});
