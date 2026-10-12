import { describe, expect, it } from "vitest";
import { LAYOUT_IDS, PAGE_TYPE_IDS, SlideContent } from "@kj/schema";
import { describeIssue, slotIssues, widgetIssues } from "../src/issues.ts";
import { BUDGETS, layoutForPageType, PAGE_TYPE_VISUALS, SLOT_SCHEMAS, stepsOf } from "../src/index.ts";
import { galleryCells, maxBudgetContent, maxBudgetTable, sampleContent } from "../src/samples.ts";

describe("layouts", () => {
  it("every page type maps to one of the layouts and has at least one visual option", () => {
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
    expect(cells.length).toBe(LAYOUT_IDS.length * 3 + 11);
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
    const quiz = maxBudgetContent("quiz", "en");
    if (quiz.layout !== "quiz") throw new Error("layout");
    expect(stepsOf(quiz)).toBe(1);
    expect(stepsOf({ ...quiz, poll: true })).toBe(2);
    expect(stepsOf(sampleContent("order"))).toBe(1);
  });

  it("order/match, poll and experiment outcome slots", () => {
    expect(layoutForPageType("sequence")).toBe("order");
    const order = maxBudgetContent("order", "en");
    if (order.layout !== "order") throw new Error("layout");
    expect(SLOT_SCHEMAS.order.safeParse({ ...order, mode: "match" }).success).toBe(false);
    expect(SLOT_SCHEMAS.order.safeParse({ ...order, mode: "match", items: order.items.map((i) => ({ ...i, match: "pair" })) }).success).toBe(true);
    expect(SLOT_SCHEMAS.order.safeParse({ ...order, items: order.items.slice(0, 2) }).success).toBe(false);
    expect(slotIssues({ ...order, mode: "match" }).map(describeIssue)).toContain("题目：配对活动：每张卡片都要写上配对的另一半");
    const exp = maxBudgetContent("experiment", "en");
    if (exp.layout !== "experiment") throw new Error("layout");
    expect(SLOT_SCHEMAS.experiment.safeParse({ ...exp, outcome: exp.predict.options.length }).success).toBe(false);
    expect(SLOT_SCHEMAS.experiment.safeParse({ ...exp, outcome: undefined }).success).toBe(true);
  });
});

describe("slot issues for teachers", () => {
  const st = maxBudgetContent("statement", "en");
  if (st.layout !== "statement") throw new Error("layout");

  it("reports both the list-length error and the item errors it hides, in Chinese", () => {
    const issues = slotIssues({ ...st, bullets: ["one", "two", "three", "a fourth bullet that runs far past the eight word budget"] });
    const lines = issues.map(describeIssue);
    expect(lines).toContain("要点：太多：最多 3 条");
    expect(lines).toContain("要点 第 4 条：太长：最多 8 个英文词（约 14 个汉字）");
  });

  it("never repeats the slot name and labels nested fields", () => {
    const long = slotIssues({ ...st, title: "惯性是物体保持原有运动状态不变的性质，一切物体在没有受到外力作用时总保持静止或匀速直线运动" });
    expect(long.map(describeIssue)).toEqual(["标题：太长：最多 15 个英文词（约 26 个汉字）"]);
    expect(describeIssue({ path: ["options", 0, "misconception"], message: "misconception: at most 10 words (about 17 Chinese characters)" })).toBe("选项 第 1 条 · 对应误区：太长：最多 10 个英文词（约 17 个汉字）");
    expect(describeIssue({ path: ["terms", 0], message: "Invalid input: expected object, received string" })).toBe("术语 第 1 条：格式不对：这里需要分成几个小项填写");
  });

  it("widget errors land on the visual slot", () => {
    const issues = widgetIssues({ ...st, visual: { kind: "function", expr: "sin(2*pi*x", x: [0, 4], xLabel: "x", yLabel: "y", params: [] } });
    expect(issues[0]!.path).toEqual(["visual"]);
    expect(describeIssue(issues[0]!)).toMatch(/^图示：表达式算不出来/);
    expect(widgetIssues(st)).toEqual([]);
  });
});
