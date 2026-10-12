import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, type ConfirmedOutline, type SlideSpec } from "@kj/schema";
import { fakeAi } from "../../ai/test/fake.ts";
import { buildMessages, sourcePagesFor, writeSlide, type WriteInput } from "../src/index.ts";

const spec: SlideSpec = { id: "sp2", pageType: "concept", layout: "statement", title: "Waves carry energy, not matter", purpose: "", keyPoints: ["Energy moves"], visual: "formula", minutes: 3, sourcePages: [2], loop: 1 };
const confirmed = { versionId: "v", lessonId: "l", confirmedAt: 1, outline: { objectives: ["Describe waves"], slides: [spec] } } as ConfirmedOutline;
const pages = [1, 2, 3].map((no) => ({ no, text: `Page ${no}: the wave speed is v = f λ.` }));
const input = (flags: WriteInput["flags"] = {}): WriteInput => ({ lessonTitle: "Waves", params: DEFAULT_PARAMS, pages, ctx: { orgId: "o", userId: "u" }, flags });

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

describe("writer ablation flags", () => {
  it("selects source text per writerSource", () => {
    expect(sourcePagesFor(spec, input()).map((p) => p.no)).toEqual([2]);
    expect(sourcePagesFor(spec, input({ writerSource: "all" })).map((p) => p.no)).toEqual([1, 2, 3]);
    expect(sourcePagesFor(spec, input({ writerSource: "none" }))).toEqual([]);
    expect(buildMessages(spec, input({ writerSource: "none" }), confirmed.outline)[1]!.content).not.toContain("Source pages");
  });

  it("default: retries with the violation list, then truncates to the hard budget", async () => {
    const a = fakeAi([overBudget]);
    const res = await writeSlide(a.ai, confirmed, "sp2", input());
    expect(a.requests).toHaveLength(2);
    expect(a.requests[1]!.at(-1)!.content).toContain("previous answer had these problems");
    expect(res.content.layout === "statement" && res.content.bullets.length).toBe(4);
  });

  it("slideCheckRetry=false makes one call; truncateFallback=false keeps the overflow", async () => {
    const a = fakeAi([overBudget]);
    const res = await writeSlide(a.ai, confirmed, "sp2", input({ slideCheckRetry: false, truncateFallback: false }));
    expect(a.requests).toHaveLength(1);
    expect(res.content.layout === "statement" && res.content.bullets.length).toBe(6);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it("budgetsInPrompt=false and visualPlanning=writer change the prompt only", () => {
    const sys = (f: WriteInput["flags"]) => buildMessages(spec, input(f), confirmed.outline)[0]!.content;
    expect(sys({})).toContain("Hard content budgets");
    expect(sys({ budgetsInPrompt: false })).not.toContain("Hard content budgets");
    expect(sys({ visualPlanning: "writer" })).toContain("Choose the visual kind");
  });
});
