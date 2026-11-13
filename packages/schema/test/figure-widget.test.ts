import { describe, expect, it } from "vitest";
import {
  ChartContent,
  FigureSpec,
  newId,
  StatementContent,
  VisualKind,
  VisualSpec,
  WidgetSpec,
} from "../src/index.ts";

describe("FigureSpec & VisualKind figure schema", () => {
  it("allocates med_ prefixed asset ids", () => {
    const id = newId("med");
    expect(id).toMatch(/^med_[0-9A-Za-z]{12}$/);
  });

  it("parses valid FigureSpec in VisualSpec, WidgetSpec, StatementContent, and ChartContent", () => {
    const fig = FigureSpec.parse({
      kind: "figure",
      assetId: "med_AbCdEf123456",
      caption: "Fig 16.8: Magnetic field around a solenoid",
      alt: "Solenoid magnetic field lines",
    });
    expect(fig.kind).toBe("figure");
    expect(VisualSpec.parse(fig)).toEqual(fig);
    expect(WidgetSpec.parse(fig)).toEqual(fig);
    expect(VisualKind.parse("figure")).toBe("figure");

    const stmt = StatementContent.parse({
      layout: "statement",
      title: "A current-carrying solenoid acts like a bar magnet",
      bullets: ["Field inside is uniform and parallel"],
      visual: fig,
      terms: [{ term: "solenoid", zh: "螺线管" }],
    });
    expect(stmt.visual).toEqual(fig);

    const chart = ChartContent.parse({
      layout: "chart",
      title: "Plotting compass directions around a bar magnet",
      chart: { kind: "figure", assetId: "med_AbCdEf123456" },
      takeaways: ["Arrows point from North to South"],
      source: "p.704 Fig 16.8",
    });
    expect(chart.chart.kind).toBe("figure");
  });

  it("enforces max length on caption (120) and alt (120) and non-empty assetId", () => {
    expect(FigureSpec.safeParse({ kind: "figure", assetId: "" }).success).toBe(false);
    expect(
      FigureSpec.safeParse({
        kind: "figure",
        assetId: "med_AbCdEf123456",
        caption: "x".repeat(121),
      }).success,
    ).toBe(false);
    expect(
      FigureSpec.safeParse({
        kind: "figure",
        assetId: "med_AbCdEf123456",
        alt: "y".repeat(121),
      }).success,
    ).toBe(false);
  });
});
