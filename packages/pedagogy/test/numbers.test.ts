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

  it("extracts juxtaposed variable products around = in plain text without leaking English prose words", () => {
    expect([...symbolsOf("表达式为 F = ma。", false)].sort()).toEqual(["F", "a", "m"]);
    expect([...symbolsOf("Momentum is p = mv, and work is W = Fs.", false)].sort()).toEqual(["F", "W", "m", "p", "s", "v"]);
    expect([...symbolsOf("Speed = distance / time", false)]).toEqual([]);
  });
});

describe("verifyNumbers", () => {
  it("passes numbers and formulas that appear in the source (incl. unit scaling and 10^n forms)", () => {
    const c = statement(["Sound travels at about 340 m/s in air", "Ultrasound is above 20 kHz", "Light: $3.0 \\times 10^8$ m/s"]);
    expect(verifyNumbers(c, SOURCE)).toEqual([]);
  });

  it("compares value and unit together, including scaled and Chinese units", () => {
    expect(verifyNumbers(statement(["Sound travels at 340 km/s in air"]), SOURCE)).toEqual([expect.objectContaining({ kind: "number", text: "340 km/s" })]);
    expect(verifyNumbers(statement(["Ultrasound is above 20 kHz"]), SOURCE)).toEqual([]);
    const zh = statement(["合力是12千克"]);
    expect(verifyNumbers(zh, "物体受到12牛顿合力")).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "number", text: "12千克" })]));
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

  it("distinguishes equivalent rearrangements from a wrong law with the same symbols", () => {
    const source = "Newton's second law is F = m x a.";
    expect(verifyNumbers(statement(["Rearrange for acceleration"], { kind: "formula", tex: "a=F/m" }), source)).toEqual([]);
    expect(verifyNumbers(statement(["Multiply force and mass"], { kind: "formula", tex: "a=Fm" }), source)).toEqual([expect.objectContaining({ kind: "formula", text: "a=Fm" })]);
  });

  it("preserves signs and significant figures from the cited source", () => {
    const visual = { kind: "placeholder" as const, hint: "" };
    const source = "The enthalpy change is -286 kJ/mol. The measured yield is 36.0 g.";
    expect(verifyNumbers(statement(["Enthalpy change is -286 kJ/mol", "Measured yield is 36.0 g"], visual), source)).toEqual([]);
    expect(verifyNumbers(statement(["Enthalpy change is +286 kJ/mol"], visual), source)).toEqual([expect.objectContaining({ kind: "number", text: "286" })]);
    expect(verifyNumbers(statement(["Measured yield is 36 g"], visual), source)).toEqual([expect.objectContaining({ kind: "number", text: "36", detail: expect.stringContaining("significant figures") })]);
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

  it("supports live MinerU LaTeX quantities (~ spacing, braced exponents) and font-wrapped formulas", () => {
    const mineruSource = [
      "$$",
      "\\mathtt { v } = \\mathtt { u } + \\mathtt { a } \\mathtt { t }",
      "$$",
      "$$",
      "\\mathsf { s } = \\mathrm{ut} + \\mathsf{at} ^ { 2 } / 2",
      "$$",
      "A car accelerates at $2 ~ \\mathrm { m } / \\mathrm { s } ^ { 2 }$ and cruises at $12 ~ \\mathrm { m } / \\mathrm { s }$.",
    ].join("\n");
    expect(verifyNumbers(statement(["Acceleration is 2 m/s² and speed is 12 m/s"], { kind: "formula", tex: "s = ut + \\frac{1}{2}at^2" }), mineruSource)).toEqual([]);
    expect(verifyNumbers(statement(["Acceleration is 2 m/s"], { kind: "formula", tex: "v = u + at" }), mineruSource)).toEqual([
      expect.objectContaining({ kind: "number", text: "2 m/s" }),
    ]);
  });

  it("grounds $F = ma$ and $a = F/m$ against Chinese prose without trailing spaces (newton-zh-cid.pdf p.3–4) while catching wrong laws", () => {
    const newtonZhP3 =
      "4.3 牛顿第二定律\n物体加速度的大小跟它受到的合力成正比，跟它的质量成反比，加速度的方向跟合力的方向相同。表达式为 F = ma。力的单位是牛顿，1 N = 1 kg·m/s²。";
    const newtonZhP4 =
      "4.3 牛顿第二定律（例题）\n例题：质量为 2 kg 的物体受到 10 N 的水平合力，求它的加速度。解：由 F = ma 得 a = F/m = 10 N ÷ 2 kg = 5 m/s²，方向与合力方向相同。";

    expect(verifyNumbers(statement(["合力与加速度成正比：$F = ma$"], { kind: "formula", tex: "F = ma" }), newtonZhP3)).toEqual([]);
    expect(verifyNumbers(statement(["变形求加速度：$a = F/m$"], { kind: "formula", tex: "a = \\frac{F}{m}" }), newtonZhP3)).toEqual([]);
    expect(verifyNumbers(statement(["由牛顿第二定律求加速度：$a = F/m$"], { kind: "formula", tex: "a = F/m" }), newtonZhP4)).toEqual([]);

    // Wrong multiplicative rearrangement and ungrounded formulas still fail on the same Chinese page.
    expect(verifyNumbers(statement(["错误变形"], { kind: "formula", tex: "a = Fm" }), newtonZhP3)).toEqual([
      expect.objectContaining({ kind: "formula", text: "a = Fm" }),
    ]);
    expect(verifyNumbers(statement(["动量公式"], { kind: "formula", tex: "p = mv" }), newtonZhP3)).toEqual([
      expect.objectContaining({ kind: "formula", text: "p = mv" }),
    ]);

    // Multi-clause English juxtaposed equations stay distinct so each equation keeps its own fingerprint.
    const multiEq = "Momentum is defined by p = mv, and mechanical work is W = Fs.";
    expect(verifyNumbers(statement(["Work equals force times displacement"], { kind: "formula", tex: "W = Fs" }), multiEq)).toEqual([]);
    expect(verifyNumbers(statement(["Wrong work law"], { kind: "formula", tex: "s = WF" }), multiEq)).toEqual([
      expect.objectContaining({ kind: "formula", text: "s = WF" }),
    ]);
  });

  it("checks extended physics/chemistry SI units (J, W, V, A, Ω, Pa, °C, K, mol, L, C) and catches dimension swaps", () => {
    const ph = { kind: "placeholder" as const, hint: "" };
    expect(verifyNumbers(statement(["Bulb consumes 50 J of energy"], ph), "The bulb has a rated power of 50 W.")).toEqual([
      expect.objectContaining({ kind: "number", text: "50 J" }),
    ]);
    expect(verifyNumbers(statement(["Current reaches 220 A"], ph), "Mains voltage is 220 V.")).toEqual([
      expect.objectContaining({ kind: "number", text: "220 A" }),
    ]);
    expect(verifyNumbers(statement(["Work done is 2000 J"], ph), "The engine does 2 kJ of work.")).toEqual([]);
    expect(
      verifyNumbers(
        statement(["Resistance is $120\\,\\Omega$, pressure is 101 kPa, volume is 250 mL, charge is 15 C"], ph),
        "Resistance is 120 Ω, atmospheric pressure is 101 000 Pa, beaker holds 0.25 L, and charge transferred is 15 C at 25 °C (298 K) for 0.5 mol.",
      ),
    ).toEqual([]);
    expect(verifyNumbers(statement(["Temperature is 25 K"], ph), "Room temperature is 25 °C.")).toEqual([
      expect.objectContaining({ kind: "number", text: "25 K" }),
    ]);
  });

  it("preserves + / - sign structure in additive formulas so v = u - at fails against v = u + at", () => {
    const source = "Uniform acceleration velocity equation: $v = u + at$, displacement $s = ut + \\frac{1}{2}at^2$.";
    expect(verifyNumbers(statement(["Velocity increases linearly"], { kind: "formula", tex: "v = u + at" }), source)).toEqual([]);
    expect(verifyNumbers(statement(["Rearranged initial velocity"], { kind: "formula", tex: "u = v - at" }), source)).toEqual([]);
    expect(verifyNumbers(statement(["Wrong sign"], { kind: "formula", tex: "v = u - at" }), source)).toEqual([
      expect.objectContaining({ kind: "formula", text: "v = u - at" }),
    ]);
    expect(verifyNumbers(statement(["Wrong displacement sign"], { kind: "formula", tex: "s = ut - \\frac{1}{2}at^2" }), source)).toEqual([
      expect.objectContaining({ kind: "formula", text: "s = ut - \\frac{1}{2}at^2" }),
    ]);
  });

  it("treats simple fractions/decimals (1/2 ↔ 0.5, 1/4 ↔ 0.25, 3/4 ↔ 0.75) and unit-prefix / round .0 equivalents as matching", () => {
    const ph = { kind: "placeholder" as const, hint: "" };
    expect(verifyNumbers(statement(["Kinetic energy is $E_k = 0.5 m v^2$"], { kind: "formula", tex: "E_k = 0.5 m v^2" }), "Kinetic energy is $E_k = \\frac{1}{2} m v^2$.")).toEqual([]);
    expect(verifyNumbers(statement(["Quarter period is 0.25 T and three quarters is 0.75 T"], ph), "At t = 1/4 T and t = \\frac{3}{4} T the speed changes.")).toEqual([]);
    expect(verifyNumbers(statement(["Cart speed is 20 m/s"], ph), "Measured cart speed is 20.0 m/s.")).toEqual([]);
    expect(verifyNumbers(statement(["Distance is 0.30 km"], ph), "The track length is 300 m.")).toEqual([]);
  });

  it("skips source-page number/formula flags on synthesis slides with empty sources while checking formulas on cited problem slides", () => {
    const cover: SlideContent = { layout: "title", title: "Waves", subtitle: "Chapter 1", objectives: ["Use $v = f\\lambda$ to find speed"] };
    const summary: SlideContent = {
      layout: "summary",
      title: "Key relationships",
      nodes: [
        { head: "Wave speed", detail: "$v = f\\lambda$" },
        { head: "Period", detail: "$T = 1/f$" },
        { head: "Sound in air", detail: "About 340 m/s" },
      ],
    };
    expect(verifyNumbers(cover, "", { pageType: "cover" })).toEqual([]);
    expect(verifyNumbers(summary, "", { pageType: "summary" })).toEqual([]);

    const badWorked: SlideContent = {
      layout: "steps",
      title: "Find wave speed",
      problem: "Find $v$ when $f = 20$ Hz and $\\lambda = 5$ m.",
      steps: [
        { text: "Write $v = f / \\lambda$", why: "Wrong formula" },
        { text: "Calculate $v = 20 / 5 = 4$ m/s", why: "Divide" },
      ],
    };
    expect(verifyNumbers(badWorked, SOURCE, { pageType: "worked" })).toEqual([
      expect.objectContaining({ kind: "formula", text: "v = f / \\lambda" }),
    ]);
  });

  it("ignores ** and == emphasis markers around numbers, units, formulas, and calculations", () => {
    const highlighted = statement(["Sound travels at ==340 m/s== in air", "Ultrasound is above **20 kHz**", "==340 × 3 = 1020 m=="]);
    expect(verifyNumbers(highlighted, SOURCE, { notes: "Check **d = 340 × 3 = 1020 m**\nAlso ==v = 340 m/s==" })).toEqual([]);

    const badHighlighted = statement(["Sound travels at ==343 m/s== in air"]);
    expect(verifyNumbers(badHighlighted, SOURCE)).toEqual([expect.objectContaining({ kind: "number", text: "343" })]);

    const badCalcHighlighted: SlideContent = {
      layout: "steps",
      title: "Find wave speed",
      problem: "Find $v$ when ==f = 5 Hz== and **λ = 0.4 m**.",
      steps: [
        { text: "Substitute: $v = 5 \\times 0.4$", why: "" },
        { text: "Result: ==v = 2.5 m/s==", why: "" },
      ],
    };
    expect(verifyNumbers(badCalcHighlighted, SOURCE, { pageType: "worked" })).toEqual([
      expect.objectContaining({ kind: "calc", text: "v = 5 × 0.4 = 2.5" }),
    ]);
  });
});
