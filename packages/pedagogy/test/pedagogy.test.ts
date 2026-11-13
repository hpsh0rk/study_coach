import { describe, expect, it } from "vitest";
import type { Outline, SlideSpec } from "@kj/schema";
import { layoutForPageType } from "@kj/schema";
import { checkOutline, checkSlide, densityOf, outlineTiming, planBudget, scopeAdvice } from "../src/index.ts";

const spec = (pageType: SlideSpec["pageType"], minutes: number, extra: Partial<SlideSpec> = {}): SlideSpec => ({
  id: `s${Math.random().toString(36).slice(2, 7)}`,
  pageType,
  layout: layoutForPageType(pageType),
  title: "Waves carry energy, not matter",
  purpose: "",
  keyPoints: ["Energy moves along the rope", "The rope itself stays put"],
  visual: pageType === "concept" ? "formula" : "none",
  minutes,
  sourcePages: [1],
  loop: 1,
  ...extra,
});
const params = { minutes: 40, level: "intermediate", lessonType: "new", language: "en", focus: "" } as const;
const outline = (slides: SlideSpec[]): Outline => ({ objectives: ["Describe waves"], slides, glossary: [], notCovered: [] });

describe("time budget (L-03)", () => {
  it("allows ±15% and asks for acknowledgement beyond it", () => {
    expect(planBudget({ minutes: 40 })).toMatchObject({ minMinutes: 34, maxMinutes: 46 });
    const at = (m: number) => outlineTiming(outline([spec("practice", m)]), { minutes: 40 });
    expect(at(46).needsAck).toBe(false);
    expect(at(34).needsAck).toBe(false);
    expect(at(46.5).needsAck).toBe(true);
    expect(at(33.5).status).toBe("under");
  });
});

describe("checkOutline", () => {
  it("flags more than 10 lecture minutes without a check", () => {
    const o = outline([spec("cover", 0.5), spec("concept", 3.5), spec("concept", 3.5), spec("process", 4), spec("concept", 3), spec("practice", 8), spec("exit", 3)]);
    expect(checkOutline(o, params).map((v) => v.code)).toContain("check-cadence");
  });

  it("flags layouts that do not match the page type", () => {
    const o = outline([spec("cover", 1), { ...spec("concept", 3), layout: "quiz" }, spec("exit", 3)]);
    expect(checkOutline(o, params).some((v) => v.code === "layout" && v.level === "error")).toBe(true);
  });

  it("flags a numbered learning loop without both instruction and learner action, escalating 3+ lecture slides to an error", () => {
    const lone = spec("concept", 3, { loop: 1 });
    expect(checkOutline(outline([lone]), params)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "loop-balance", level: "warning", slideId: lone.id })]));
    const heavyLoop = outline([spec("cover", 0.5, { loop: 0 }), lone, spec("process", 3, { loop: 1 }), spec("data", 3, { loop: 1 }), spec("exit", 3, { loop: 0 })]);
    expect(checkOutline(heavyLoop, params)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "loop-balance", level: "error", slideId: lone.id })]));
    const paired = outline([lone, spec("check", 2, { loop: 1 })]);
    expect(checkOutline(paired, params).map((v) => v.code)).not.toContain("loop-balance");
  });
});

describe("densityOf", () => {
  it("is dense with too many points and sparse with none", () => {
    expect(densityOf(spec("concept", 3, { keyPoints: ["a", "b", "c", "d", "e", "f"] })).level).toBe("dense");
    expect(densityOf(spec("concept", 3, { keyPoints: [] })).level).toBe("sparse");
    expect(densityOf(spec("concept", 3)).level).toBe("ok");
  });
});

describe("checkSlide", () => {
  it("rejects teacher talk on screen", () => {
    const v = checkSlide({ layout: "statement", title: "In this lesson, let's dive into waves", bullets: ["Waves move energy"], visual: { kind: "formula", tex: "v=f\\lambda", caption: "" }, terms: [] });
    expect(v.length).toBeGreaterThan(0);
  });

  it("allows selective ==...== key-phrase emphasis (≤ 25%) and warns on whole-slide red walls (> 25%)", () => {
    const selective = checkSlide({
      layout: "statement",
      title: "Magnetic fields surround permanent magnets",
      bullets: ["==Field lines== run from north to south", "Closer lines show a stronger magnetic field", "Iron filings reveal the pattern clearly"],
      visual: { kind: "formula", tex: "B = \\mu_0 n I", caption: "" },
      terms: [],
    });
    expect(selective.map((x) => x.code)).not.toContain("emphasis-density");

    const redWall = checkSlide({
      layout: "statement",
      title: "==Magnetic fields surround permanent magnets==",
      bullets: ["==Field lines run from north to south==", "==Closer lines show a stronger magnetic field=="],
      visual: { kind: "formula", tex: "B = \\mu_0 n I", caption: "" },
      terms: [],
    });
    expect(redWall).toEqual(expect.arrayContaining([expect.objectContaining({ code: "emphasis-density", level: "warning" })]));
  });
});

describe("scopeAdvice", () => {
  it("never calls a selection a good fit while pages are cut from the source", () => {
    expect(scopeAdvice(6000, 40)).toMatchObject({ estimatedMinutes: 36, lessons: 1, tooMuch: false });
    expect(scopeAdvice(6000, 40, 3)).toMatchObject({ estimatedMinutes: 36, lessons: 2, tooMuch: true, unreadPages: 3 });
    expect(scopeAdvice(20000, 40)).toMatchObject({ lessons: 3, tooMuch: true });
  });
});
