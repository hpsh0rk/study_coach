#!/usr/bin/env node
// Generates fixtures/pdfs/waves-mini.pdf: an 8-page born-digital "textbook" with nested bookmarks.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, StandardFonts, rgb } from "pdf-lib";

const PAGES = [
  {
    heading: "Chapter 1  Waves",
    body: "In this chapter you will learn how waves transfer energy, how to describe them, and how fast they travel. Waves are everywhere: ripples on a pond, sound from a speaker and light from the Sun.",
  },
  {
    heading: "1.1  Describing waves",
    body: "A wave transfers energy from one place to another without transferring matter. The particles of the medium oscillate about a fixed position. The amplitude of a wave is the maximum displacement of a point from its rest position. The wavelength is the distance between two adjacent crests or two adjacent troughs. The frequency is the number of waves passing a point each second, measured in hertz. In a transverse wave the oscillations are perpendicular to the direction of energy transfer. In a longitudinal wave the oscillations are parallel to the direction of energy transfer, producing compressions and rarefactions.",
  },
  {
    heading: "1.2  Wave speed",
    body: "The wave speed is the distance travelled by a wave each second. Wave speed, frequency and wavelength are linked by the wave equation v = f x lambda. If the frequency of a wave doubles while the speed stays the same, the wavelength halves. The period of a wave is the time for one complete oscillation, and it is equal to one divided by the frequency.",
  },
  {
    heading: "1.2  Wave speed (continued)",
    body: "You can measure the speed of water waves using a ripple tank. Measure the distance across ten wavefronts to find the wavelength, then count the number of waves passing a point in ten seconds to find the frequency. Multiply the frequency by the wavelength to calculate the wave speed. Repeat the measurements and calculate a mean.",
  },
  {
    heading: "1.3  The electromagnetic spectrum",
    body: "Electromagnetic waves are transverse waves that can travel through a vacuum at the speed of light. In order of increasing frequency the electromagnetic spectrum is radio waves, microwaves, infrared, visible light, ultraviolet, X-rays and gamma rays. All electromagnetic waves travel at the same speed in a vacuum.",
  },
  {
    heading: "Chapter 2  Sound",
    body: "Sound is a longitudinal wave produced by vibrating objects. Sound needs a medium to travel through, so it cannot travel through a vacuum.",
  },
  {
    heading: "2.1  Sound waves",
    body: "When a loudspeaker cone vibrates it pushes air particles together to form compressions and pulls them apart to form rarefactions. The pitch of a sound depends on its frequency, and the loudness depends on its amplitude. The speed of sound in air is about 340 metres per second, and sound travels faster in liquids and solids.",
  },
  {
    heading: "2.2  Echoes and ultrasound",
    body: "An echo is a reflection of sound from a hard surface. Ultrasound is sound with a frequency above 20 000 hertz, which humans cannot hear. Ultrasound is used for medical imaging and for measuring the depth of the sea, by timing how long an echo takes to return.",
  },
];

const OUTLINE = [
  { title: "Chapter 1  Waves", page: 0, children: [
    { title: "1.1  Describing waves", page: 1 },
    { title: "1.2  Wave speed", page: 2 },
    { title: "1.3  The electromagnetic spectrum", page: 4 },
  ] },
  { title: "Chapter 2  Sound", page: 5, children: [
    { title: "2.1  Sound waves", page: 6 },
    { title: "2.2  Echoes and ultrasound", page: 7 },
  ] },
];

function wrap(text, font, size, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function addOutline(doc, pageRefs, items) {
  const ctx = doc.context;
  const rootRef = ctx.nextRef();
  const build = (nodes, parentRef) => {
    const refs = nodes.map(() => ctx.nextRef());
    let total = 0;
    nodes.forEach((n, i) => {
      const dict = {
        Title: PDFHexString.fromText(n.title),
        Parent: parentRef,
        Dest: ctx.obj([pageRefs[n.page], PDFName.of("XYZ"), PDFNull, PDFNull, PDFNull]),
      };
      if (i > 0) dict.Prev = refs[i - 1];
      if (i < nodes.length - 1) dict.Next = refs[i + 1];
      if (n.children?.length) {
        const child = build(n.children, refs[i]);
        dict.First = child.refs[0];
        dict.Last = child.refs[child.refs.length - 1];
        dict.Count = PDFNumber.of(child.total);
        total += child.total;
      }
      total += 1;
      ctx.assign(refs[i], ctx.obj(dict));
    });
    return { refs, total };
  };
  const top = build(items, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: PDFName.of("Outlines"), First: top.refs[0], Last: top.refs[top.refs.length - 1], Count: PDFNumber.of(top.total) }));
  doc.catalog.set(PDFName.of("Outlines"), rootRef);
}

export async function makeFixturePdf() {
  const doc = await PDFDocument.create();
  doc.setTitle("Waves mini textbook (fixture)");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pageRefs = [];
  PAGES.forEach((p, i) => {
    const page = doc.addPage([595, 842]);
    pageRefs.push(page.ref);
    page.drawText(p.heading, { x: 60, y: 770, size: 20, font: bold, color: rgb(0.1, 0.2, 0.5) });
    let y = 730;
    for (const line of wrap(p.body, font, 12, 475)) {
      page.drawText(line, { x: 60, y, size: 12, font });
      y -= 18;
    }
    page.drawText(String(i + 1), { x: 290, y: 40, size: 10, font });
  });
  addOutline(doc, pageRefs, OUTLINE);
  return doc.save();
}

const ZH_PAGES = [
  { heading: "第4章 牛顿运动定律", body: "本章研究力与运动的关系。我们将学习牛顿第一定律、牛顿第二定律和牛顿第三定律，并用它们分析生活中的运动现象。" },
  { heading: "4.2 牛顿第一定律", body: "一切物体在没有受到外力作用时，总保持静止状态或匀速直线运动状态。物体保持原有运动状态的性质叫做惯性。质量是惯性大小的量度，质量越大，惯性越大。" },
  { heading: "4.3 牛顿第二定律", body: "物体加速度的大小跟它受到的合力成正比，跟它的质量成反比，加速度的方向跟合力的方向相同。表达式为 F = ma。力的单位是牛顿，1 N = 1 kg·m/s²。" },
  { heading: "4.3 牛顿第二定律（例题）", body: "例题：质量为 2 kg 的物体受到 10 N 的水平合力，求它的加速度。解：由 F = ma 得 a = F/m = 10 N ÷ 2 kg = 5 m/s²，方向与合力方向相同。" },
  { scanned: true },
  { scanned: true },
];

const ZH_OUTLINE = [
  { title: "第4章 牛顿运动定律", page: 0, children: [
    { title: "4.2 牛顿第一定律", page: 1 },
    { title: "4.3 牛顿第二定律", page: 2 },
    { title: "4.4 习题（扫描页）", page: 4 },
  ] },
];

const utf16Hex = (s) => [...s].map((ch) => ch.codePointAt(0).toString(16).padStart(4, "0")).join("");
const chunks = (s, n) => Array.from({ length: Math.ceil(s.length / n) }, (_, i) => s.slice(i * n, i * n + n));

/**
 * Chinese text set in a non-embedded CID font (Adobe-GB1, UniGB-UTF16-H), as many publisher PDFs do.
 * pdf.js can only extract its text with the predefined CMaps. Pages 5–6 are image-only ("scanned").
 */
export async function makeCidFixturePdf() {
  const doc = await PDFDocument.create();
  doc.setTitle("牛顿运动定律（中文 CID 字体样例）");
  const ctx = doc.context;
  const descendant = ctx.register(
    ctx.obj({
      Type: "Font",
      Subtype: "CIDFontType0",
      BaseFont: "STSong-Light",
      CIDSystemInfo: { Registry: PDFHexString.fromText("Adobe"), Ordering: PDFHexString.fromText("GB1"), Supplement: 4 },
      FontDescriptor: ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: "STSong-Light", Flags: 6, FontBBox: [-25, -254, 1000, 880], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 880, StemV: 93 })),
      DW: 1000,
    }),
  );
  const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "STSong-Light-UniGB-UTF16-H", Encoding: "UniGB-UTF16-H", DescendantFonts: [descendant] }));
  const pageRefs = [];
  ZH_PAGES.forEach((p, i) => {
    const page = doc.addPage([595, 842]);
    pageRefs.push(page.ref);
    page.node.setFontDictionary(PDFName.of("F1"), font);
    const ops = [];
    if (p.scanned) {
      ops.push("0.85 g 60 120 475 650 re f");
    } else {
      ops.push(`BT /F1 22 Tf 60 770 Td <${utf16Hex(p.heading)}> Tj ET`);
      chunks(p.body, 22).forEach((line, j) => ops.push(`BT /F1 20 Tf 60 ${720 - j * 30} Td <${utf16Hex(line)}> Tj ET`));
      ops.push(`BT /F1 10 Tf 290 40 Td <${utf16Hex(String(i + 1))}> Tj ET`);
    }
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(ops.join("\n"))));
  });
  addOutline(doc, pageRefs, ZH_OUTLINE);
  return doc.save();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/pdfs");
  mkdirSync(dir, { recursive: true });
  for (const [name, make] of [["waves-mini.pdf", makeFixturePdf], ["newton-zh-cid.pdf", makeCidFixturePdf]]) {
    writeFileSync(resolve(dir, name), await make());
    console.log(`wrote ${resolve(dir, name)}`);
  }
}
