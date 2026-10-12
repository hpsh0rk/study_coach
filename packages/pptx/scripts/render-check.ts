/**
 * Renders exported .pptx files through LibreOffice headless and checks that no text overflows.
 *
 *   tsx packages/pptx/scripts/render-check.ts --out <dir> [--gallery] [--png] [deck.json ...]
 *
 * For every deck it writes <name>.pptx, <name>.pdf and (with --png) <name>-NN.png, then checks:
 *  1. box fit: a probe copy whose text boxes auto-grow (spAutoFit) is converted to flat ODP; the height
 *     LibreOffice lays each box out at must not exceed the box the exporter planned;
 *  2. slide fit: every word in the PDF lies inside the 16:9 page (pdftotext -bbox).
 * Needs `soffice` and poppler (`pdftoppm`, `pdftotext`). PingFang SC is mapped to Noto Sans CJK SC
 * through a private fontconfig file, the closest metric match available on Linux.
 * Exits 1 when anything overflows.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThemeId } from "@kj/schema";
import { galleryCells } from "@kj/templates";
import { exportPptx, PALETTES, planDeck, PPTX_FONT, writePptx, type PptxDeck, type TextItem } from "../src/index.ts";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const outIdx = args.indexOf("--out");
const out = path.resolve(outIdx >= 0 ? args[outIdx + 1]! : "pptx-render");
const files = args.filter((a, i) => !a.startsWith("--") && i !== outIdx + 1);
const TOLERANCE_PX = 6;

fs.mkdirSync(out, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "kj-pptx-"));
const fontsConf = path.join(work, "fonts.conf");
fs.writeFileSync(
  fontsConf,
  `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include>` +
    `<alias binding="same"><family>${PPTX_FONT}</family><prefer><family>Noto Sans CJK SC</family></prefer></alias></fontconfig>`,
);
const env = { ...process.env, FONTCONFIG_FILE: fontsConf, HOME: work };

const decks: { name: string; deck: PptxDeck }[] = [];
if (flag("--gallery"))
  for (const theme of ["classic", "chalk"] as ThemeId[])
    decks.push({ name: `gallery-${theme}`, deck: { title: `Layout gallery (${theme})`, theme, slides: galleryCells().map((c) => ({ content: c.content, notes: c.id, sources: [12, 13], pageType: "concept" })) } });
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  decks.push({ name: path.basename(f, ".json"), deck: { title: d.lesson?.title ?? d.title ?? path.basename(f, ".json"), theme: d.lesson?.theme ?? d.theme ?? "classic", pageLabels: d.lesson?.pageLabels ?? {}, slides: d.slides } });
}

function soffice(format: string, input: string[], dir: string): void {
  execFileSync("soffice", ["--headless", "--norestore", "--convert-to", format, "--outdir", dir, ...input], { env, stdio: "pipe", timeout: 600_000 });
}

const toPx = (v: string) => {
  const m = /^([\d.]+)(cm|mm|in|pt)$/.exec(v);
  if (!m) return NaN;
  const n = Number(m[1]);
  return { cm: (n / 2.54) * 144, mm: (n / 25.4) * 144, in: n * 144, pt: n * 2 }[m[2] as "cm"]!;
};

/** Per page: draw:name → laid-out heights (px) in document order. */
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

interface Problem {
  deck: string;
  slide: number;
  slot: string;
  detail: string;
}
const problems: Problem[] = [];
const summary: Record<string, unknown>[] = [];

for (const { name, deck } of decks) {
  const r = await exportPptx(deck);
  const pptx = path.join(out, `${name}.pptx`);
  fs.writeFileSync(pptx, r.data);
  const probe = path.join(work, `${name}.pptx`);
  const plans = planDeck(deck);
  fs.writeFileSync(probe, await writePptx(plans, { title: deck.title, fontFace: PPTX_FONT, palette: PALETTES[deck.theme], probe: true }));

  soffice("pdf", [pptx], out);
  soffice("fodp", [probe], work);
  const pdf = path.join(out, `${name}.pdf`);
  const pages = laidOutHeights(path.join(work, `${name}.fodp`));
  if (pages.length !== plans.length) problems.push({ deck: name, slide: 0, slot: "-", detail: `${pages.length} pages rendered for ${plans.length} slides` });

  let boxes = 0;
  plans.forEach((plan, i) => {
    const seen = new Map<string, number>();
    for (const it of plan.items.flatMap((x) => (x.kind === "text" ? [x] : x.kind === "image" ? [x.fallback] : [])) as TextItem[]) {
      const k = seen.get(it.slot) ?? 0;
      seen.set(it.slot, k + 1);
      const h = pages[i]?.get(it.slot)?.[k];
      if (h === undefined) {
        problems.push({ deck: name, slide: i + 1, slot: it.slot, detail: "text box missing from the render" });
        continue;
      }
      boxes++;
      if (h > it.rect.h + TOLERANCE_PX) problems.push({ deck: name, slide: i + 1, slot: it.slot, detail: `needs ${Math.round(h)}px, box is ${Math.round(it.rect.h)}px` });
    }
  });

  const bbox = execFileSync("pdftotext", ["-bbox", pdf, "-"], { encoding: "utf8", maxBuffer: 64 << 20 });
  let words = 0;
  bbox.split(/<page /).slice(1).forEach((pg, i) => {
    const w = Number(/width="([\d.]+)"/.exec(pg)?.[1]);
    const h = Number(/height="([\d.]+)"/.exec(pg)?.[1]);
    for (const m of pg.matchAll(/<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]*)<\/word>/g)) {
      words++;
      const [x0, y0, x1, y1] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
      if (x0 < -0.5 || y0 < -0.5 || x1 > w + 0.5 || y1 > h + 0.5) problems.push({ deck: name, slide: i + 1, slot: "-", detail: `word "${m[5]}" outside the slide` });
    }
  });

  if (flag("--png")) execFileSync("pdftoppm", ["-png", "-scale-to", "1280", pdf, path.join(out, name)], { stdio: "pipe" });
  summary.push({ deck: name, slides: plans.length, textBoxes: boxes, words, degradedSlides: r.degraded.length });
}

fs.rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ decks: summary, problems }, null, 2));
if (problems.length) process.exit(1);
