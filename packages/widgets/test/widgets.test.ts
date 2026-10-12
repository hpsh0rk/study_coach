import { describe, expect, it } from "vitest";
import type { ChartSpec, FunctionSpec } from "@kj/schema";
import { chartOption, compileExpr, ExprError, findEmbed, sampleFunction, validateWidget } from "../src/index.ts";

const palette = { accent: "#00f", series: ["#00f", "#f80"], muted: "#ccc", text: "#111", grid: "#eee", fontFamily: "sans-serif" };

describe("compileExpr", () => {
  it("evaluates arithmetic, powers, functions and constants", () => {
    const f = compileExpr("A*sin(2*pi*x/L) + x^2 - -1", ["x", "A", "L"]);
    expect(f({ x: 0, A: 2, L: 4 })).toBeCloseTo(1);
    expect(f({ x: 1, A: 2, L: 4 })).toBeCloseTo(2 + 1 + 1);
    expect(compileExpr("2^3^2", ["x"])({})).toBe(512);
    expect(compileExpr("-x^2", ["x"])({ x: 3 })).toBe(-9);
    expect(compileExpr("max(1, x, 3)", ["x"])({ x: 7 })).toBe(7);
  });

  it("rejects anything outside the grammar", () => {
    for (const bad of ["process.exit()", "constructor", "x; alert(1)", "y*2", "window['a']", "`x`", "sin x", "Function('x')", "x=1"]) {
      expect(() => compileExpr(bad, ["x"]), bad).toThrow(ExprError);
    }
  });

  it("samples with gaps for non-finite values", () => {
    const pts = sampleFunction("1/x", [-1, 1], {}, 2);
    expect(pts).toEqual([
      [-1, -1],
      [0, null],
      [1, 1],
    ]);
  });
});

describe("validateWidget", () => {
  const fn: FunctionSpec = { kind: "function", expr: "A*sin(k*x)", x: [0, 10], xLabel: "x / m", yLabel: "y / m", params: [{ name: "A", label: "A", min: 0, max: 3, step: 0.1, value: 1 }] };

  it("accepts valid widgets and reports bad expressions or params", () => {
    expect(validateWidget({ ...fn, params: [...fn.params, { name: "k", label: "k", min: 0, max: 5, step: 0.1, value: 1 }] })).toEqual([]);
    expect(validateWidget(fn).map((i) => i.code)).toEqual(["expr"]);
    expect(validateWidget({ ...fn, expr: "A*x", params: [{ ...fn.params[0]!, value: 9 }] }).map((i) => i.code)).toEqual(["param"]);
  });

  it("checks chart data against categories", () => {
    const chart: ChartSpec = { kind: "chart", type: "bar", xLabel: "Medium", yLabel: "Speed / m/s", categories: ["air", "water"], series: [{ name: "v", data: [340, 1500, 3] }] };
    expect(validateWidget(chart).map((i) => i.code)).toEqual(["data"]);
    expect(validateWidget({ ...chart, series: [{ name: "v", data: [340, 1500] }] })).toEqual([]);
  });

  it("rejects unknown embeds", () => {
    expect(validateWidget({ kind: "sim", embedId: "nope" })[0]?.code).toBe("embed");
    expect(validateWidget({ kind: "sim", embedId: "wave-string" })).toEqual([]);
  });
});

describe("chartOption", () => {
  it("greys non-focus series and uses projector-size labels", () => {
    const opt = chartOption(
      { kind: "chart", type: "line", xLabel: "t", yLabel: "v", categories: ["a", "b"], series: [{ name: "A", data: [1, 2] }, { name: "B", data: [2, 1] }], focus: 1 },
      palette,
    ) as { series: { itemStyle: { color: string } }[]; xAxis: { axisLabel: { fontSize: number } } };
    expect(opt.series.map((s) => s.itemStyle.color)).toEqual(["#ccc", "#f80"]);
    expect(opt.xAxis.axisLabel.fontSize).toBeGreaterThanOrEqual(32);
  });
});

describe("findEmbed", () => {
  it("matches catalog topics", () => {
    expect(findEmbed("Measuring wave speed with frequency and wavelength")?.id).toBe("wave-string");
    expect(findEmbed("Photosynthesis")).toBeUndefined();
  });
});
