import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { LAYOUT_IDS, type ChartSpec, type SlideContent } from "@kj/schema";
import { CANVAS, FONT } from "@kj/templates";
import { galleryCells, maxBudgetContent, sampleContent } from "@kj/templates/testing";
import { exportPptx, overflowingSlots, planSlide, shuffledOrder, texToText, type Item, type SlidePlan, type TextItem } from "../src/index.ts";

const plan = (content: SlideContent, notes = "", extra: { sources?: number[] } = {}) => planSlide({ content, notes, sources: extra.sources ?? [], unverified: [] }, { theme: "classic" });
const texts = (p: SlidePlan) => p.items.filter((i): i is TextItem => i.kind === "text");
const onSlide = (p: SlidePlan) => texts(p).flatMap((t) => t.paras.flatMap((q) => q.runs.map((r) => r.text))).join("\n");
const inside = (it: Item) => it.rect.x >= 0 && it.rect.y >= 0 && it.rect.x + it.rect.w <= CANVAS.width && it.rect.y + it.rect.h <= CANVAS.height;
/** Labels, chips and panels the HTML deck also sets below body size. */
const LABEL_SLOTS = /^(sources|badge|terms\.|source$|explain$|sim$|visual$|chart$|.*\.caption$)/;

describe("layout mapping", () => {
  const cells = galleryCells();

  it("maps every gallery cell (all 9 layouts, max budgets in English and Chinese) inside the 16:9 canvas with no estimated overflow", () => {
    expect(new Set(cells.map((c) => c.layout))).toEqual(new Set(LAYOUT_IDS));
    for (const c of cells) {
      const p = plan(c.content, "", { sources: [3] });
      expect(p.items.length, c.id).toBeGreaterThan(1);
      for (const it of p.items) expect(inside(it), `${c.id} ${it.kind} ${"slot" in it ? it.slot : ""}`).toBe(true);
      expect(overflowingSlots(p), c.id).toEqual([]);
    }
  });

  it("keeps text native and editable: no slide becomes a picture, student text stays ≥ 48px (labels like 'why' excepted)", () => {
    for (const c of cells) {
      const p = plan(c.content);
      expect(p.items.some((i) => i.kind === "image"), c.id).toBe(false);
      for (const t of texts(p)) {
        if (LABEL_SLOTS.test(t.slot)) continue;
        for (const para of t.paras.filter((q) => (q.runs[0]?.scale ?? 1) >= 1)) expect(t.fontPx * (para.runs[0]?.scale ?? 1), `${c.id} ${t.slot}`).toBeGreaterThanOrEqual(FONT.bodyMin - 0.01);
      }
    }
  });

  it("puts each slot in its own named text box", () => {
    const slots = (layout: (typeof LAYOUT_IDS)[number]) => texts(plan(maxBudgetContent(layout, "zh"))).map((t) => t.slot);
    expect(slots("title")).toEqual(expect.arrayContaining(["title", "subtitle", "objectives"]));
    expect(slots("statement")).toEqual(expect.arrayContaining(["title", "bullets", "terms.0", "terms.1"]));
    expect(slots("chart")).toEqual(expect.arrayContaining(["title", "takeaways", "source"]));
    expect(slots("steps")).toEqual(expect.arrayContaining(["title", "problem", "steps.0", "steps.3"]));
    expect(slots("experiment")).toEqual(expect.arrayContaining(["title", "predict.question", "predict.options.0", "observe", "explain"]));
    expect(slots("quiz")).toEqual(expect.arrayContaining(["question", "options.0", "options.3"]));
    expect(slots("questions")).toEqual(expect.arrayContaining(["title", "items.0.q", "items.3.q"]));
    expect(slots("order")).toEqual(expect.arrayContaining(["title", "items.0", "items.4"]));
    expect(slots("summary")).toEqual(expect.arrayContaining(["title", "nodes.0", "nodes.3"]));
  });

  it("shows the textbook pages with their printed labels", () => {
    const p = planSlide({ content: sampleContent("statement"), notes: "", sources: [14, 15] }, { theme: "classic", pageLabels: { 14: "xii", 15: "1" } });
    expect(onSlide(p)).toContain("教材 p. xii, 1");
  });
});

describe("speaker notes and interactive pieces", () => {
  const quiz: Extract<SlideContent, { layout: "quiz" }> = {
    layout: "quiz",
    question: "A wave has f = 5 Hz and λ = 2 m. What is its speed?",
    options: [
      { text: "2.5 m/s", misconception: "Divides instead of multiplying" },
      { text: "10 m/s", misconception: "" },
      { text: "7 m/s", misconception: "Adds the two values" },
      { text: "0.4 m/s", misconception: "Inverts the ratio" },
    ],
    answer: 1,
    explain: "v = fλ = 5 × 2 = 10 m/s",
  };

  it("teacher notes come first, then answers that never appear on the slide", () => {
    const q = quiz;
    const p = plan(q, "Ask two students first.");
    expect(p.notes.startsWith("Ask two students first.")).toBe(true);
    expect(p.notes).toContain(`答案 Answer：${"ABCD"[q.answer]}.`);
    expect(onSlide(p)).not.toContain(q.explain);
    for (const o of q.options) if (o.misconception) expect(onSlide(p)).not.toContain(o.misconception);
  });

  it("questions keep answers in the notes only", () => {
    const c: SlideContent = { layout: "questions", title: "Quick recall", items: [{ q: "Name the unit of frequency.", a: "hertz" }, { q: "What does a wave transfer?", a: "energy, not matter" }] };
    const p = plan(c);
    for (const it of c.items) {
      expect(p.notes).toContain(it.a);
      expect(onSlide(p)).not.toContain(it.a);
    }
  });

  it("a hinge poll becomes the question plus how to run the vote", () => {
    const p = plan({ ...quiz, poll: true });
    expect(p.degraded).toContain("poll");
    expect(p.notes).toContain("先投票");
  });

  it("order cards are shuffled with no card in place; the correct order is in the notes", () => {
    const c = maxBudgetContent("order", "en");
    if (c.layout !== "order") throw new Error();
    const p = plan(c);
    const cards = texts(p).filter((t) => /^items\.\d+$/.test(t.slot));
    expect(cards).toHaveLength(c.items.length);
    cards.forEach((t, pos) => expect(t.slot).not.toBe(`items.${pos}`));
    expect(cards.map((t) => t.slot)).toEqual(shuffledOrder(c.items.map((i) => i.text)).map((i) => `items.${i}`));
    expect(p.degraded).toContain("order");
    expect(p.notes).toContain("正确顺序");
  });

  it("match mode shuffles the right-hand cards and lists the pairs in the notes", () => {
    const cell = galleryCells().find((c) => c.id === "order-match-en")!;
    const p = plan(cell.content);
    expect(p.notes).toContain("配对 Matches");
    expect(texts(p).filter((t) => t.slot.endsWith(".match"))).toHaveLength((cell.content as { items: unknown[] }).items.length);
  });

  it("an experiment keeps prediction and observation on the slide, the explanation and outcome in the notes, and the sim as a labelled panel", () => {
    const c: Extract<SlideContent, { layout: "experiment" }> = {
      layout: "experiment",
      title: "Shake the string faster",
      predict: { question: "What happens to the wavelength?", options: ["Longer", "Shorter", "Same"] },
      sim: { kind: "sim", embedId: "wave-string" },
      observe: ["Count the peaks"],
      explain: "Speed is fixed by the string, so higher f means shorter λ",
    };
    const p = plan({ ...c, outcome: 1 });
    expect(p.degraded).toEqual(expect.arrayContaining(["sim", "poe"]));
    expect(onSlide(p)).toContain("弦上的波");
    expect(onSlide(p)).not.toContain(c.explain);
    expect(p.notes).toContain(`实际结果 Outcome：B.`);
    expect(p.notes).toContain("POE");
  });

  it("faded steps show blank boxes and keep the missing steps in the notes", () => {
    const c: SlideContent = { layout: "steps", title: "Wave speed", problem: "f = 5 Hz, λ = 2 m. Find v.", steps: [{ text: "Write v = fλ", why: "" }, { text: "v = 5 × 2", why: "substitute" }, { text: "v = 10 m/s", why: "" }], fadeFrom: 1 };
    const p = plan(c);
    expect(texts(p).find((t) => t.slot === "steps.1")!.paras[0]!.runs[0]!.text).toBe("？");
    expect(onSlide(p)).not.toContain("v = 5 × 2");
    expect(p.notes).toContain("2. v = 5 × 2（substitute）");

    const { fadeFrom: _missing, ...malformed } = c;
    const closed = planSlide({ content: malformed, notes: "", sources: [], unverified: [], pageType: "faded" }, { theme: "classic" });
    expect(texts(closed).find((t) => t.slot === "steps.2")!.paras[0]!.runs[0]!.text).toBe("？");
    expect(onSlide(closed)).not.toContain("v = 10 m/s");
    expect(closed.notes).toContain("3. v = 10 m/s");
  });

  it("lists 待核实 items in the notes", () => {
    const p = planSlide({ content: sampleContent("statement"), notes: "", sources: [], unverified: [{ kind: "number", text: "340 m/s", detail: "not on p. 12" }] }, { theme: "classic" });
    expect(p.notes).toContain("待核实 To verify：340 m/s（not on p. 12）");
  });
});

describe("charts, tables and formulas", () => {
  const chartSlide = (chart: Extract<SlideContent, { layout: "chart" }>["chart"]) => plan({ layout: "chart", title: "T", chart, takeaways: ["One"], source: "" });
  const bar: ChartSpec = { kind: "chart", type: "bar", xLabel: "Region", yLabel: "Count", categories: ["A", "B", "C"], series: [{ name: "n", data: [1, 2, 3] }] };

  it("category data becomes a native bar / line chart", () => {
    const it = chartSlide(bar).items.find((i) => i.kind === "chart");
    expect(it).toMatchObject({ type: "bar", series: [{ labels: ["A", "B", "C"], values: [1, 2, 3] }], dataLabels: true });
    const line = chartSlide({ ...bar, type: "line", series: [bar.series[0]!, { name: "m", data: [3, 2, 1] }], focus: 0 }).items.find((i) => i.kind === "chart");
    expect(line).toMatchObject({ type: "line", dataLabels: false });
  });

  it("[x, y] series sharing x become a native scatter; mismatched x falls back to a picture with the data as text", () => {
    const shared = chartSlide({ ...bar, type: "scatter", categories: undefined, series: [{ name: "a", data: [[0, 1], [1, 2]] }, { name: "b", data: [[0, 2], [1, 3]] }] });
    expect(shared.items.find((i) => i.kind === "chart")).toMatchObject({ type: "scatter", x: [0, 1] });
    const mixed = chartSlide({ ...bar, type: "scatter", categories: undefined, series: [{ name: "a", data: [[0, 1], [1, 2]] }, { name: "b", data: [[0.5, 2]] }] });
    const img = mixed.items.find((i) => i.kind === "image");
    expect(img?.kind).toBe("image");
    if (img?.kind === "image") expect(img.fallback.paras.map((p) => p.runs[0]!.text).join(" ")).toContain("(0.5, 2)");
  });

  it("a function plot becomes a native curve at the sliders' starting values; a curve with a break becomes a picture", () => {
    const c = maxBudgetContent("statement", "en");
    const p = plan(c);
    const ch = p.items.find((i) => i.kind === "chart");
    expect(ch).toMatchObject({ type: "scatter", smoothLine: true });
    expect(p.degraded).toContain("function-sliders");
    const broken = chartSlide({ kind: "function", expr: "1/x", x: [-2, 2], y: [-5, 5], xLabel: "x", yLabel: "y", params: [] });
    expect(broken.items.some((i) => i.kind === "image")).toBe(true);
  });

  it("tables become native tables with a header row", () => {
    const cell = galleryCells().find((c) => c.id === "chart-table-zh")!;
    const t = plan(cell.content).items.find((i) => i.kind === "table");
    const spec = (cell.content as Extract<SlideContent, { layout: "chart" }>).chart;
    if (t?.kind !== "table" || spec.kind !== "table") throw new Error("no table");
    expect(t.header).toEqual(spec.columns);
    expect(t.rows).toEqual(spec.rows);
  });

  it("formulas become readable Unicode text with the TeX kept in the notes, and non-exact display formulas emit an ImageItem with clean text fallback", async () => {
    expect(texToText("v = f\\lambda").text).toBe("v = fλ");
    expect(texToText("E_k = \\frac{1}{2}mv^2").text).toBe("Eₖ = 1/2mv²");
    expect(texToText("a = \\frac{\\Delta v}{t}").text).toBe("a = (Δ v)/t");
    expect(texToText("x_{1} + 10^{-3}").text).toBe("x₁ + 10⁻³");
    expect(texToText("\\sqrt{2gh}").text).toBe("√(2gh)");
    expect(texToText("\\oint B").exact).toBe(false);

    // Upgraded vectors, extensible reaction arrows, cases environments, and multi-char/CJK subscripts
    const vec = texToText("\\vec{F}_{\\text{合}} = m\\vec{a}");
    expect(vec.text).toContain("F\u20d7");
    expect(vec.text).toContain("a\u20d7");
    expect(vec.text).not.toContain("_(");
    expect(vec.exact).toBe(false);

    const arrow = texToText("2\\text{H}_2 + \\text{O}_2 \\xrightarrow{\\text{点燃}} 2\\text{H}_2\\text{O}");
    expect(arrow.text).toBe("2H₂ + O₂ —[点燃]→ 2H₂O");
    expect(arrow.text).not.toContain("xrightarrow");
    expect(arrow.exact).toBe(false);

    const cases = texToText("f(x) = \\begin{cases} x^2, & x \\ge 0 \\\\ -x, & x < 0 \\end{cases}");
    expect(cases.text).toBe("f(x) = { x², x ≥ 0; -x, x < 0 }");
    expect(cases.text).not.toContain("begincases");
    expect(cases.exact).toBe(false);

    // Exact formula stays a native TextItem
    const p = plan({ layout: "statement", title: "T", bullets: ["Speed is $v = f\\lambda$"], visual: { kind: "formula", tex: "v = f\\lambda" }, terms: [] });
    expect(onSlide(p)).toContain("Speed is v = fλ");
    expect(p.items.some((i) => i.kind === "image")).toBe(false);
    expect(p.notes).toContain("公式原文（LaTeX）：v = f\\lambda");

    // Non-exact display formula emits an ImageItem whose fallback is clean texToText, and embeds PNG when snapshotter is supplied
    const complexFormulaSlide = {
      content: {
        layout: "statement" as const,
        title: "化学方程式与分段函数",
        bullets: ["反应：$2\\text{H}_2 + \\text{O}_2 \\xrightarrow{\\text{点燃}} 2\\text{H}_2\\text{O}$"],
        visual: { kind: "formula" as const, tex: "f(x) = \\begin{cases} x^2, & x \\ge 0 \\\\ -x, & x < 0 \\end{cases}", caption: "分段函数定义" },
        terms: [],
      },
      notes: "先引导观察 $v = f\\lambda$ 与 $\\lambda = v/f$ 的变形。",
      sources: [1],
      unverified: [],
      pageType: "concept" as const,
    };
    const complexPlan = planSlide(complexFormulaSlide, { theme: "classic", language: "zh" });
    expect(complexPlan.degraded).toContain("formula-approx");
    const formulaImg = complexPlan.items.find((i) => i.kind === "image" && i.slot === "visual");
    expect(formulaImg?.kind).toBe("image");
    if (formulaImg?.kind === "image") {
      expect(formulaImg.fallback.paras[0]!.runs[0]!.text).toBe("f(x) = { x², x ≥ 0; -x, x < 0 }");
    }
    // Speaker notes run plain() on teacher notes (no raw $v = f\lambda$) while keeping explicit raw LaTeX reference line
    expect(complexPlan.notes.split("\n")[0]).toBe("先引导观察 v = fλ 与 λ = v/f 的变形。");
    expect(complexPlan.notes).toContain("公式原文（LaTeX）：f(x) = \\begin{cases}");

    // Headless export without snapshotter falls back gracefully to text box; export with snapshotter embeds PNG
    const headlessPptx = await exportPptx({ title: "Headless", theme: "classic", language: "zh", slides: [complexFormulaSlide] });
    const headlessZip = await JSZip.loadAsync(headlessPptx.data);
    expect(Object.keys(headlessZip.files).filter((n) => n.startsWith("ppt/media/") && !headlessZip.files[n]!.dir)).toEqual([]);
    expect(await headlessZip.file("ppt/slides/slide1.xml")!.async("string")).toContain("f(x) = { x², x ≥ 0; -x, x &lt; 0 }");

    const png1px = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const snappedPptx = await exportPptx({ title: "Snapped", theme: "classic", language: "zh", slides: [complexFormulaSlide] }, { chartImage: async () => png1px });
    const snappedZip = await JSZip.loadAsync(snappedPptx.data);
    expect(Object.keys(snappedZip.files).some((n) => n.startsWith("ppt/media/") && !snappedZip.files[n]!.dir)).toBe(true);
  });

  it("applies plain() to chart series names, function labels, and fallback text, and localizes auto-appended notes headers by language", () => {
    const mathChart = planSlide(
      {
        content: {
          layout: "chart",
          title: "Speed comparison",
          chart: {
            kind: "chart",
            type: "bar",
            xLabel: "Medium",
            yLabel: "Speed $v$ / (m/s)",
            categories: ["Air $20^\\circ\\text{C}$", "Water"],
            series: [{ name: "Wave speed $v = f\\lambda$", data: [340, 1480] }],
          },
          takeaways: ["Water is faster"],
          source: "",
        },
        notes: "Check $v = f\\lambda$ units.",
        sources: [],
        unverified: [],
      },
      { theme: "classic", language: "en" },
    );
    const chartItem = mathChart.items.find((i) => i.kind === "chart");
    expect(chartItem?.kind === "chart" && chartItem.series[0]!.name).toBe("Wave speed v = fλ");
    expect(chartItem?.kind === "chart" && chartItem.series[0]!.labels[0]).toBe("Air 20°C");
    expect(mathChart.notes).toContain("Check v = fλ units.");
    expect(mathChart.notes).toContain("[Interactions — differences from HTML deck]");
    expect(mathChart.notes).not.toContain("【互动");

    const zhQuiz = planSlide(
      {
        content: {
          layout: "quiz",
          question: "频率翻倍时波长如何变化？",
          options: [
            { text: "减半", misconception: "" },
            { text: "加倍", misconception: "误以为成正比" },
            { text: "不变", misconception: "忽略波速公式" },
          ],
          answer: 0,
          explain: "波速不变时 $\\lambda = v/f$。",
          poll: true,
        },
        notes: "先提问公式 $v = f\\lambda$。",
        sources: [],
        unverified: [],
      },
      { theme: "classic", language: "zh" },
    );
    expect(zhQuiz.notes).toContain("先提问公式 v = fλ。");
    expect(zhQuiz.notes).toContain("【答案 · 只在讲稿里】");
    expect(zhQuiz.notes).not.toContain("Answer：");
    expect(zhQuiz.notes).not.toContain("Hinge poll:");
  });
});

describe("the .pptx file", () => {
  it("has one 16:9 slide per deck slide, PingFang SC text, native charts and tables, and speaker notes", async () => {
    const slides = galleryCells().map((c) => ({ content: c.content, notes: `notes for ${c.id}`, sources: [12], pageType: "concept" as const }));
    const r = await exportPptx({ title: "波的性质：测试", theme: "chalk", slides });
    expect(r.filename).toBe("波的性质：测试.pptx");
    expect(r.overflow).toEqual([]);
    const zip = await JSZip.loadAsync(r.data);
    const names = Object.keys(zip.files);
    expect(names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(slides.length);
    expect(names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))).toHaveLength(slides.length);
    expect(names.some((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))).toBe(true);
    expect(names.filter((n) => n.startsWith("ppt/media/") && !zip.files[n]!.dir)).toEqual([]);
    expect(names.some((n) => n.startsWith("ppt/embeddings/") && n.endsWith(".xlsx"))).toBe(true);
    const pres = await zip.file("ppt/presentation.xml")!.async("string");
    expect(pres).toContain('<p:sldSz cx="12192000" cy="6858000"');
    const s1 = await zip.file("ppt/slides/slide1.xml")!.async("string");
    expect(s1).toContain('<a:ea typeface="PingFang SC"');
    expect(s1).toContain('lang="zh-CN"');
    const tableSlide = galleryCells().findIndex((c) => c.id === "chart-table-zh") + 1;
    expect(await zip.file(`ppt/slides/slide${tableSlide}.xml`)!.async("string")).toContain("<a:tbl>");
    const n1 = await zip.file("ppt/notesSlides/notesSlide1.xml")!.async("string");
    expect(n1).toContain("notes for title-sample");
    expect(n1).toContain("PingFang SC");
  });
});
