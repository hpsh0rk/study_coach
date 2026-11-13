import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { getDocument } from "pdfjs-dist";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import {
  cropNormalizedRegion,
  detectPageFigures,
  extractPdfFigures,
  GlobalWorkerOptions,
  pdfjsAssetOptions,
} from "../src/browser.ts";

const pdfjsDir = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

beforeAll(() => {
  GlobalWorkerOptions.workerSrc = resolve(pdfjsDir, "legacy/build/pdf.worker.mjs");
});

function makeSolidPng(width: number, height: number, rByte: number, gByte: number, bByte: number): Uint8Array {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowOff = y * (1 + width * 3);
    raw[rowOff] = 0;
    for (let x = 0; x < width; x++) {
      raw[rowOff + 1 + x * 3] = rByte;
      raw[rowOff + 1 + x * 3 + 1] = gByte;
      raw[rowOff + 1 + x * 3 + 2] = bByte;
    }
  }
  return new Uint8Array(
    Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]),
  );
}

/**
 * Builds a synthetic Cambridge IGCSE Physics PDF page containing:
 *  - A tiny decorative header icon (20x20 pt near top margin) -> MUST be filtered out!
 *  - A real physics diagram combining a raster base image + PDF vector arrow lines + text labels ("N", "S", "Force")
 *    + adjacent caption "Figure 16.8: Magnetic field pattern around a solenoid" -> MUST be detected with union box!
 *  - Page 2: pure vector diagram (no raster image) with "Fig. 16.9 Electromagnetic relay circuit" -> MUST also be detected!
 */
async function makePhysicsDiagramPdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const tinyIcon = await doc.embedPng(makeSolidPng(20, 20, 30, 80, 180));
  const magnetBase = await doc.embedPng(makeSolidPng(200, 90, 210, 225, 245));

  // Page 1 (500 x 700 pt):
  const p1 = doc.addPage([500, 700]);
  // Tiny header icon near top margin (y = 665, 18x18 pt)
  p1.drawImage(tinyIcon, { x: 40, y: 665, width: 18, height: 18 });
  p1.drawText("16.2 Magnetic fields", { x: 68, y: 670, size: 11, font: bold });
  p1.drawText(
    "A current-carrying solenoid produces a magnetic field pattern similar to a bar magnet. Inside the coil the field lines are parallel.",
    { x: 45, y: 615, size: 11, font, maxWidth: 410 },
  );

  // Composite diagram in middle of page (x: 110..350, y: 330..490):
  // 1) Raster base image (x: 140..320, y: 360..450)
  p1.drawImage(magnetBase, { x: 140, y: 360, width: 180, height: 90 });
  // 2) Vector arrows extending outside the raster image (x: 95..365, y: 345..475)
  p1.drawLine({ start: { x: 95, y: 405 }, end: { x: 365, y: 405 }, thickness: 2, color: rgb(0.8, 0.1, 0.1) });
  p1.drawLine({ start: { x: 350, y: 413 }, end: { x: 365, y: 405 }, thickness: 2, color: rgb(0.8, 0.1, 0.1) });
  p1.drawLine({ start: { x: 350, y: 397 }, end: { x: 365, y: 405 }, thickness: 2, color: rgb(0.8, 0.1, 0.1) });
  // 3) Text labels ("N", "S", "Force") around the vector arrows
  p1.drawText("N", { x: 82, y: 400, size: 12, font: bold });
  p1.drawText("S", { x: 372, y: 400, size: 12, font: bold });
  p1.drawText("Force", { x: 215, y: 465, size: 11, font });
  // 4) Figure caption directly below the diagram (y: 310)
  p1.drawText("Figure 16.8: Magnetic field pattern around a solenoid", { x: 95, y: 310, size: 10, font });

  p1.drawText("Reversing the current reverses the magnetic poles of the solenoid.", { x: 45, y: 240, size: 11, font });

  // Page 2 (500 x 700 pt): vector circuit diagram + Fig. 16.9 caption
  const p2 = doc.addPage([500, 700]);
  p2.drawText("Electromagnetic relays switch high-current starter motors safely.", { x: 45, y: 630, size: 11, font });
  p2.drawRectangle({ x: 130, y: 390, width: 220, height: 120, borderWidth: 1.5, borderColor: rgb(0.1, 0.2, 0.4) });
  p2.drawLine({ start: { x: 150, y: 450 }, end: { x: 330, y: 450 }, thickness: 1.5, color: rgb(0.1, 0.2, 0.4) });
  p2.drawText("Coil", { x: 165, y: 460, size: 10, font });
  p2.drawText("Switch", { x: 280, y: 460, size: 10, font });
  p2.drawText("Fig. 16.9 Electromagnetic relay circuit", { x: 130, y: 365, size: 10, font });

  const saved = await doc.save();
  return saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;
}

describe("detectPageFigures & 2x composite figure cropping", () => {
  it("filters tiny header icons, pairs Figure 16.8 / Fig. 16.9 captions, and expands bbox to preserve vector arrows + 'N'/'S'/'Force' labels", async () => {
    const data = await makePhysicsDiagramPdf();
      const task = getDocument({ data: new Uint8Array(data), ...pdfjsAssetOptions(`${pdfjsDir}/`) });
    const pdf = await task.promise;
    try {
      const page1 = await pdf.getPage(1);
      const [content1, ops1] = await Promise.all([page1.getTextContent(), page1.getOperatorList()]);
      const items1 = content1.items.filter((it): it is Extract<typeof it, { str: string }> => "str" in it);
      const detected1 = detectPageFigures(page1.view, items1, ops1);

      // Header icon filtered out; exactly 1 composite figure detected!
      expect(detected1).toHaveLength(1);
      const fig1 = detected1[0]!;
      expect(fig1.label).toBe("Figure 16.8");
      expect(fig1.caption).toContain("Magnetic field pattern around a solenoid");

      // Normalized top-left coordinates [0..1] on 500x700 page:
      // Raster image alone was x: 140..320 (0.28..0.64), yPdf: 360..450 -> top-down yNorm: 0.357..0.486.
      // Composite bbox MUST expand horizontally to cover "N" (x=82 -> ~0.16) and "S" (x=372 -> ~0.76) and vertically to cover "Force" (yPdf=465 -> top-down yNorm ~0.31)!
      expect(fig1.normBox.x).toBeLessThanOrEqual(0.18);
      expect(fig1.normBox.x + fig1.normBox.w).toBeGreaterThanOrEqual(0.75);
      expect(fig1.normBox.y).toBeLessThanOrEqual(0.34);
      expect(fig1.normBox.y + fig1.normBox.h).toBeGreaterThanOrEqual(0.5);
      // Must NOT swallow the top header or bottom paragraph
      expect(fig1.normBox.y).toBeGreaterThan(0.12);
      expect(fig1.normBox.y + fig1.normBox.h).toBeLessThan(0.66);

      // Page 2: pure vector diagram + Fig. 16.9 caption
      const page2 = await pdf.getPage(2);
      const [content2, ops2] = await Promise.all([page2.getTextContent(), page2.getOperatorList()]);
      const items2 = content2.items.filter((it): it is Extract<typeof it, { str: string }> => "str" in it);
      const detected2 = detectPageFigures(page2.view, items2, ops2);
      expect(detected2).toHaveLength(1);
      expect(detected2[0]!.label).toBe("Fig. 16.9");
      expect(detected2[0]!.caption).toContain("Electromagnetic relay circuit");
    } finally {
      await task.destroy();
    }
  });

  it("extractPdfFigures renders pages at 2x composite scale and crops bounded maxSide <= 1200 images with pageOffset support", async () => {
    const data = await makePhysicsDiagramPdf();
    const renderedCalls: { w: number; h: number }[] = [];

    const makeFakeCanvas = (w = 1, h = 1) => {
      const c = {
        width: w,
        height: h,
        getContext: () => ({
          fillStyle: "#ffffff",
          fillRect: () => undefined,
          drawImage: () => undefined,
        }),
        toDataURL: (mime?: string) => {
          renderedCalls.push({ w: c.width, h: c.height });
          return mime === "image/webp" ? "data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAfQ//73v/+BiOh/AAA=" : "data:image/png;base64,iVBORw0KGgo=";
        },
      };
      return c as unknown as HTMLCanvasElement;
    };

    const extracted = await extractPdfFigures(data, {
      assets: `${pdfjsDir}/`,
      pageNumbers: [704, 705],
      pageOffset: 704,
      maxSide: 1200,
      createCanvas: makeFakeCanvas,
      renderPageToCanvas: async (page, viewport, canvas) => {
        // Verify 2x composite viewport scale (500x700 -> ~1000x1400):
        expect(viewport.width).toBeGreaterThanOrEqual(950);
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        void page;
      },
    });

    expect(extracted).toHaveLength(2);
    expect(extracted[0]).toMatchObject({
      pageNo: 704,
      label: "Figure 16.8",
    });
    expect(extracted[0]!.width).toBeLessThanOrEqual(1200);
    expect(extracted[0]!.height).toBeLessThanOrEqual(1200);
    expect(extracted[0]!.width).toBeGreaterThan(200);
    expect(extracted[1]).toMatchObject({
      pageNo: 705,
      label: "Fig. 16.9",
    });

    // cropNormalizedRegion clamps out-of-bounds drag boxes and enforces maxSide <= 1200:
    const fullCanvas = makeFakeCanvas(2000, 2800);
    const manualCrop = cropNormalizedRegion(fullCanvas, { x: -0.1, y: 0.2, w: 0.9, h: 0.8 }, { maxSide: 1200, createCanvas: makeFakeCanvas });
    expect(manualCrop.width).toBeLessThanOrEqual(1200);
    expect(manualCrop.height).toBeLessThanOrEqual(1200);
  });
});
