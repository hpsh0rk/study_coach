import { describe, expect, it } from "vitest";
import type { SlideContent } from "@kj/schema";
import { evalArithmetic, numbersIn, symbolsOf, verifyNumbers } from "../src/index.ts";

const SOURCE =
  "The speed of sound in air is about 340 metres per second. Ultrasound is sound with a frequency above 20 000 hertz. Wave speed, frequency and wavelength are linked by the wave equation v = f x lambda. Light travels at 3.0 × 10^8 m/s.";

const statement = (bullets: string[], visual: Extract<SlideContent, { layout: "statement" }>["visual"] = { kind: "formula", tex: "v = f\\lambda" }): SlideContent => ({
  layout: "statement",
  title: "Sound travels through a medium",
  bullets,
  visual,
  terms: [],
});

describe("numbersIn", () => {
  it("reads thousands separators, decimals, scientific notation and TeX", () => {
    expect(numbersIn("above 20 000 hertz, 3,400 m and 0.25 s").map((n) => n.value)).toEqual([20000, 3400, 0.25]);
    expect(numbersIn("$3.0 \\times 10^{8}$ m/s").map((n) => n.value)).toEqual([3e8]);
    expect(numbersIn("10^{-3} m").map((n) => n.value)).toEqual([1e-3]);
    expect(numbersIn("CO2 and H2O on p.12").map((n) => n.value)).toEqual([]);
  });
});

describe("evalArithmetic", () => {
  it("evaluates + − × ÷ ^ and parentheses, refuses anything else", () => {
    expect(evalArithmetic("4 × 0.5")).toBe(2);
    expect(evalArithmetic("(2 + 3) × 2^2 ÷ 4")).toBe(5);
    expect(evalArithmetic("-3 − 2")).toBe(-5);
    expect(evalArithmetic("alert(1)")).toBeUndefined();
    expect(evalArithmetic("2 *")).toBeUndefined();
  });
});

describe("symbolsOf", () => {
  it("treats TeX juxtaposition as products and Greek names as letters", () => {
    expect([...symbolsOf("v = f\\lambda", true)].sort()).toEqual(["f", "v", "λ"]);
    expect([...symbolsOf("the wave equation v = f x lambda", false)].sort()).toEqual(["f", "v", "x", "λ"]);
    expect([...symbolsOf("y = A\\sin(2\\pi x)", true)].sort()).toEqual(["A", "x", "y", "π"]);
  });
});

describe("verifyNumbers", () => {
  it("passes numbers and formulas that appear in the source (incl. unit scaling and 10^n forms)", () => {
    const c = statement(["Sound travels at about 340 m/s in air", "Ultrasound is above 20 kHz", "Light: $3.0 \\times 10^8$ m/s"]);
    expect(verifyNumbers(c, SOURCE)).toEqual([]);
  });

  it("flags numbers missing from the cited pages, but ignores small counts", () => {
    const c = statement(["Sound travels at 343 m/s in air", "There are 3 kinds of wave"]);
    const u = verifyNumbers(c, SOURCE);
    expect(u).toEqual([expect.objectContaining({ kind: "number", text: "343" })]);
  });

  it("checks table cells and chart data", () => {
    const t = statement(["Speeds differ by medium"], { kind: "table", columns: ["Medium", "Speed"], rows: [["air", "340 m/s"], ["water", "1500 m/s"]] });
    expect(verifyNumbers(t, SOURCE).map((x) => x.text)).toEqual(["1500"]);
    const chart: SlideContent = { layout: "chart", title: "Speed by medium", chart: { kind: "chart", type: "bar", xLabel: "medium", yLabel: "speed / m/s", categories: ["air", "steel"], series: [{ name: "v", data: [340, 5960] }] }, takeaways: ["Solids are fastest"], source: "Textbook p.7" };
    expect(verifyNumbers(chart, SOURCE).map((x) => x.text)).toEqual(["5960"]);
  });

  it("flags a formula whose symbols no source equation contains", () => {
    const u = verifyNumbers(statement(["Period and frequency are linked"], { kind: "formula", tex: "T = \\frac{1}{f}" }), SOURCE);
    expect(u).toEqual([expect.objectContaining({ kind: "formula", text: "T = \\frac{1}{f}" })]);
  });

  it("problem layouts may invent numbers, but their arithmetic must compute (incl. across steps)", () => {
    const ok: SlideContent = { layout: "steps", title: "Find the speed", problem: "Find $v$ when $f = 5$ Hz and $\\lambda = 0.4$ m.", steps: [{ text: "Write $v = f\\lambda$", why: "" }, { text: "Substitute: $v = 5 \\times 0.4$", why: "" }, { text: "Calculate: $v = 2$ m/s", why: "" }] };
    expect(verifyNumbers(ok, SOURCE, { pageType: "worked" })).toEqual([]);
    const bad: SlideContent = { ...ok, steps: [{ text: "Substitute: $v = 5 \\times 0.4$", why: "" }, { text: "Calculate: $v = 2.5$ m/s", why: "" }] };
    expect(verifyNumbers(bad, SOURCE, { pageType: "worked" })).toEqual([expect.objectContaining({ kind: "calc", text: "v = 5 × 0.4 = 2.5" })]);
    const inline: SlideContent = { ...ok, steps: [{ text: "$v = 4 \\text{ Hz} \\times 0.5 \\text{ m} = 3$ m/s", why: "" }, { text: "Answer with units", why: "" }] };
    expect(verifyNumbers(inline, SOURCE, { pageType: "practice" })).toEqual([expect.objectContaining({ kind: "calc" })]);
  });

  it("re-checks calculations in the notes (answer key) and accepts rounding", () => {
    const c = statement(["Sound travels at about 340 m/s in air"]);
    expect(verifyNumbers(c, SOURCE, { notes: "Answer: d = 340 × 3 = 1020 m" })).toEqual([]);
    expect(verifyNumbers(c, SOURCE, { notes: "Answer: d = 340 × 3 = 1200 m" })).toEqual([expect.objectContaining({ kind: "calc" })]);
    expect(verifyNumbers(c, SOURCE, { notes: "t = 1 / 3 = 0.33 s" })).toEqual([]);
  });

  it("counts a verified calculation's result as supported on concept slides", () => {
    const c = statement(["In 3 s sound travels $340 \\times 3 = 1020$ m"]);
    expect(verifyNumbers(c, SOURCE)).toEqual([]);
  });
});
