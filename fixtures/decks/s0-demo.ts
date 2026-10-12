import type { Color, Deck, Element, Paragraph, Run, Slide, SlideNotes } from "@kj/schema";

/**
 * S0 sample deck (plan §12.2 item 3): bilingual text, term box, table, formula, image,
 * force diagram, PhET experiment, builds and reveal. Hand-authored; ids are deterministic.
 */

let counter = 0;
const id = (prefix: string) => `${prefix}_s0${(++counter).toString(36).padStart(3, "0")}`;

type RunSpec = string | { text: string; lang?: Run["lang"]; marks?: Run["marks"]; math?: string };

function run(spec: RunSpec, base?: Run["marks"]): Run {
  if (typeof spec === "string") {
    const zh = /[\u4e00-\u9fff]/.test(spec);
    return { id: id("r"), text: spec, lang: zh ? "zh" : "en", ...(base ? { marks: base } : {}) };
  }
  return {
    id: id("r"),
    text: spec.text,
    lang: spec.lang ?? (/[\u4e00-\u9fff]/.test(spec.text) ? "zh" : "en"),
    ...(spec.marks || base ? { marks: { ...base, ...spec.marks } } : {}),
    ...(spec.math ? { math: { latex: spec.math } } : {}),
  };
}

function para(runs: RunSpec[], opts: Omit<Partial<Paragraph>, "runs"> & { marks?: Run["marks"] } = {}): Paragraph {
  const { marks, ...rest } = opts;
  return { id: id("p"), level: 0, ...rest, runs: runs.map((r) => run(r, marks)) };
}

const bullet = (runs: RunSpec[], size = 22, level: 0 | 1 = 0) => para(runs, { bullet: { kind: "disc" }, level, spaceAfterPt: 10, marks: { sizePt: level ? size - 3 : size } });

function title(text: RunSpec[], y = 36): Element {
  return {
    id: id("el"),
    type: "text",
    role: "title",
    frame: { x: 48, y, w: 864, h: 64 },
    fit: { mode: "shrinkOnOverflow", minSize: 24 },
    vAlign: "middle",
    body: [para(text, { marks: { sizePt: 32, bold: true, fontRole: "heading", color: "token:primary" } })],
  };
}

const accentBar = (): Element => ({ id: id("el"), type: "shape", role: "decor", geometry: "rect", frame: { x: 48, y: 104, w: 72, h: 4 }, fill: "token:accent" });

function textBox(frame: Element["frame"], body: Paragraph[], extra: Partial<Extract<Element, { type: "text" }>> = {}): Extract<Element, { type: "text" }> {
  return { id: id("el"), type: "text", frame, fit: { mode: "shrinkOnOverflow", minSize: 14 }, body, ...extra };
}

function termBox(frame: Element["frame"], terms: [string, string][]): Element {
  return textBox(
    frame,
    [
      para(["Key terms · 关键术语"], { marks: { sizePt: 16, bold: true, color: "token:secondary" }, spaceAfterPt: 8 }),
      ...terms.map(([en, zh]) => para([{ text: en, marks: { bold: true, sizePt: 18 } }, { text: `  ${zh}`, marks: { color: "token:secondary", sizePt: 17 } }], { spaceAfterPt: 6 })),
    ],
    { fill: "token:surface", radius: 10, padding: 16, role: "terms" },
  );
}

function arrow(x: number, y: number, dx: number, dy: number, color: Color, width = 4): Element {
  // Arrow frames always run from top-left to bottom-right, so flip with rotation for other directions.
  const len = Math.hypot(dx, dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  return {
    id: id("el"),
    type: "shape",
    geometry: "arrow",
    frame: { x: x + dx / 2 - len / 2, y: y + dy / 2, w: len, h: 0, rot: angle },
    stroke: { width, color },
  };
}

function label(x: number, y: number, w: number, runs: RunSpec[], color: Color = "token:text", size = 18): Element {
  return textBox({ x, y, w, h: 30 }, [para(runs, { marks: { sizePt: size, bold: true, color } })], { fit: { mode: "fixed", minSize: 12 } });
}

const notes = (en: string[], zhTerms: [string, string, string?][] = []): SlideNotes => ({
  en,
  zhTerms: zhTerms.map(([term, zh, note]) => ({ term, zh, ...(note ? { note } : {}) })),
});

function slide(layoutId: string, elements: Element[], n: SlideNotes, extra: Partial<Slide> = {}): Slide {
  return {
    id: id("sl"),
    outlineItemId: "oi_s0demo",
    layoutId,
    elements,
    transition: "fade",
    notes: n,
    status: "ready",
    provenance: { aiCallId: "manual-s0", specHash: "s0-demo" },
    ...extra,
  };
}

export const DEMO_ASSETS: Record<string, string> = {
  ast_wavediagram: "/demo-assets/wave-diagram.svg",
  ast_transverse: "/demo-assets/transverse.svg",
  ast_longitudinal: "/demo-assets/longitudinal.svg",
  ast_wavequiz: "/demo-assets/wave-quiz.svg",
};

function build(): Deck {
  counter = 0;
  const slides: Slide[] = [];

  // 1. Title
  slides.push(
    slide(
      "title",
      [
        { id: id("el"), type: "shape", role: "decor", geometry: "rect", frame: { x: 0, y: 0, w: 960, h: 540 }, fill: "token:primary" },
        { id: id("el"), type: "shape", role: "decor", geometry: "ellipse", frame: { x: 640, y: -120, w: 460, h: 460 }, fill: "#ffffff1a" },
        { id: id("el"), type: "shape", role: "decor", geometry: "ellipse", frame: { x: 760, y: 300, w: 300, h: 300 }, fill: "#ffffff12" },
        textBox({ x: 64, y: 120, w: 700, h: 40 }, [para(["IGCSE Physics · Unit 3"], { marks: { sizePt: 20, color: "#bfdbfe", bold: true } })]),
        textBox({ x: 64, y: 168, w: 760, h: 150 }, [
          para([{ text: "Waves", marks: { sizePt: 72, bold: true } }, { text: "  波", marks: { sizePt: 60, bold: true } }], { marks: { color: "token:textOnPrimary", fontRole: "heading" } }),
        ], { vAlign: "bottom" }),
        textBox({ x: 64, y: 330, w: 760, h: 80 }, [
          para(["Properties of waves, wave speed and the electromagnetic spectrum"], { marks: { sizePt: 22, color: "token:textOnPrimary" }, spaceAfterPt: 4 }),
          para(["波的性质、波速与电磁波谱"], { marks: { sizePt: 20, color: "#bfdbfe" } }),
        ]),
      ],
      notes(["Welcome students; today's lesson introduces waves.", "Ask: where have you seen waves today?"], [["wave", "波"]]),
    ),
  );

  // 2. Mixed text + term box (build)
  const terms2 = termBox({ x: 640, y: 128, w: 272, h: 250 }, [
    ["wave", "波"],
    ["energy", "能量"],
    ["medium", "介质"],
    ["oscillation", "振动"],
  ]);
  slides.push(
    slide(
      "title-bullets-terms",
      [
        title(["What is a wave? ", "什么是波？"]),
        accentBar(),
        textBox({ x: 48, y: 128, w: 568, h: 360 }, [
          bullet(["A wave transfers ", { text: "energy", marks: { bold: true, color: "token:primary" } }, " from one place to another — ", { text: "without transferring matter", marks: { italic: true } }, "."]),
          bullet(["The particles of the ", { text: "medium", marks: { bold: true } }, " (介质) only ", { text: "oscillate", marks: { bold: true } }, " about a fixed point."]),
          bullet(["Examples: water ripples 水波, sound 声波, light 光波, seismic waves 地震波."]),
          bullet(["Mechanical waves need a medium; electromagnetic waves can travel through a vacuum (真空)."], 20, 1),
        ]),
        terms2,
      ],
      notes(["Demonstrate with a slinky: energy moves, coils return.", "Stress the difference between energy transfer and matter transfer."], [["medium", "介质", "the material a wave travels through"], ["oscillation", "振动"]]),
      { builds: [{ id: id("b"), order: 1, elementIds: [terms2.id], effect: "fade" }] },
    ),
  );

  // 3. Transverse vs longitudinal, two images
  slides.push(
    slide(
      "two-column",
      [
        title(["Transverse vs longitudinal ", "横波与纵波"]),
        accentBar(),
        { id: id("el"), type: "image", assetId: "ast_transverse", fit: "contain", frame: { x: 48, y: 132, w: 420, h: 190 }, radius: 10, border: { width: 1.5, color: "#cbd5e1" }, alt: "Transverse wave on a rope" },
        { id: id("el"), type: "image", assetId: "ast_longitudinal", fit: "contain", frame: { x: 492, y: 132, w: 420, h: 190 }, radius: 10, border: { width: 1.5, color: "#cbd5e1" }, alt: "Longitudinal wave in a spring" },
        textBox({ x: 48, y: 334, w: 420, h: 160 }, [
          para(["Transverse 横波"], { marks: { sizePt: 22, bold: true, color: "token:primary" }, spaceAfterPt: 6 }),
          bullet(["Oscillation ⟂ direction of energy transfer"], 18),
          bullet(["e.g. light, water waves, S-waves"], 18),
        ]),
        textBox({ x: 492, y: 334, w: 420, h: 160 }, [
          para(["Longitudinal 纵波"], { marks: { sizePt: 22, bold: true, color: "token:secondary" }, spaceAfterPt: 6 }),
          bullet(["Oscillation ∥ direction of energy transfer"], 18),
          bullet(["Compressions 密部 and rarefactions 疏部; e.g. sound"], 18),
        ]),
      ],
      notes(["Use two slinkies side by side.", "Ask students to predict which type sound is."], [["transverse wave", "横波"], ["longitudinal wave", "纵波"], ["compression", "密部"], ["rarefaction", "疏部"]]),
    ),
  );

  // 4. Table
  const cell = (text: string, opts: { bold?: boolean; zh?: string } = {}) => ({
    id: id("cell"),
    body: [para(opts.zh ? [{ text, marks: { bold: !!opts.bold } }, { text: ` ${opts.zh}`, marks: { color: "token:secondary" } }] : [{ text, marks: { bold: !!opts.bold } }], { marks: { sizePt: 18 } })],
  });
  slides.push(
    slide(
      "table",
      [
        title(["Speed of sound in different media ", "声音在不同介质中的速度"]),
        accentBar(),
        {
          id: id("el"),
          type: "table",
          frame: { x: 48, y: 136, w: 560, h: 300 },
          columns: [
            { id: id("col"), width: 220 },
            { id: id("col"), width: 160 },
            { id: id("col"), width: 180 },
          ],
          rows: [
            { id: id("row"), height: 50, header: true, cells: [cell("Medium 介质"), cell("State 状态"), cell("Speed / m s⁻¹")] },
            { id: id("row"), height: 50, cells: [cell("Air (20 °C)", { zh: "空气" }), cell("gas 气体"), cell("343", { bold: true })] },
            { id: id("row"), height: 50, cells: [cell("Water", { zh: "水" }), cell("liquid 液体"), cell("1 480", { bold: true })] },
            { id: id("row"), height: 50, cells: [cell("Glass", { zh: "玻璃" }), cell("solid 固体"), cell("≈ 4 500", { bold: true })] },
            { id: id("row"), height: 50, cells: [cell("Steel", { zh: "钢" }), cell("solid 固体"), cell("≈ 5 900", { bold: true })] },
          ],
        },
        textBox({ x: 636, y: 136, w: 276, h: 300 }, [
          para(["Pattern 规律"], { marks: { sizePt: 20, bold: true, color: "token:primary" }, spaceAfterPt: 8 }),
          para(["Sound travels fastest in solids and slowest in gases: particles are closer together, so vibrations pass on more quickly."], { marks: { sizePt: 17 }, spaceAfterPt: 8 }),
          para(["固体中最快，气体中最慢。"], { marks: { sizePt: 17, color: "token:secondary" } }),
        ], { fill: "token:surface", radius: 10, padding: 18 }),
      ],
      notes(["Ask why sound cannot travel in space.", "Values are typical; exact speeds depend on temperature."], [["medium", "介质"], ["vacuum", "真空"]]),
    ),
  );

  // 5. Formula + worked example + reveal answer
  const answer = textBox({ x: 500, y: 352, w: 412, h: 110 }, [
    para([{ text: "", math: "v = f\\lambda = 50\\,\\text{Hz} \\times 0.40\\,\\text{m}" }], { marks: { sizePt: 22 }, spaceAfterPt: 6 }),
    para([{ text: "v = 20 m/s", marks: { bold: true, color: "token:success", sizePt: 26 } }]),
  ], { fill: "#ecfdf5", radius: 10, padding: 14, role: "answer" });
  slides.push(
    slide(
      "formula",
      [
        title(["The wave equation ", "波速公式"]),
        accentBar(),
        { id: id("el"), type: "formula", latex: "v = f\\,\\lambda", display: true, sizePt: 54, frame: { x: 48, y: 140, w: 420, h: 110 } },
        textBox({ x: 48, y: 260, w: 420, h: 220 }, [
          para([{ text: "v", marks: { bold: true, italic: true } }, " wave speed 波速 (m/s)"], { marks: { sizePt: 20 }, spaceAfterPt: 8 }),
          para([{ text: "f", marks: { bold: true, italic: true } }, " frequency 频率 (Hz)"], { marks: { sizePt: 20 }, spaceAfterPt: 8 }),
          para([{ text: "λ", marks: { bold: true, italic: true } }, " wavelength 波长 (m)"], { marks: { sizePt: 20 }, spaceAfterPt: 8 }),
          para(["Also: ", { text: "", math: "T = \\dfrac{1}{f}" }, "  period 周期"], { marks: { sizePt: 20 } }),
        ]),
        textBox({ x: 500, y: 140, w: 412, h: 150 }, [
          para(["Worked example 例题"], { marks: { sizePt: 18, bold: true, color: "token:primary" }, spaceAfterPt: 6 }),
          para(["A wave on a string has frequency 50 Hz and wavelength 0.40 m. Calculate its speed."], { marks: { sizePt: 19 } }),
        ], { stroke: { width: 1.5, color: "#cbd5e1" }, radius: 10, padding: 14 }),
        answer,
        { id: id("el"), type: "reveal", frame: { x: 600, y: 302, w: 212, h: 40 }, trigger: { kind: "click" }, revealIds: [answer.id], label: "Show answer · 显示答案" },
      ],
      notes(["Do the example live, then reveal.", "Common mistake: forgetting to convert cm to m."], [["frequency", "频率"], ["wavelength", "波长"], ["period", "周期"]]),
    ),
  );

  // 6. Annotated diagram image
  slides.push(
    slide(
      "image",
      [
        title(["Describing a wave ", "描述一列波"]),
        accentBar(),
        { id: id("el"), type: "image", assetId: "ast_wavediagram", fit: "contain", frame: { x: 48, y: 128, w: 600, h: 340 }, radius: 12, border: { width: 1.5, color: "#e2e8f0" }, alt: "Wave with amplitude, wavelength, crest and trough labelled" },
        textBox({ x: 672, y: 128, w: 240, h: 340 }, [
          para([{ text: "Amplitude ", marks: { bold: true } }, "振幅"], { marks: { sizePt: 18 }, spaceAfterPt: 2 }),
          para(["max displacement from rest"], { marks: { sizePt: 15, color: "token:textMuted" }, spaceAfterPt: 12 }),
          para([{ text: "Wavelength ", marks: { bold: true } }, "波长"], { marks: { sizePt: 18 }, spaceAfterPt: 2 }),
          para(["distance between two adjacent crests"], { marks: { sizePt: 15, color: "token:textMuted" }, spaceAfterPt: 12 }),
          para([{ text: "Crest / trough ", marks: { bold: true } }, "波峰 / 波谷"], { marks: { sizePt: 18 }, spaceAfterPt: 2 }),
          para(["highest / lowest points"], { marks: { sizePt: 15, color: "token:textMuted" } }),
        ], { fill: "token:surface", radius: 10, padding: 16 }),
      ],
      notes(["Students copy and label the diagram.", "Amplitude is measured from the rest line, not crest to trough."], [["amplitude", "振幅"], ["crest", "波峰"], ["trough", "波谷"]]),
    ),
  );

  // 7. Force diagram built from shapes
  const bx = 330;
  const by = 250;
  slides.push(
    slide(
      "diagram",
      [
        title(["Forces on a block ", "物块受力分析"]),
        accentBar(),
        { id: id("el"), type: "shape", geometry: "rect", frame: { x: 140, y: 370, w: 520, h: 14 }, fill: "#94a3b8" },
        { id: id("el"), type: "shape", geometry: "roundRect", frame: { x: bx, y: by, w: 140, h: 120 }, fill: "#dbeafe", stroke: { width: 2, color: "token:primary" }, body: [para(["m = 2 kg"], { align: "center", marks: { sizePt: 18, bold: true } })] },
        arrow(bx + 70, by + 120, 0, 110, "token:danger"),
        label(bx + 82, by + 196, 200, ["W = mg 重力"], "token:danger"),
        arrow(bx + 70, by, 0, -110, "token:success"),
        label(bx + 82, by - 116, 200, ["N 支持力"], "token:success"),
        arrow(bx + 140, by + 60, 150, 0, "token:primary"),
        label(bx + 160, by + 22, 180, ["F = 10 N 拉力"], "token:primary"),
        arrow(bx, by + 60, -120, 0, "token:warning"),
        label(bx - 150, by + 22, 150, ["f 摩擦力"], "token:warning"),
        textBox({ x: 700, y: 150, w: 212, h: 200 }, [
          para(["Resultant force 合力"], { marks: { sizePt: 17, bold: true, color: "token:primary" }, spaceAfterPt: 6 }),
          para([{ text: "", math: "F_{net} = F - f" }], { marks: { sizePt: 20 }, spaceAfterPt: 6 }),
          para(["Vertical forces balance: N = W"], { marks: { sizePt: 15 } }),
        ], { fill: "token:surface", radius: 10, padding: 14 }),
      ],
      notes(["Native shapes keep this editable in pptx export.", "Ask which forces are balanced."], [["force", "力"], ["mass", "质量"]]),
    ),
  );

  // 8. PhET experiment
  slides.push(
    slide(
      "experiment",
      [
        title(["Explore: Wave on a String ", "探究：弦上的波"]),
        {
          id: id("el"),
          type: "experiment",
          provider: "phet",
          componentId: "wave-on-a-string",
          params: { locale: "en" },
          frame: { x: 48, y: 108, w: 600, h: 390 },
          fallback: { shortCode: "WAVE-01", caption: { en: "Wave on a String", zh: "弦上的波" } },
          attribution: "PhET Interactive Simulations, University of Colorado Boulder (CC BY 4.0)",
        },
        textBox({ x: 668, y: 108, w: 244, h: 390 }, [
          para(["Try this 试一试"], { marks: { sizePt: 18, bold: true, color: "token:primary" }, spaceAfterPt: 8 }),
          para(["Set damping to zero.", " 阻尼调为 0。"], { bullet: { kind: "number" }, marks: { sizePt: 16 }, spaceAfterPt: 8 }),
          para(["Increase the frequency — what happens to λ?"], { bullet: { kind: "number" }, marks: { sizePt: 16 }, spaceAfterPt: 8 }),
          para(["Increase tension 张力 — what happens to v?"], { bullet: { kind: "number" }, marks: { sizePt: 16 }, spaceAfterPt: 8 }),
          para(["Use the ruler and timer to measure v = fλ."], { bullet: { kind: "number" }, marks: { sizePt: 16 } }),
        ], { fill: "token:surface", radius: 10, padding: 16 }),
      ],
      notes(["Students work in pairs for 8 minutes.", "Self-hosted copy so it works when the school blocks external sites."], [["damping", "阻尼"], ["tension", "张力"]]),
      { transition: "push" },
    ),
  );

  // 9. Step-by-step builds
  const steps = [
    ["1", "Set up the ripple tank with a lamp above it.", "安装水波槽和光源"],
    ["2", "Measure across 10 wavefronts to find λ.", "测量 10 个波前求波长"],
    ["3", "Count waves passing a point in 10 s to find f.", "数 10 秒内通过的波数求频率"],
    ["4", "Calculate v = fλ and repeat.", "计算 v = fλ 并重复"],
  ] as const;
  const stepEls = steps.map(([n, en, zh], i): Element =>
    textBox({ x: 48, y: 130 + i * 92, w: 864, h: 80 }, [
      para([{ text: `${n}  `, marks: { bold: true, color: "token:accent", sizePt: 26 } }, { text: en, marks: { sizePt: 21 } }], { spaceAfterPt: 2 }),
      para([{ text: `    ${zh}`, marks: { sizePt: 17, color: "token:secondary" } }]),
    ], { fill: i % 2 ? "#ffffff" : "token:surface", radius: 10, padding: 12, vAlign: "middle" }),
  );
  slides.push(
    slide(
      "steps",
      [title(["Measuring wave speed: ripple tank ", "用水波槽测波速"]), ...stepEls],
      notes(["Press → to reveal each step.", "Step 4 is highlighted to emphasise repeats."], [["wavefront", "波前"]]),
      {
        builds: [
          { id: id("b"), order: 1, elementIds: [stepEls[1]!.id], effect: "fade" },
          { id: id("b"), order: 2, elementIds: [stepEls[2]!.id], effect: "fade" },
          { id: id("b"), order: 3, elementIds: [stepEls[3]!.id], effect: "fade" },
          { id: id("b"), order: 4, elementIds: [stepEls[3]!.id], effect: "highlight" },
        ],
      },
    ),
  );

  // 10. Hotspot quiz
  const ansA = label(560, 150, 340, ["A = crest 波峰"], "token:primary", 20);
  const ansB = label(560, 200, 340, ["B = trough 波谷"], "token:primary", 20);
  const ansC = label(560, 250, 340, ["C = wavelength 波长"], "token:primary", 20);
  slides.push(
    slide(
      "quiz",
      [
        title(["Check your understanding ", "小测验"]),
        accentBar(),
        { id: id("el"), type: "image", assetId: "ast_wavequiz", fit: "contain", frame: { x: 48, y: 130, w: 480, h: 272 }, radius: 10, border: { width: 1.5, color: "#e2e8f0" }, alt: "Unlabelled wave for the quiz" },
        { id: id("el"), type: "reveal", frame: { x: 94, y: 176, w: 36, h: 36 }, trigger: { kind: "hotspot" }, revealIds: [ansA.id], label: "A" },
        { id: id("el"), type: "reveal", frame: { x: 190, y: 344, w: 36, h: 36 }, trigger: { kind: "hotspot" }, revealIds: [ansB.id], label: "B" },
        { id: id("el"), type: "reveal", frame: { x: 190, y: 139, w: 36, h: 36 }, trigger: { kind: "hotspot" }, revealIds: [ansC.id], label: "C" },
        ansA,
        ansB,
        ansC,
        textBox({ x: 560, y: 320, w: 352, h: 150 }, [
          para(["Tap A, B and C to check. 点击 A、B、C 查看答案。"], { marks: { sizePt: 17, color: "token:textMuted" }, spaceAfterPt: 10 }),
          para(["Exit ticket: a wave has f = 2 Hz and λ = 3 m. What is v?"], { marks: { sizePt: 18, bold: true } }),
        ]),
      ],
      notes(["Cold-call three students for A, B, C.", "Exit ticket answer: 6 m/s."], [["crest", "波峰"], ["trough", "波谷"]]),
    ),
  );

  return {
    id: "deck_s0demo",
    schemaVersion: 2,
    projectId: "prj_s0demo",
    version: 1,
    title: "S0 demo · Waves 波",
    theme: { themeId: "classic-blue", themeVersion: 1 },
    outlineVersionId: "ol_s0demo",
    slides,
  };
}

export const s0DemoDeck: Deck = build();
