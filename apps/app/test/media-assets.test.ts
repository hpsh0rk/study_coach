import { beforeAll, describe, expect, it } from "vitest";
import { encodeSourcePage, type LessonSource, type Outline } from "@kj/schema";
import { Client, e, loggedIn, seedUser } from "./client.ts";

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function crc32Bytes(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32Bytes(out.subarray(4, 8 + data.length)), false);
  return out;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function zlibStore(raw: Uint8Array): Uint8Array {
  // Valid RFC 1950 zlib stream with uncompressed DEFLATE blocks (<= 65535 bytes)
  const len = raw.length;
  const out = new Uint8Array(2 + 5 + len + 4);
  const view = new DataView(out.buffer);
  out[0] = 0x78;
  out[1] = 0x01;
  out[2] = 0x01; // BFINAL=1, BTYPE=00 (stored)
  view.setUint16(3, len, true);
  view.setUint16(5, (~len) & 0xffff, true);
  out.set(raw, 7);
  view.setUint32(7 + len, adler32(raw), false);
  return out;
}

function makePngDataUrl(width: number, height: number, fillByte = 180): { dataUrl: string; bytes: Uint8Array } {
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr.set([8, 2, 0, 0, 0], 8);
  // Keep raw scanlines tiny even when testing logical header dimensions: use 1-bit grayscale for large headers, 24-bit RGB for small ones
  const useGray1 = height * (1 + width * 3) > 60_000;
  if (useGray1) ihdr.set([1, 0, 0, 0, 0], 8);
  const rowBytes = useGray1 ? 1 + Math.ceil(width / 8) : 1 + width * 3;
  const raw = new Uint8Array(Math.min(60_000, height * rowBytes));
  raw.fill(fillByte);
  for (let y = 0; y * rowBytes < raw.length; y++) raw[y * rowBytes] = 0;
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const cIhdr = pngChunk("IHDR", ihdr);
  const cIdat = pngChunk("IDAT", zlibStore(raw));
  const cIend = pngChunk("IEND", new Uint8Array(0));
  const png = new Uint8Array(sig.length + cIhdr.length + cIdat.length + cIend.length);
  let ptr = 0;
  for (const part of [sig, cIhdr, cIdat, cIend]) {
    png.set(part, ptr);
    ptr += part.length;
  }
  return { dataUrl: `data:image/png;base64,${toBase64(png)}`, bytes: png };
}

function makeWebpDataUrl(width: number, height: number, seed = 1): { dataUrl: string; bytes: Uint8Array } {
  const vp8xPayload = new Uint8Array(10);
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  vp8xPayload[4] = wMinus1 & 0xff;
  vp8xPayload[5] = (wMinus1 >> 8) & 0xff;
  vp8xPayload[6] = (wMinus1 >> 16) & 0xff;
  vp8xPayload[7] = hMinus1 & 0xff;
  vp8xPayload[8] = (hMinus1 >> 8) & 0xff;
  vp8xPayload[9] = (hMinus1 >> 16) & 0xff;
  const dummyChunk = new Uint8Array([0x56, 0x50, 0x38, 0x20, 4, 0, 0, 0, seed & 0xff, 0x2a, 0x01, 0x9d]);
  const bodyLen = 4 + 8 + vp8xPayload.length + dummyChunk.length;
  const riff = new Uint8Array(8 + bodyLen);
  const view = new DataView(riff.buffer);
  const writeAscii = (off: number, str: string) => {
    for (let i = 0; i < str.length; i++) riff[off + i] = str.charCodeAt(i);
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, bodyLen, true);
  writeAscii(8, "WEBP");
  writeAscii(12, "VP8X");
  view.setUint32(16, vp8xPayload.length, true);
  riff.set(vp8xPayload, 20);
  riff.set(dummyChunk, 30);
  return { dataUrl: `data:image/webp;base64,${toBase64(riff)}`, bytes: riff };
}

let teacher1: Client;
let teacher2: Client;
const anon = new Client();

beforeAll(async () => {
  await seedUser("usr_med_t1", "medteacher1", "Teach12345", { mustChange: false });
  await seedUser("usr_med_t2", "medteacher2", "Teach12345", { mustChange: false });
  teacher1 = await loggedIn("medteacher1", "Teach12345");
  teacher2 = await loggedIn("medteacher2", "Teach12345");
});

describe("D1 media_assets storage, deduplication, share access & purge cleanup", () => {
  it("uploads PNG and WebP figures, parses header dimensions, deduplicates by (documentId, pageNo, sha256), and serves immutable binary responses", async () => {
    const docRes = await teacher1.req("POST", "/api/documents", {
      filename: "igcse-ch16.pdf",
      title: "IGCSE Physics Ch16",
      sizeBytes: 20_000,
      pageCount: 730,
      chapters: [{ id: "c16", parentId: null, level: 1, ord: 0, title: "16 Magnetism", pageStart: 693, pageEnd: 726, words: 200 }],
    });
    expect(docRes.status).toBe(201);
    const docId = docRes.json.id as string;
    await teacher1.req("POST", `/api/documents/${docId}/pages`, {
      pages: [
        { no: 704, text: "Figure 16.8 Magnetic field pattern around a current-carrying solenoid." },
        { no: 705, text: "Figure 16.9 Relay circuit using an electromagnet." },
      ],
    });

    const fig1 = makePngDataUrl(480, 320, 120);
    const fig2 = makeWebpDataUrl(640, 400, 7);

    const up1 = await teacher1.req("POST", "/api/media", {
      documentId: docId,
      pageNo: 704,
      label: "Fig 16.8",
      caption: "Magnetic field around a solenoid",
      image: fig1.dataUrl,
    });
    expect(up1.status).toBe(201);
    expect(up1.json.reused).toBe(false);
    expect(up1.json.asset).toMatchObject({
      documentId: docId,
      pageNo: 704,
      label: "Fig 16.8",
      caption: "Magnetic field around a solenoid",
      mime: "image/png",
      width: 480,
      height: 320,
      sizeBytes: fig1.bytes.byteLength,
    });
    const asset1Id = up1.json.asset.id as string;
    expect(asset1Id).toMatch(/^med_/);

    // Re-uploading the exact same image on (docId, 704) deduplicates cleanly:
    const dup = await teacher1.req("POST", "/api/media", {
      documentId: docId,
      pageNo: 704,
      label: "Fig 16.8",
      caption: "Magnetic field around a solenoid",
      image: fig1.dataUrl,
    });
    expect(dup.status).toBe(200);
    expect(dup.json.reused).toBe(true);
    expect(dup.json.asset.id).toBe(asset1Id);

    // Batch upload works for ingestion:
    const batch = await teacher1.req("POST", "/api/media/batch", {
      documentId: docId,
      items: [
        { pageNo: 704, label: "Fig 16.8", caption: "Magnetic field around a solenoid", image: fig1.dataUrl },
        { pageNo: 705, label: "Fig 16.9", caption: "Electromagnetic relay", image: fig2.dataUrl },
      ],
    });
    expect(batch.status).toBe(200);
    expect(batch.json.assets).toHaveLength(2);
    expect(batch.json.assets[0].id).toBe(asset1Id);
    expect(batch.json.assets[1]).toMatchObject({
      pageNo: 705,
      mime: "image/webp",
      width: 640,
      height: 400,
    });

    // Listing by documentId & pages:
    const listed = await teacher1.req("GET", `/api/media?documentId=${docId}&pages=704`);
    expect(listed.status).toBe(200);
    expect(listed.json.assets).toHaveLength(1);
    expect(listed.json.assets[0].id).toBe(asset1Id);

    // Binary GET /api/media/:id with immutable private cache headers:
    const binRes = await teacher1.raw("GET", `/api/media/${asset1Id}`);
    expect(binRes.status).toBe(200);
    expect(binRes.headers.get("content-type")).toBe("image/png");
    expect(binRes.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(binRes.headers.get("x-content-type-options")).toBe("nosniff");
    const gotBytes = new Uint8Array(await binRes.arrayBuffer());
    expect(gotBytes).toEqual(fig1.bytes);

    // Auth & tenant isolation:
    expect((await anon.raw("GET", `/api/media/${asset1Id}`)).status).toBe(401);
    expect((await teacher2.raw("GET", `/api/media/${asset1Id}`)).status).toBe(404);

    // Rejects SVG/HTML disguised as PNG:
    const fakeSvg = `data:image/png;base64,${btoa("<svg onload=alert(1)>")}`;
    const badMime = await teacher1.req("POST", "/api/media", { documentId: docId, pageNo: 704, image: fakeSvg });
    expect(badMime.status).toBe(400);

    // Enforces per-page figure count cap (MAX_FIGURES_PER_PAGE = 6):
    for (let k = 0; k < 5; k++) {
      const extra = makeWebpDataUrl(200 + k, 150, 20 + k);
      const r = await teacher1.req("POST", "/api/media", { documentId: docId, pageNo: 704, label: `Extra ${k}`, image: extra.dataUrl });
      expect(r.status).toBe(201);
    }
    const overPageCap = makeWebpDataUrl(300, 200, 99);
    const capped = await teacher1.req("POST", "/api/media", { documentId: docId, pageNo: 704, label: "Too many", image: overPageCap.dataUrl });
    expect(capped.status).toBe(409);
    expect(capped.json.error.code).toBe("MEDIA_QUOTA");
  });

  it("supports multi-PDF virtual page catalog, PATCH slide figure validation, ?share=<token> scoped access, and permanent purge cleanup", async () => {
    // Primary textbook + secondary Past Paper PDF
    const tb = await teacher1.req("POST", "/api/documents", {
      filename: "coursebook.pdf",
      title: "Physics Coursebook",
      sizeBytes: 10_000,
      pageCount: 20,
      chapters: [{ id: "ch1", parentId: null, level: 1, ord: 0, title: "Ch1 Magnetism", pageStart: 1, pageEnd: 2, words: 120 }],
    });
    const tbId = tb.json.id as string;
    await teacher1.req("POST", `/api/documents/${tbId}/pages`, {
      pages: [
        { no: 1, text: "Bar magnets have North and South poles. Like poles repel and unlike poles attract." },
        { no: 2, text: "Figure 1.2 Plotting compasses around a bar magnet trace magnetic field lines." },
      ],
    });

    const pp = await teacher1.req("POST", "/api/documents", {
      filename: "paper4.pdf",
      title: "0625 Paper 4",
      sizeBytes: 8_000,
      pageCount: 10,
      chapters: [],
    });
    const ppId = pp.json.id as string;
    await teacher1.req("POST", `/api/documents/${ppId}/pages`, {
      pages: [{ no: 5, text: "Question 5 [2 marks]: Fig 5.1 shows a solenoid with a soft-iron core." }],
    });

    const tbFig = await teacher1.req("POST", "/api/media", {
      documentId: tbId,
      pageNo: 2,
      label: "Fig 1.2",
      caption: "Plotting compasses around a bar magnet",
      image: makePngDataUrl(400, 250, 90).dataUrl,
    });
    const tbAssetId = tbFig.json.asset.id as string;

    const unusedFig = await teacher1.req("POST", "/api/media", {
      documentId: tbId,
      pageNo: 1,
      label: "Fig 1.1",
      caption: "Unused bar magnet photo",
      image: makePngDataUrl(360, 240, 140).dataUrl,
    });
    const unusedAssetId = unusedFig.json.asset.id as string;

    const ppFig = await teacher1.req("POST", "/api/media", {
      documentId: ppId,
      pageNo: 5,
      label: "Fig 5.1",
      caption: "Exam solenoid diagram",
      image: makeWebpDataUrl(500, 300, 42).dataUrl,
    });
    const ppAssetId = ppFig.json.asset.id as string;

    const sources: LessonSource[] = [
      { id: "s1", kind: "pdf", documentId: tbId, title: "Physics Coursebook", chapterIds: ["ch1"], ranges: [{ start: 1, end: 2 }], role: "textbook" },
      { id: "s2", kind: "pdf", documentId: ppId, title: "0625 Paper 4", ranges: [{ start: 5, end: 5 }], role: "past_paper" },
    ];
    const les = await teacher1.req("POST", "/api/lessons", {
      documentId: tbId,
      chapterIds: ["ch1"],
      ranges: [{ start: 1, end: 2 }],
      sources,
    });
    expect(les.status).toBe(201);
    const lessonId = les.json.lesson.id as string;

    // Upload a pasted image directly to the lesson:
    const pastedFig = await teacher1.req("POST", "/api/media", {
      lessonId,
      label: "Pasted diagram",
      caption: "Teacher whiteboard sketch",
      image: makePngDataUrl(320, 200, 200).dataUrl,
    });
    expect(pastedFig.status).toBe(201);
    const pastedAssetId = pastedFig.json.asset.id as string;

    // GET /api/media?lessonId=... returns primary, secondary (with virtualPageNo = 100005), and lesson-level assets:
    const lessonMedia = await teacher1.req("GET", `/api/media?lessonId=${lessonId}`);
    expect(lessonMedia.status).toBe(200);
    const byId = new Map<string, any>(lessonMedia.json.assets.map((a: any) => [a.id, a]));
    expect(byId.get(tbAssetId)?.virtualPageNo).toBe(2);
    expect(byId.get(ppAssetId)?.virtualPageNo).toBe(encodeSourcePage(1, 5));
    expect(byId.get(pastedAssetId)?.lessonId).toBe(lessonId);

    // Draft & confirm outline, generate slide, PATCH with valid & invalid figure assetIds:
    const drafted = await teacher1.req("POST", `/api/lessons/${lessonId}/outline`, {});
    const vid = drafted.json.version.id as string;
    const outline: Outline = {
      objectives: ["Plot magnetic field lines around a bar magnet"],
      glossary: [],
      notCovered: [],
      slides: [
        { id: "sp1", pageType: "cover", layout: "title", visual: "none", minutes: 1, title: "Magnetism", purpose: "", keyPoints: [], sourcePages: [], loop: 0 },
        { id: "sp2", pageType: "concept", layout: "statement", visual: "figure", minutes: 4, title: "Field lines run North to South", purpose: "", keyPoints: ["Compass needle aligns"], sourcePages: [2], loop: 1 },
        { id: "sp3", pageType: "exit", layout: "questions", visual: "none", minutes: 3, title: "Exit check", purpose: "", keyPoints: ["Poles"], sourcePages: [1], loop: 0 },
      ],
    };
    const putOut = await teacher1.req("PUT", `/api/lessons/${lessonId}/outline-versions/${vid}`, { outline, rev: drafted.json.version.rev });
    expect(putOut.status).toBe(200);
    await teacher1.req("POST", `/api/lessons/${lessonId}/outline-versions/${vid}/confirm`, { ackOverBudget: true, rev: putOut.json.version.rev });

    const gen2 = await teacher1.req("POST", `/api/lessons/${lessonId}/outline-versions/${vid}/slides/sp2/generate`, {});
    expect(gen2.status).toBe(200);
    const slide2Id = gen2.json.slide.id as string;

    // Rejects unknown/hallucinated assetId on PATCH:
    const badPatch = await teacher1.req("PATCH", `/api/lessons/${lessonId}/slides/${slide2Id}`, {
      content: {
        layout: "statement",
        title: "Field lines run North to South",
        bullets: ["Compass points from N to S"],
        visual: { kind: "figure", assetId: "med_DoesNotExist99", caption: "Hallucinated" },
        terms: [],
      },
    });
    expect(badPatch.status).toBe(422);

    // Accepts valid textbook figure assetId on PATCH:
    const okPatch = await teacher1.req("PATCH", `/api/lessons/${lessonId}/slides/${slide2Id}`, {
      content: {
        layout: "statement",
        title: "Field lines run North to South",
        bullets: ["Compass points from N to S"],
        visual: { kind: "figure", assetId: tbAssetId, caption: "Fig 1.2: Plotting compasses" },
        terms: [],
      },
    });
    expect(okPatch.status).toBe(200);

    // Share the lesson and test ?share=<token> read access:
    const shared = await teacher1.req("POST", `/api/lessons/${lessonId}/share`, { ack: true });
    expect(shared.status).toBe(201);
    const token = (shared.json.path as string).replace(/^\/s\//, "");

    const sharedImg = await anon.raw("GET", `/api/media/${tbAssetId}?share=${encodeURIComponent(token)}`);
    expect(sharedImg.status).toBe(200);
    expect(sharedImg.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");

    // Unreferenced figure on the same textbook is NOT exposed by the share token:
    const unrefImg = await anon.raw("GET", `/api/media/${unusedAssetId}?share=${encodeURIComponent(token)}`);
    expect(unrefImg.status).toBe(404);

    // Revoking share link immediately revokes ?share=<token> access:
    await teacher1.req("DELETE", `/api/lessons/${lessonId}/share`);
    const afterUnshare = await anon.raw("GET", `/api/media/${tbAssetId}?share=${encodeURIComponent(token)}`);
    expect(afterUnshare.status).toBe(404);

    // Permanent purge cleanup:
    // 1. Standalone unused textbook with media_assets:
    const tempDoc = await teacher1.req("POST", "/api/documents", {
      filename: "temp.pdf",
      title: "Temp Book",
      sizeBytes: 4000,
      pageCount: 2,
      chapters: [],
    });
    const tempDocId = tempDoc.json.id as string;
    const tempMedia = await teacher1.req("POST", "/api/media", {
      documentId: tempDocId,
      pageNo: 1,
      label: "Temp Fig",
      image: makePngDataUrl(120, 90, 55).dataUrl,
    });
    const tempAssetId = tempMedia.json.asset.id as string;
    expect((await teacher1.raw("GET", `/api/media/${tempAssetId}`)).status).toBe(200);

    const purged = await teacher1.req("DELETE", `/api/documents/${tempDocId}/permanent`);
    expect(purged.status).toBe(200);
    expect((await teacher1.raw("GET", `/api/media/${tempAssetId}`)).status).toBe(404);
    const remaining = await e.DB.prepare("SELECT COUNT(*) as n FROM media_assets WHERE document_id = ?").bind(tempDocId).first<{ n: number }>();
    expect(remaining?.n).toBe(0);

    // 2. Archive and permanently purge lesson cleans up lesson-attached media_assets:
    await teacher1.req("DELETE", `/api/lessons/${lessonId}`);
    const purgedLesson = await teacher1.req("DELETE", `/api/lessons/${lessonId}/permanent`);
    expect(purgedLesson.status).toBe(200);
    expect((await teacher1.raw("GET", `/api/media/${pastedAssetId}`)).status).toBe(404);
  });
});
