import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createAiLayer } from "@kj/ai";
import { DEFAULT_PARAMS, PAGE_TYPE_IDS, type Outline, type PageType, type SlideSpec } from "@kj/schema";
import { layoutForPageType, SLOT_SCHEMAS } from "@kj/templates";
import { slotIssues, widgetIssues } from "@kj/templates/issues";
import { clipToBudgets, draftOutline, writeSlide } from "../src/index.ts";

// OpenStax chapter texts used by the evals (CC BY 4.0, openstax.org).
const DIR = path.resolve(__dirname, "../../../fixtures/eval-pages");
const books = fs.readdirSync(DIR).filter((f) => f.endsWith(".pages.json"));
const stubAi = () => createAiLayer({ config: { load: async () => ({ active: null }) }, meter: { record: async () => undefined }, allowStubFallback: true });
const ctx = { orgId: "o", userId: "u" };

/** What PATCH /slides/:id accepts: the slot schema with its hard budgets, and drawable widgets. */
const patchProblems = (content: unknown) => {
  const c = content as Parameters<typeof slotIssues>[0];
  if (SLOT_SCHEMAS[c.layout].safeParse(c).success && !widgetIssues(c).length) return [];
  return [...slotIssues(c), ...widgetIssues(c)].map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("generated slides always pass the editor's own validation", () => {
  it.each(books)("%s: every planned page and every page type", async (file) => {
    const { pages } = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")) as { pages: { no: number; text: string }[] };
    const ai = stubAi();
    const lessonTitle = file.replace(".pages.json", "");
    const { outline } = await draftOutline(ai, { lessonTitle, params: DEFAULT_PARAMS, sections: [], pages, ctx });
    const extra: SlideSpec[] = PAGE_TYPE_IDS.map((pageType: PageType, i) => {
      const base = outline.slides[i % outline.slides.length]!;
      return { ...base, id: `x-${pageType}`, pageType, layout: layoutForPageType(pageType), visual: pageType === "experiment" ? "sim" : pageType === "data" ? "table" : base.visual, sourcePages: base.sourcePages.length ? base.sourcePages : [pages[0]!.no] };
    });
    const all: Outline = { ...outline, slides: [...outline.slides, ...extra] };
    const failures: string[] = [];
    for (const spec of all.slides) {
      const res = await writeSlide(ai, all, spec.id, { lessonTitle, params: DEFAULT_PARAMS, pages, ctx });
      const bad = patchProblems(res.content);
      if (bad.length) failures.push(`${spec.pageType}/${spec.layout}: ${bad.join("; ")}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("clipToBudgets", () => {
  it("shortens over-budget text slots (links first) until the schema accepts them", () => {
    const c = {
      layout: "experiment" as const,
      title: "Investigate: wave on a string",
      predict: { question: "What happens to the wavelength if frequency increases?", options: ["It gets longer", "It gets shorter", "It stays the same"] },
      sim: { kind: "sim" as const, embedId: "wave-string" },
      observe: ["Double the frequency", "Measure the new wavelength"],
      explain: "org/books/physics/pages/13-1-types-of-waves) In a longitudinal sound wave, after a compression wave moves through the medium it relaxes",
    };
    expect(SLOT_SCHEMAS.experiment.safeParse(c).success).toBe(false);
    const out = clipToBudgets(c);
    expect(SLOT_SCHEMAS.experiment.safeParse(out).success).toBe(true);
    expect(out.layout === "experiment" && out.explain.startsWith("In a longitudinal sound wave")).toBe(true);
    expect(out.layout === "experiment" && out.predict.options[2]).toBe("It stays the same");
  });

  it("treats balanced $...$ math as atomic (never leaves an unmatched $) and trims CJK at clause boundaries without dangling particles", () => {
    const mathSlide = {
      layout: "statement" as const,
      title: "牛顿第二定律与加速度关系",
      bullets: [
        "加速度与合力成正比，与质量成反比，表达式为 $\\vec{F}_{\\text{合}} = m \\vec{a}$ 且方向始终保持一致",
        "Write the wave speed equation clearly in standard SI symbols: $v = f \\times \\lambda$",
      ],
      visual: { kind: "formula" as const, tex: "F = ma", caption: "" },
      terms: [],
    };
    const clippedMath = clipToBudgets(mathSlide);
    expect(SLOT_SCHEMAS.statement.safeParse(clippedMath).success).toBe(true);
    if (clippedMath.layout !== "statement") throw new Error("layout");
    for (const b of clippedMath.bullets) {
      const dollars = (b.match(/\$/g) ?? []).length;
      expect(dollars % 2, `unmatched $ in "${b}"`).toBe(0);
    }

    const cjkOrder = {
      layout: "order" as const,
      title: "牛顿第一定律核心概念配对",
      mode: "match" as const,
      items: [
        { text: "惯性", match: "物体保持原有运动状态的性质" },
        { text: "平衡状态", match: "不受外力时保持静止或匀速直线运动" },
        { text: "加速度", match: "a = 4 m/s²，方向与合力方向相同" },
      ],
    };
    const clippedCjk = clipToBudgets(cjkOrder);
    expect(SLOT_SCHEMAS.order.safeParse(clippedCjk).success).toBe(true);
    if (clippedCjk.layout !== "order") throw new Error("layout");
    expect(clippedCjk.items[2]!.match).toBe("a = 4 m/s²");
    for (const item of clippedCjk.items) {
      expect(item.match).not.toMatch(/[的与和或及]$/);
      expect(item.match).not.toMatch(/匀速直线运$|牛顿第二定$/);
    }
  });
});
