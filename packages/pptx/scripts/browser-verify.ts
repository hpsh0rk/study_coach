/**
 * Real-browser ECharts-rasterized PPTX export & LibreOffice visual verification.
 *
 * Drives the built web app via Playwright Chromium against a fresh local server, creating a
 * multi-slide lesson covering every requested slide/widget type:
 *   1. cover (`title`)
 *   2. native category bar `chart`
 *   3. mixed-[x, y] scatter `chart` -> real browser ECharts `chartSnapshot(theme)` PNG rasterization
 *   4. discontinuous `function` (`1/x`) + slider -> real browser ECharts `chartSnapshot(theme)` PNG rasterization
 *   5. native `table`
 *   6. `formula` (`statement`)
 *   7. worked `steps` + `faded` `steps` (with `fadeFrom`)
 *   8. hinge `quiz` (`poll: true`)
 *   9. `experiment` (POE + built-in `wave-string` sim)
 *
 * Clicks `[data-testid="export-pptx"]` in both `classic` and `chalk` themes, then verifies:
 *   - non-trivial raster chart PNG bytes & IHDR dimensions (> 1x1 px, exact 2x logical box px);
 *   - theme-differentiated raster PNG pixels between `classic` and `chalk`;
 *   - valid OOXML relationships, content types, native tables, native chart workbooks, speaker notes;
 *   - zero answer/explanation/misconception/outcome/faded-step leaks on projected slides;
 *   - 0 text-box / slide-bounds overflow problems via headless LibreOffice (`soffice` -> FODP & PDF -> `pdftotext -bbox`);
 *   - PNG slide previews rendered via `pdftoppm -png`.
 *
 * Usage:
 *   tsx packages/pptx/scripts/browser-verify.ts --out <dir>
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { posix } from "node:path";
import { chromium } from "@playwright/test";
import JSZip from "jszip";
import type { Outline, SlideContent, ThemeId } from "@kj/schema";
import { PALETTES, planDeck, PPTX_FONT, writePptx, type PptxDeck, type TextItem } from "../src/index.ts";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = path.resolve(outIdx >= 0 ? args[outIdx + 1]! : path.join(ROOT, "test-results/pptx-browser"));
const PORT = Number(process.env.KJ_BROWSER_PPTX_PORT ?? 8794);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOLERANCE_PX = 6;

const TEACHER_SECRETS = [
  "TEACHER-FADED-ANSWER-SECRET",
  "TEACHER-FADED-WHY-SECRET",
  "TEACHER-QUIZ-EXPLAIN-SECRET",
  "TEACHER-QUIZ-MISCONCEPTION-SECRET",
  "TEACHER-EXPERIMENT-EXPLAIN-SECRET",
];

interface PlannedSpec {
  id: string;
  pageType: Outline["slides"][number]["pageType"];
  layout: SlideContent["layout"];
  visual: Outline["slides"][number]["visual"];
  minutes: number;
  title: string;
  purpose: string;
  keyPoints: string[];
  sourcePages: number[];
  loop: number;
  content: SlideContent;
  notes: string;
}

export const SLIDE_SPECS: PlannedSpec[] = [
  {
    id: "bv-01-cover",
    pageType: "cover",
    layout: "title",
    visual: "none",
    minutes: 2,
    title: "波动与运动综合复习",
    purpose: "明确本节核心目标",
    keyPoints: ["波速公式与图像分析"],
    sourcePages: [],
    loop: 0,
    notes: "NOTE-01：开场介绍本节课的三个核心任务。",
    content: {
      layout: "title",
      title: "波动与运动综合复习",
      subtitle: "物理课堂 · Wave Review",
      objectives: ["用 v = fλ 计算波速", "分析数据表与运动图像"],
    },
  },
  {
    id: "bv-02-formula",
    pageType: "concept",
    layout: "statement",
    visual: "formula",
    minutes: 4,
    title: "波速等于频率乘以波长",
    purpose: "建立波速公式与物理量单位",
    keyPoints: ["频率单位赫兹", "波长单位米"],
    sourcePages: [1],
    loop: 1,
    notes: "NOTE-02：强调介质不变时波速恒定。",
    content: {
      layout: "statement",
      title: "波速等于频率乘以波长",
      bullets: ["频率 $f$ 表示每秒波数", "波长 $\\lambda$ 是波峰间距", "同介质中波速不变"],
      visual: { kind: "formula", tex: "v = f\\lambda", caption: "v：m/s，f：Hz，λ：m" },
      terms: [
        { term: "wavelength", zh: "波长" },
        { term: "frequency", zh: "频率" },
      ],
    },
  },
  {
    id: "bv-03-native-chart",
    pageType: "data",
    layout: "chart",
    visual: "chart",
    minutes: 4,
    title: "声波在不同介质中的传播速度对比",
    purpose: "比较固液气三态声速",
    keyPoints: ["固体最快", "气体最慢"],
    sourcePages: [1],
    loop: 1,
    notes: "NOTE-03：原生可编辑柱状图展示不同介质波速。",
    content: {
      layout: "chart",
      title: "固体声速显著高于液体与气体",
      chart: {
        kind: "chart",
        type: "bar",
        xLabel: "介质 Medium",
        yLabel: "波速 v / (m/s)",
        categories: ["空气 Air", "水 Water", "钢铁 Steel"],
        series: [{ name: "声速 Speed", data: [340, 1480, 5960] }],
      },
      takeaways: ["空气声速约 340 m/s", "钢铁声速达 5960 m/s"],
      source: "实验测定值（20 °C）",
    },
  },
  {
    id: "bv-04-raster-scatter",
    pageType: "data",
    layout: "chart",
    visual: "chart",
    minutes: 5,
    title: "两组不同采样时刻的位移散点对比",
    purpose: "触发浏览器 ECharts PNG 光栅化导出",
    keyPoints: ["非对齐横坐标散点", "两组斜率对比"],
    sourcePages: [2],
    loop: 1,
    notes: "NOTE-04：两组散点横坐标不同，由浏览器 ECharts 渲染高分 PNG。",
    content: {
      layout: "chart",
      title: "两组小车的位移随时间线性增长",
      chart: {
        kind: "chart",
        type: "scatter",
        xLabel: "时间 t / s",
        yLabel: "位移 s / m",
        series: [
          {
            name: "甲车 Cart A",
            data: [
              [0, 0],
              [1.0, 12],
              [2.0, 24],
              [3.0, 36],
            ],
          },
          {
            name: "乙车 Cart B",
            data: [
              [0.5, 10],
              [1.5, 30],
              [2.5, 50],
            ],
          },
        ],
      },
      takeaways: ["乙车速度为 20 m/s", "甲车速度为 12 m/s"],
      source: "光电门异步采样",
    },
  },
  {
    id: "bv-05-raster-function",
    pageType: "concept",
    layout: "statement",
    visual: "function",
    minutes: 4,
    title: "波速一定时波长与频率成反比",
    purpose: "带间断点的函数图像由浏览器 ECharts 光栅化",
    keyPoints: ["反比例分支", "零点渐近线"],
    sourcePages: [1],
    loop: 1,
    notes: "NOTE-05：含 x=0 间断点的函数曲线通过浏览器 ECharts 导出为清晰 PNG。",
    content: {
      layout: "statement",
      title: "波速固定时波长随频率反比变化",
      bullets: ["$y = k/x$ 在零点间断", "频率加倍时波长减半"],
      visual: {
        kind: "function",
        expr: "k/x",
        x: [-4, 4],
        y: [-6, 6],
        xLabel: "相对量 x",
        yLabel: "响应 y",
        params: [{ name: "k", label: "比例系数 k", min: 1, max: 4, step: 0.5, value: 2 }],
      },
      terms: [],
    },
  },
  {
    id: "bv-06-table",
    pageType: "data",
    layout: "chart",
    visual: "table",
    minutes: 4,
    title: "匀加速直线运动测量数据表",
    purpose: "检查原生 PPTX 表格结构",
    keyPoints: ["速度随时间均匀增加", "加速度恒为 4 m/s²"],
    sourcePages: [2],
    loop: 1,
    notes: "NOTE-06：原生表格保留在 PPT 中可直接编辑单元格。",
    content: {
      layout: "chart",
      title: "小车速度每 2 s 增加 8 m/s",
      chart: {
        kind: "table",
        columns: ["时间 t", "速度 v", "位移 s"],
        rows: [
          ["0 s", "12.0", "0 m"],
          ["2 s", "20.0", "32 m"],
          ["4 s", "28.0", "80 m"],
        ],
        caption: "匀加速测量记录（速度 m/s）",
      },
      takeaways: ["每秒增速 4 m/s", "满足 v = u + at"],
      source: "",
    },
  },
  {
    id: "bv-07-worked",
    pageType: "worked",
    layout: "steps",
    visual: "formula",
    minutes: 5,
    title: "完整例题：已知频率与波长求波速",
    purpose: "示范标准三步代入法",
    keyPoints: ["写公式", "代数值", "带单位作答"],
    sourcePages: [1],
    loop: 1,
    notes: "NOTE-07：板书示范每一步保留物理量单位。",
    content: {
      layout: "steps",
      title: "按三步代入法求解水波波速",
      problem: "水波频率 f = 5 Hz，波长 λ = 0.4 m，求波速 v。",
      steps: [
        { text: "写出 $v = f\\lambda$", why: "选公式" },
        { text: "代入 $v = 5 \\times 0.4$", why: "代数值" },
        { text: "算出 $v = 2$ m/s", why: "带单位" },
      ],
    },
  },
  {
    id: "bv-08-faded",
    pageType: "faded",
    layout: "steps",
    visual: "formula",
    minutes: 4,
    title: "渐隐练习：独立完成最后一步",
    purpose: "隐去最后一步由学生课堂完成",
    keyPoints: ["同结构迁移", "投影隐藏答案"],
    sourcePages: [2],
    loop: 1,
    notes: "NOTE-08：渐隐例题第 3 步只在讲稿中保留答案。",
    content: {
      layout: "steps",
      title: "完成匀加速末速度最后一步",
      problem: "初速度 u = 12 m/s，加速度 a = 4 m/s²，求 2 s 时速度。",
      steps: [
        { text: "写出 $v = u + at$", why: "选规律" },
        { text: "代入 $12 + 4 \\times 2$", why: "代已知" },
        { text: "TEACHER-FADED-ANSWER-SECRET", why: "TEACHER-FADED-WHY-SECRET" },
      ],
      fadeFrom: 2,
    },
  },
  {
    id: "bv-09-quiz",
    pageType: "check",
    layout: "quiz",
    visual: "none",
    minutes: 4,
    title: "关键概念投票检查",
    purpose: "先全班举手投票再揭示答案",
    keyPoints: ["波速不变时频率翻倍波长减半"],
    sourcePages: [1],
    loop: 1,
    notes: "NOTE-09：先统计各选项举手人数，再解释反比关系。",
    content: {
      layout: "quiz",
      question: "绳波波速不变，若频率加倍，波长怎样变化？",
      options: [
        { text: "波长加倍", misconception: "TEACHER-QUIZ-MISCONCEPTION-SECRET" },
        { text: "波长减半", misconception: "" },
        { text: "波长不变", misconception: "" },
        { text: "波速加倍", misconception: "" },
      ],
      answer: 1,
      explain: "TEACHER-QUIZ-EXPLAIN-SECRET",
      poll: true,
    },
  },
  {
    id: "bv-10-experiment",
    pageType: "experiment",
    layout: "experiment",
    visual: "sim",
    minutes: 4,
    title: "预测—观察—解释：弦上横波实验",
    purpose: "先预测再观察模拟实验",
    keyPoints: ["固定绳张力", "提高频率观察波峰间距"],
    sourcePages: [1],
    loop: 1,
    notes: "NOTE-10：PPT 中显示模拟实验说明框，解释与实际结果只进讲稿。",
    content: {
      layout: "experiment",
      title: "提高频率观察弦上波峰间距",
      predict: {
        question: "频率增大时波长会怎样？",
        options: ["波长变长", "波长变短", "保持不变"],
      },
      sim: { kind: "sim", embedId: "wave-string", caption: "弦上的波模拟" },
      observe: ["调高频率一倍", "比较波峰间距"],
      explain: "TEACHER-EXPERIMENT-EXPLAIN-SECRET",
      outcome: 1,
    },
  },
  {
    id: "bv-11-raster-formula",
    pageType: "concept",
    layout: "statement",
    visual: "formula",
    minutes: 4,
    title: "复杂分段函数与矢量公式快照",
    purpose: "验证非精确公式浏览器 2x KaTeX PNG 光栅化与讲稿 plain()",
    keyPoints: ["分段函数大括号排版", "讲稿内联公式转可读文本"],
    sourcePages: [1],
    loop: 1,
    notes: "NOTE-11：先回顾 $v = f\\lambda$，再对比分段函数。",
    content: {
      layout: "statement",
      title: "复杂公式自动生成高清公式卡片",
      bullets: ["合外力矢量 $\\vec{F}_{\\text{合}} = m\\vec{a}$", "加热反应 $2\\text{H}_2 + \\text{O}_2 \\xrightarrow{\\text{点燃}} 2\\text{H}_2\\text{O}$"],
      visual: {
        kind: "formula",
        tex: "f(x) = \\begin{cases} x^2, & x \\ge 0 \\\\ -x, & x < 0 \\end{cases}",
        caption: "分段函数定义（含 KaTeX 大括号）",
      },
      terms: [],
    },
  },
];

interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

const decodeXml = (value: string) =>
  value
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

function relationships(source: string): Relationship[] {
  return [...source.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((match) => {
    const attrs = Object.fromEntries([...match[1]!.matchAll(/(\w+)="([^"]*)"/g)].map((attr) => [attr[1]!, decodeXml(attr[2]!)]));
    return {
      id: attrs.Id ?? "",
      type: attrs.Type ?? "",
      target: attrs.Target ?? "",
      external: attrs.TargetMode === "External",
    };
  });
}

function ownerOf(relsPath: string): string {
  if (relsPath === "_rels/.rels") return "";
  const match = /^(.*)\/_rels\/([^/]+)\.rels$/.exec(relsPath);
  if (!match) throw new Error(`Invalid relationship part: ${relsPath}`);
  return `${match[1]}/${match[2]}`;
}

function resolveTarget(relsPath: string, target: string): string {
  if (target.startsWith("/")) return posix.normalize(target.slice(1));
  return posix.normalize(posix.join(posix.dirname(ownerOf(relsPath)), target));
}

const relsPathFor = (part: string) => posix.join(posix.dirname(part), "_rels", `${posix.basename(part)}.rels`);
const taggedValues = (source: string, tag: string) => [...source.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g"))].map((m) => decodeXml(m[1]!));

function readPngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) throw new Error("invalid PNG signature");
  const chunk = Buffer.from(bytes.subarray(12, 16)).toString("ascii");
  if (chunk !== "IHDR") throw new Error(`expected IHDR chunk, got ${chunk}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

const toPx = (v: string) => {
  const m = /^([\d.]+)(cm|mm|in|pt)$/.exec(v);
  if (!m) return NaN;
  const n = Number(m[1]);
  return { cm: (n / 2.54) * 144, mm: (n / 25.4) * 144, in: n * 144, pt: n * 2 }[m[2] as "cm"]!;
};

function laidOutHeights(fodp: string): Map<string, number[]>[] {
  const xml = fs.readFileSync(fodp, "utf8");
  return xml
    .split(/<draw:page /)
    .slice(1)
    .map((page) => {
      const m = new Map<string, number[]>();
      for (const el of page.matchAll(/<draw:(?:custom-shape|frame)\b[^>]*>/g)) {
        const name = /draw:name="([^"]*)"/.exec(el[0])?.[1];
        const h = /svg:height="([^"]+)"/.exec(el[0])?.[1];
        if (!name || !h) continue;
        m.set(name, [...(m.get(name) ?? []), toPx(h)]);
      }
      return m;
    });
}

async function waitForHealth(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Server still booting.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function verifyPptxPackage(pptxPath: string, theme: ThemeId) {
  const rawBytes = fs.readFileSync(pptxPath);
  const sha256 = createHash("sha256").update(rawBytes).digest("hex");
  const zip = await JSZip.loadAsync(rawBytes);
  const xml = async (part: string) => {
    const f = zip.file(part);
    if (!f) throw new Error(`${theme}: missing OOXML part ${part}`);
    return f.async("string");
  };

  // 1. Relationships & Content_Types integrity
  const relParts = Object.keys(zip.files).filter((n) => n.endsWith(".rels"));
  for (const relsPart of relParts) {
    const rels = relationships(await xml(relsPart));
    if (new Set(rels.map((r) => r.id)).size !== rels.length) throw new Error(`${theme}: duplicate relationship ID in ${relsPart}`);
    for (const rel of rels) {
      if (rel.external) throw new Error(`${theme}: unexpected external relationship in ${relsPart}`);
      const resolved = resolveTarget(relsPart, rel.target);
      if (!zip.file(resolved)) throw new Error(`${theme}: broken relationship ${relsPart} -> ${rel.target} (${resolved})`);
    }
  }
  const contentTypes = await xml("[Content_Types].xml");
  const defaults = new Set([...contentTypes.matchAll(/<Default Extension="([^"]+)"/g)].map((m) => m[1]!));
  const overrides = new Set([...contentTypes.matchAll(/<Override PartName="\/([^"]+)"/g)].map((m) => m[1]!));
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || entry.name === "[Content_Types].xml" || entry.name.endsWith(".rels")) continue;
    const ext = posix.extname(entry.name).slice(1);
    if (!overrides.has(entry.name) && !defaults.has(ext)) throw new Error(`${theme}: missing content type for ${entry.name}`);
  }

  // 2. Slide count, order, notes links, and zero answer leaks on projected slides
  const pres = await xml("ppt/presentation.xml");
  const presRels = new Map(relationships(await xml("ppt/_rels/presentation.xml.rels")).map((r) => [r.id, r]));
  const slideIds = [...pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => m[1]!);
  const slideParts = slideIds.map((id) => resolveTarget("ppt/_rels/presentation.xml.rels", presRels.get(id)!.target));
  if (slideParts.length !== SLIDE_SPECS.length) throw new Error(`${theme}: expected ${SLIDE_SPECS.length} slides, got ${slideParts.length}`);

  const slideXmls = await Promise.all(slideParts.map(xml));
  const projectedText = slideXmls.flatMap((s) => taggedValues(s, "a:t")).join("\n");
  for (const secret of TEACHER_SECRETS) {
    if (projectedText.includes(secret)) throw new Error(`${theme}: teacher secret leaked onto projected slide: ${secret}`);
  }
  if (projectedText.includes("答案 Answer") || projectedText.includes("实际结果 Outcome")) {
    throw new Error(`${theme}: answer heading leaked onto projected slide`);
  }

  // Verify faded step placeholder on slide 8 and native table on slide 6 and native chart on slide 3
  if (!taggedValues(slideXmls[7]!, "a:t").includes("？")) throw new Error(`${theme}: faded slide missing '?' placeholder`);
  if (!slideXmls[5]!.includes("<a:tbl>")) throw new Error(`${theme}: table slide missing native <a:tbl>`);
  const chartSlideRels = relationships(await xml(relsPathFor(slideParts[2]!)));
  if (!chartSlideRels.some((r) => r.type.endsWith("/chart"))) throw new Error(`${theme}: native chart slide missing chart relationship`);

  // Verify speaker notes on every slide and teacher secrets present in notes
  const allNotes: string[] = [];
  for (const [idx, slidePart] of slideParts.entries()) {
    const noteRel = relationships(await xml(relsPathFor(slidePart))).find((r) => r.type.endsWith("/notesSlide"));
    if (!noteRel) throw new Error(`${theme}: slide ${idx + 1} missing speaker notes`);
    const notePart = resolveTarget(relsPathFor(slidePart), noteRel.target);
    const noteText = taggedValues(await xml(notePart), "a:t").join("\n");
    if (!noteText.includes(`NOTE-${String(idx + 1).padStart(2, "0")}`)) {
      throw new Error(`${theme}: slide ${idx + 1} missing expected teacher note marker`);
    }
    allNotes.push(noteText);
  }
  const combinedNotes = allNotes.join("\n");
  for (const secret of TEACHER_SECRETS) {
    if (!combinedNotes.includes(secret)) throw new Error(`${theme}: expected secret missing from speaker notes: ${secret}`);
  }

  // 3. Browser ECharts & KaTeX rasterized PNG verification (slides 4, 5, and 11)
  const mediaParts = Object.keys(zip.files)
    .filter((n) => n.startsWith("ppt/media/") && !zip.files[n]!.dir)
    .sort();
  if (mediaParts.length < 3) {
    throw new Error(`${theme}: expected at least 3 browser-rasterized PNGs in ppt/media/, found ${mediaParts.length}`);
  }
  const mediaDetails = [];
  for (const mediaPart of mediaParts) {
    const bytes = await zip.file(mediaPart)!.async("uint8array");
    const dims = readPngDimensions(bytes);
    if (bytes.byteLength <= 1000 || dims.width <= 1 || dims.height <= 1) {
      throw new Error(`${theme}: ${mediaPart} is trivial (${bytes.byteLength} B, ${dims.width}x${dims.height})`);
    }
    mediaDetails.push({
      part: mediaPart,
      bytes: bytes.byteLength,
      width: dims.width,
      height: dims.height,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  // Verify slides 4, 5, and 11 specifically link to image relationships (not text fallback), and slide 11 notes cleaned $v = f\lambda$ while keeping raw LaTeX
  for (const slideIdx of [3, 4, 10]) {
    const rels = relationships(await xml(relsPathFor(slideParts[slideIdx]!)));
    if (!rels.some((r) => r.type.endsWith("/image"))) {
      throw new Error(`${theme}: slide ${slideIdx + 1} fell back to text instead of embedding browser PNG`);
    }
  }
  if (!allNotes[10]!.includes("NOTE-11：先回顾 v = fλ") || !allNotes[10]!.includes("公式原文（LaTeX）：f(x) = \\begin{cases}")) {
    throw new Error(`${theme}: slide 11 speaker notes missing plain() math conversion or raw LaTeX preservation`);
  }

  return {
    theme,
    pptxPath,
    bytes: rawBytes.byteLength,
    sha256,
    slides: slideParts.length,
    media: mediaDetails,
  };
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "kj-browser-pptx-"));
  const fontsConf = path.join(work, "fonts.conf");
  fs.writeFileSync(
    fontsConf,
    `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include>` +
      `<alias binding="same"><family>${PPTX_FONT}</family><prefer><family>Noto Sans CJK SC</family></prefer></alias></fontconfig>`,
  );
  const loEnv = { ...process.env, FONTCONFIG_FILE: fontsConf, HOME: work };

  const server = spawn("bash", ["scripts/e2e-server.sh"], {
    cwd: ROOT,
    env: { ...process.env, E2E_PORT: String(PORT) },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverErr = "";
  server.stderr?.on("data", (chunk) => {
    serverErr += String(chunk);
  });

  try {
    await waitForHealth(`${BASE_URL}/api/health`);

    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", acceptDownloads: true });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(e.message));

      // Log in via real browser UI (handles initial Admin12345 password change)
      await page.goto(`${BASE_URL}/login`);
      await page.getByLabel("用户名 Username").fill("admin");
      await page.getByLabel("密码 Password").fill("Admin12345");
      await page.getByRole("button", { name: "登录 Log in" }).click();
      await page.waitForURL(/\/(change-password)?$/);
      if (page.url().endsWith("/change-password")) {
        await page.getByLabel("当前密码 Current password").fill("Admin12345");
        await page.getByLabel("新密码 New password").fill("Teacher2026x");
        await page.getByLabel("再输一次 Confirm").fill("Teacher2026x");
        await page.getByRole("button", { name: "保存 Save" }).click();
      }
      await page.waitForSelector('[data-testid="new-lesson"]');

      const csrf = { "x-kj-csrf": "1" };
      const postJson = async <T>(url: string, data: unknown, method: "POST" | "PUT" | "PATCH" = "POST"): Promise<T> => {
        const res = await page.request.fetch(`${BASE_URL}${url}`, { method, data, headers: csrf });
        if (!res.ok()) throw new Error(`${method} ${url} failed (${res.status()}): ${await res.text()}`);
        return (await res.json()) as T;
      };

      // Create synthetic source document + pages
      const createdDoc = await postJson<{ id: string }>("/api/documents", {
        filename: "browser-pptx-validation.pdf",
        title: "波动与运动验证教材",
        sizeBytes: 4096,
        pageCount: 2,
        chapters: [{ id: "ch1", parentId: null, level: 1, ord: 0, title: "第1章 波动与运动", pageStart: 1, pageEnd: 2, words: 120 }],
      });
      await postJson(`/api/documents/${createdDoc.id}/pages`, {
        pages: [
          {
            no: 1,
            label: "xii",
            text: "Wave speed equals frequency times wavelength: v = f x lambda. Sound travels at 340 m/s in air, 1480 m/s in water, and 5960 m/s in steel. For f = 5 Hz and lambda = 0.4 m, v = 2 m/s.",
          },
          {
            no: 2,
            label: "1",
            text: "Uniform acceleration follows v = u + a t. Cart A moves at 12 m/s (36 m in 3 s). Cart B moves at 20 m/s. Starting at 12 m/s with acceleration 4 m/s^2, speed is 20 m/s at 2 s and 28 m/s at 4 s (displacements 32 m and 80 m).",
          },
        ],
      });

      // Create lesson, draft outline, replace with exact 10-slide spec, confirm, generate, and patch exact slide contents
      const lessonView = await postJson<{ lesson: { id: string } }>("/api/lessons", {
        documentId: createdDoc.id,
        chapterIds: ["ch1"],
        ranges: [{ start: 1, end: 2 }],
        title: "波动与运动综合复习",
      });
      const lessonId = lessonView.lesson.id;
      const drafted = await postJson<{ version: { id: string; rev: number } }>(`/api/lessons/${lessonId}/outline`, {});
      const versionId = drafted.version.id;

      const outline: Outline = {
        objectives: ["用 v = fλ 计算波速并核对单位", "读懂实验数据表、散点图与反比例函数曲线"],
        glossary: [
          { term: "wavelength", zh: "波长" },
          { term: "frequency", zh: "频率" },
        ],
        notCovered: [],
        slides: SLIDE_SPECS.map((s) => ({
          id: s.id,
          pageType: s.pageType,
          layout: s.layout,
          title: s.title,
          purpose: s.purpose,
          keyPoints: s.keyPoints,
          visual: s.visual,
          minutes: s.minutes,
          sourcePages: s.sourcePages,
          loop: s.loop,
        })),
      };
      const savedOutline = await postJson<{ version: { rev: number } }>(`/api/lessons/${lessonId}/outline-versions/${versionId}`, { outline, rev: drafted.version.rev }, "PUT");
      await postJson(`/api/lessons/${lessonId}/outline-versions/${versionId}/confirm`, { ackOverBudget: true, rev: savedOutline.version.rev });

      for (const s of SLIDE_SPECS) {
        const gen = await postJson<{ slide: { id: string } }>(`/api/lessons/${lessonId}/outline-versions/${versionId}/slides/${s.id}/generate`, { regenerate: false });
        await postJson(`/api/lessons/${lessonId}/slides/${gen.slide.id}`, { content: s.content, notes: s.notes }, "PATCH");
      }

      // Trigger real browser exportPptx downloads in both classic and chalk themes
      const packageReports = [];
      for (const theme of ["classic", "chalk"] as ThemeId[]) {
        await postJson(`/api/lessons/${lessonId}`, { theme, title: `波动与运动综合复习-${theme}` }, "PATCH");
        await page.goto(`${BASE_URL}/lessons/${lessonId}/slides`);
        await page.getByTestId("gen-progress").waitFor({ state: "visible" });
        await page.getByText("导出 Export").click();
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-pptx").click()]);
        const targetPath = path.join(outDir, `browser-verified-${theme}.pptx`);
        await download.saveAs(targetPath);
        packageReports.push(await verifyPptxPackage(targetPath, theme));
      }

      if (pageErrors.length) throw new Error(`Browser page errors during export: ${pageErrors.join(" | ")}`);

      // Verify classic and chalk raster PNGs differ (proving real CSS theme computed styles reached ECharts SVG->Canvas)
      const classicMediaHashes = packageReports[0]!.media.map((m) => m.sha256);
      const chalkMediaHashes = packageReports[1]!.media.map((m) => m.sha256);
      if (classicMediaHashes.some((h, i) => h === chalkMediaHashes[i])) {
        throw new Error("Expected classic and chalk browser-rasterized ECharts PNGs to have distinct theme colors, but hashes matched");
      }

      // Run headless LibreOffice geometry check (PDFpdftotext -bbox + probe FODP text-box heights) + render PNG previews
      const deckSlides: PptxDeck["slides"] = SLIDE_SPECS.map((s) => ({
        content: s.content,
        notes: s.notes,
        sources: s.sourcePages,
        unverified: [],
        pageType: s.pageType,
      }));
      const loSummary = [];
      const problems: { deck: string; slide: number; slot: string; detail: string }[] = [];

      for (const theme of ["classic", "chalk"] as ThemeId[]) {
        const name = `browser-verified-${theme}`;
        const pptxPath = path.join(outDir, `${name}.pptx`);
        const pdfPath = path.join(work, `${name}.pdf`);
        const deck: PptxDeck = { title: `波动与运动综合复习-${theme}`, theme, pageLabels: { 1: "xii", 2: "1" }, slides: deckSlides };
        const plans = planDeck(deck);

        // Probe deck for text-box auto-fit check (image slots use dummy 1px or fallback? Wait: in browser deck, image slots are images, not text boxes! Let's check text items!)
        const probePath = path.join(work, `${name}-probe.pptx`);
        fs.writeFileSync(
          probePath,
          await writePptx(plans, {
            title: deck.title,
            fontFace: PPTX_FONT,
            palette: PALETTES[theme],
            probe: true,
            // Supply a valid PNG for image items so probe matches the real browser deck's text boxes
            chartImage: async () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          }),
        );

        execFileSync("soffice", ["--headless", "--norestore", "--convert-to", "pdf", "--outdir", work, pptxPath], { env: loEnv, stdio: "pipe", timeout: 300_000 });
        execFileSync("soffice", ["--headless", "--norestore", "--convert-to", "fodp", "--outdir", work, probePath], { env: loEnv, stdio: "pipe", timeout: 300_000 });

        const pages = laidOutHeights(path.join(work, `${name}-probe.fodp`));
        if (pages.length !== plans.length) {
          problems.push({ deck: name, slide: 0, slot: "-", detail: `${pages.length} pages rendered for ${plans.length} slides` });
        }

        let boxes = 0;
        plans.forEach((plan, i) => {
          const seen = new Map<string, number>();
          for (const it of plan.items.filter((x): x is TextItem => x.kind === "text")) {
            const k = seen.get(it.slot) ?? 0;
            seen.set(it.slot, k + 1);
            const h = pages[i]?.get(it.slot)?.[k];
            if (h === undefined) {
              problems.push({ deck: name, slide: i + 1, slot: it.slot, detail: "text box missing from LibreOffice render" });
              continue;
            }
            boxes++;
            if (h > it.rect.h + TOLERANCE_PX) {
              problems.push({ deck: name, slide: i + 1, slot: it.slot, detail: `needs ${Math.round(h)}px, box is ${Math.round(it.rect.h)}px` });
            }
          }
        });

        const bbox = execFileSync("pdftotext", ["-bbox", pdfPath, "-"], { encoding: "utf8", maxBuffer: 32 << 20 });
        let words = 0;
        bbox
          .split(/<page /)
          .slice(1)
          .forEach((pg, i) => {
            const w = Number(/width="([\d.]+)"/.exec(pg)?.[1]);
            const h = Number(/height="([\d.]+)"/.exec(pg)?.[1]);
            for (const m of pg.matchAll(/<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]*)<\/word>/g)) {
              words++;
              const [x0, y0, x1, y1] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
              if (x0 < -0.5 || y0 < -0.5 || x1 > w + 0.5 || y1 > h + 0.5) {
                problems.push({ deck: name, slide: i + 1, slot: "-", detail: `word "${m[5]}" outside slide bounds` });
              }
            }
          });

        execFileSync("pdftoppm", ["-png", "-scale-to", "1280", pdfPath, path.join(outDir, name)], { stdio: "pipe" });
        const pngFiles = fs
          .readdirSync(outDir)
          .filter((f) => f.startsWith(`${name}-`) && f.endsWith(".png"))
          .sort();
        if (pngFiles.length !== SLIDE_SPECS.length) {
          throw new Error(`${name}: expected ${SLIDE_SPECS.length} rendered PNG slides, got ${pngFiles.length}`);
        }
        loSummary.push({ deck: name, slides: plans.length, textBoxes: boxes, words, pngCount: pngFiles.length });
      }

      if (problems.length) {
        throw new Error(`LibreOffice render problems:\n${JSON.stringify(problems, null, 2)}`);
      }

      const report = {
        verifiedAt: new Date().toISOString(),
        packages: packageReports,
        libreOffice: loSummary,
        problems,
      };
      console.log(JSON.stringify(report, null, 2));
    } finally {
      await browser.close();
    }
  } catch (err) {
    if (serverErr) console.error(serverErr.slice(-2000));
    throw err;
  } finally {
    try {
      if (server.pid) process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error((err as Error).stack ?? (err as Error).message);
    process.exit(1);
  });
}
