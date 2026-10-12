import { describe, expect, it } from "vitest";
import { LAYOUT_IDS, PAGE_TYPE_IDS, SlideContent } from "@kj/schema";
import { BUDGETS, galleryCells, layoutForPageType, maxBudgetContent, maxBudgetTable, PAGE_TYPE_VISUALS, sampleContent, SLOT_SCHEMAS, stepsOf } from "../src/index.ts";

describe("layouts", () => {
  it("every page type maps to one of the 8 layouts and has at least one visual option", () => {
    for (const t of PAGE_TYPE_IDS) {
      expect(LAYOUT_IDS).toContain(layoutForPageType(t));
      expect(PAGE_TYPE_VISUALS[t].length).toBeGreaterThan(0);
    }
  });

  it("max-budget and sample content satisfy the strict slot schemas", () => {
    for (const layout of LAYOUT_IDS) {
      for (const content of [maxBudgetContent(layout, "en"), maxBudgetContent(layout, "zh"), sampleContent(layout)]) {
        expect(SlideContent.safeParse(content).success, layout).toBe(true);
        const strict = SLOT_SCHEMAS[layout].safeParse(content);
        expect(strict.success, `${layout}: ${strict.error?.issues.map((i) => i.message).join("; ")}`).toBe(true);
      }
    }
  });

  it("rejects content one item or one word over budget", () => {
    const c = maxBudgetContent("statement", "en");
    if (c.layout !== "statement") throw new Error("layout");
    expect(SLOT_SCHEMAS.statement.safeParse({ ...c, bullets: [...c.bullets, "One more point"] }).success).toBe(false);
    const long = Array.from({ length: BUDGETS.statement.title.max + 1 }, () => "word").join(" ");
    expect(SLOT_SCHEMAS.statement.safeParse({ ...c, title: long }).success).toBe(false);
  });

  it("gallery cells (incl. table and 图示待补 variants) satisfy the strict slot schemas", () => {
    const cells = galleryCells();
    expect(cells.length).toBe(LAYOUT_IDS.length * 3 + 5);
    expect(new Set(cells.map((c) => c.id)).size).toBe(cells.length);
    for (const g of cells) {
      const strict = SLOT_SCHEMAS[g.layout].safeParse(g.content);
      expect(strict.success, `${g.id}: ${strict.error?.issues.map((i) => i.message).join("; ")}`).toBe(true);
    }
  });

  it("table slots enforce column count, cell budget and the narrow statement variant", () => {
    const c = maxBudgetContent("statement", "en");
    const ch = maxBudgetContent("chart", "en");
    if (c.layout !== "statement" || ch.layout !== "chart") throw new Error("layout");
    const wide = maxBudgetTable("en");
    expect(SLOT_SCHEMAS.chart.safeParse({ ...ch, chart: wide }).success).toBe(true);
    expect(SLOT_SCHEMAS.statement.safeParse({ ...c, visual: wide }).success).toBe(false);
    expect(SLOT_SCHEMAS.statement.safeParse({ ...c, visual: maxBudgetTable("en", true) }).success).toBe(true);
    const ragged = { ...wide, rows: [...wide.rows.slice(1), ["only one"]] };
    expect(SLOT_SCHEMAS.chart.safeParse({ ...ch, chart: ragged }).success).toBe(false);
    const longCell = { ...wide, rows: [["one two three four", "1", "2"]] };
    expect(SLOT_SCHEMAS.chart.safeParse({ ...ch, chart: longCell }).success).toBe(false);
    expect(SLOT_SCHEMAS.statement.safeParse({ ...c, visual: { kind: "placeholder" } }).success).toBe(true);
  });

  it("counts reveal steps", () => {
    expect(stepsOf(sampleContent("title"))).toBe(0);
    expect(stepsOf(sampleContent("experiment"))).toBeGreaterThan(0);
  });
});
