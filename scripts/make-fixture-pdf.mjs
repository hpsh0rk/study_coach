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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/pdfs/waves-mini.pdf");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await makeFixturePdf());
  console.log(`wrote ${out}`);
}
