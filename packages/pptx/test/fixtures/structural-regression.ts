import type { PptxDeck } from "../../src/index.ts";

export const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export const structuralDeck = {
  title: "PPTX 结构回归",
  theme: "classic",
  pageLabels: { 14: "xii", 15: "1" },
  slides: [
    {
      content: {
        layout: "statement",
        title: "01 波速 Ω <来源>",
        bullets: ["速度 = 340.5 m/s", "保留 & 符号"],
        visual: { kind: "function", expr: "1/x", x: [-2, 2], y: [-5, 5], xLabel: "x", yLabel: "y", params: [] },
        terms: [],
      },
      notes: "NOTE-01：出处与媒体",
      sources: [14, 15],
      unverified: [],
      pageType: "concept",
    },
    {
      content: {
        layout: "quiz",
        question: "02 Which value is exact?",
        options: [
          { text: "0.25", misconception: "MISCONCEPTION-A-SECRET" },
          { text: "0.50", misconception: "" },
          { text: "0.75", misconception: "MISCONCEPTION-C-SECRET" },
          { text: "1.00", misconception: "" },
        ],
        answer: 2,
        explain: "ANSWER-EXPLANATION-SECRET",
        poll: true,
      },
      notes: "NOTE-02：先作答",
      sources: [],
      unverified: [],
      pageType: "check",
    },
    {
      content: {
        layout: "chart",
        title: "03 原生图表",
        chart: {
          kind: "chart",
          type: "bar",
          xLabel: "类别",
          yLabel: "精确值",
          categories: ["甲&乙", "β<γ", "零"],
          series: [{ name: "测量值", data: [0.125, -3.5, 1200] }],
        },
        takeaways: ["保留小数与负数"],
        source: "实验记录 #7",
      },
      notes: "NOTE-03：图表数据",
      sources: [],
      unverified: [],
      pageType: "data",
    },
    {
      content: {
        layout: "chart",
        title: "04 原生表格",
        chart: {
          kind: "table",
          columns: ["量 & 单位", "精确值"],
          rows: [
            ["速度 <v>", "340.5 m/s"],
            ["频率 f", "2.50 Hz"],
          ],
          caption: "TABLE-CAPTION-04",
        },
        takeaways: ["文本与数字保持原样"],
        source: "",
      },
      notes: "NOTE-04：表格数据",
      sources: [],
      unverified: [],
      pageType: "data",
    },
  ],
} satisfies PptxDeck;

export const slideMarkers = ["01 波速 Ω <来源>", "02 Which value is exact?", "03 原生图表", "04 原生表格"];
