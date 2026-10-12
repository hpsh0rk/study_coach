import { describe, expect, it } from "vitest";
import { createAiLayer } from "@kj/ai";
import { outlineTiming } from "@kj/pedagogy";
import { DEFAULT_PARAMS, type LessonParams } from "@kj/schema";
import { fakeAi } from "../../ai/test/fake.ts";
import { buildMessages, draftOutline, type DraftInput } from "../src/index.ts";

const pages = Array.from({ length: 12 }, (_, i) => ({ no: i + 1, text: `Page ${i + 1}. A wave transfers energy without transferring matter. The wave speed is v = f λ. Frequency is measured in hertz. Amplitude is the maximum displacement.` }));
const input = (params: Partial<LessonParams> = {}, flags: DraftInput["flags"] = {}): DraftInput => ({
  lessonTitle: "Waves",
  params: { ...DEFAULT_PARAMS, ...params },
  sections: [{ title: "13.1 Types of Waves", pageStart: 1, pageEnd: 12 }],
  pages,
  sourceText: pages.map((p) => `[p.${p.no}] ${p.text}`).join("\n"),
  ctx: { orgId: "o", userId: "u" },
  flags,
});
const stubAi = () => createAiLayer({ config: { load: async () => ({ providers: [], routes: {} }) }, meter: { record: async () => undefined }, allowStubFallback: true });

describe("stub planner", () => {
  it.each([30, 40, 45, 80])("lands within the time budget of a %i-minute lesson", async (minutes) => {
    const { outline } = await draftOutline(stubAi(), input({ minutes }));
    expect(outlineTiming(outline, { minutes }).needsAck).toBe(false);
    expect(outline.slides[0]!.pageType).toBe("cover");
    expect(outline.slides.every((s) => s.sourcePages.every((p) => p >= 1 && p <= 12))).toBe(true);
  });
});

const badOutline = {
  objectives: ["Describe waves"],
  slides: [
    { pageType: "cover", title: "Waves", minutes: 1, visual: "none", loop: 0 },
    { pageType: "concept", title: "Waves carry energy", minutes: 3, visual: "formula", loop: 1, sourcePages: [2, 99] },
    { pageType: "exit", title: "Exit ticket", minutes: 3, visual: "none", loop: 0 },
  ],
};

describe("ablation flags", () => {
  it("retries a rule-breaking outline once by default, not with outlineCheckRetry=false", async () => {
    const a = fakeAi([badOutline]);
    await draftOutline(a.ai, input());
    expect(a.requests).toHaveLength(2);
    expect(a.requests[1]!.at(-1)!.content).toContain("broke these rules");
    const b = fakeAi([badOutline]);
    const res = await draftOutline(b.ai, input({}, { outlineCheckRetry: false }));
    expect(b.requests).toHaveLength(1);
    expect(res.warnings.some((w) => w.level === "error")).toBe(true);
    expect(res.outline.slides[1]!.sourcePages).toEqual([2]);
  });

  it("phases=false drops learning loops; visualPlanning=writer leaves visuals to the writer", async () => {
    const msgs = buildMessages(input({}, { phases: false, visualPlanning: "writer" }));
    expect(msgs[0]!.content).not.toContain("learning loops");
    expect(msgs[0]!.content).not.toMatch(/"loop"/);
    expect(msgs[0]!.content).not.toMatch(/"visual"/);
    const a = fakeAi([badOutline]);
    const res = await draftOutline(a.ai, input({}, { phases: false, visualPlanning: "writer", outlineCheckRetry: false }));
    expect(res.outline.slides.every((s) => s.loop === 0 && s.visual === "none")).toBe(true);
  });

  it("budgetsInPrompt=false removes the content budgets from the prompt", () => {
    expect(buildMessages(input())[0]!.content).toContain("each ≤ 9 words");
    expect(buildMessages(input({}, { budgetsInPrompt: false }))[0]!.content).not.toContain("each ≤ 9 words");
  });
});
