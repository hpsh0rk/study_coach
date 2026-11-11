import { posix } from "node:path";
import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";
import { exportPptx, FONT_NOTE, PPTX_FONT } from "../src/index.ts";
import { PNG_1PX, slideMarkers, structuralDeck } from "./fixtures/structural-regression.ts";

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

async function packageSemantics(zip: JSZip) {
  const names = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name)
    .sort();
  const xmlOf = (part: string) => zip.file(part)!.async("string");
  const relParts = names.filter((name) => name.endsWith(".rels"));
  const slideParts = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const noteParts = names.filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name));
  const chartParts = names.filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
  const mediaParts = names.filter((name) => name.startsWith("ppt/media/"));
  const workbookParts = names.filter((name) => name.startsWith("ppt/embeddings/") && name.endsWith(".xlsx"));
  const chartIds = new Map(chartParts.map((part, index) => [/chart(\d+)\.xml$/.exec(part)![1]!, index + 1]));
  const workbookIds = new Map(workbookParts.map((part, index) => [/Worksheet(\d+)\.xlsx$/.exec(part)![1]!, index + 1]));
  const canonicalPart = (part: string) =>
    part
      .replace(/chart(\d+)/g, (_, id: string) => `chart${chartIds.get(id) ?? id}`)
      .replace(/Microsoft_Excel_Worksheet(\d+)/g, (_, id: string) => `Microsoft_Excel_Worksheet${workbookIds.get(id) ?? id}`);

  return {
    names: names.map(canonicalPart),
    relationships: Object.fromEntries(
      await Promise.all(
        relParts.map(async (part) => [
          canonicalPart(part),
          relationships(await xmlOf(part)).map(({ id, type, target, external }) => ({
            id,
            type,
            target: external ? target : canonicalPart(resolveTarget(part, target)),
            external,
          })),
        ]),
      ),
    ),
    slides: await Promise.all(slideParts.map(async (part) => taggedValues(await xmlOf(part), "a:t"))),
    notes: await Promise.all(noteParts.map(async (part) => taggedValues(await xmlOf(part), "a:t"))),
    charts: await Promise.all(chartParts.map(async (part) => taggedValues(await xmlOf(part), "c:v"))),
    media: await Promise.all(mediaParts.map(async (part) => [...await zip.file(part)!.async("uint8array")])),
    workbooks: await Promise.all(
      workbookParts.map(async (part) => {
        const workbook = await JSZip.loadAsync(await zip.file(part)!.async("uint8array"));
        const strings = workbook.file("xl/sharedStrings.xml");
        const sheets = Object.values(workbook.files)
          .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name))
          .sort((a, b) => a.name.localeCompare(b.name));
        return {
          strings: strings ? taggedValues(await strings.async("string"), "t") : [],
          values: await Promise.all(sheets.map(async (sheet) => taggedValues(await sheet.async("string"), "v"))),
        };
      }),
    ),
  };
}

describe("structural PPTX regression fixture", () => {
  type ExportResult = Awaited<ReturnType<typeof exportPptx>>;

  let first: ExportResult;
  let second: ExportResult;
  let zip: JSZip;
  let secondZip: JSZip;
  let slideParts: string[];
  let slideXml: string[];

  const xml = async (part: string) => {
    const file = zip.file(part);
    expect(file, `missing ${part}`).not.toBeNull();
    return file!.async("string");
  };

  beforeAll(async () => {
    first = await exportPptx(structuralDeck, { chartImage: async () => PNG_1PX });
    second = await exportPptx(structuralDeck, { chartImage: async () => PNG_1PX });
    zip = await JSZip.loadAsync(first.data);
    secondZip = await JSZip.loadAsync(second.data);

    const presentation = await xml("ppt/presentation.xml");
    const presentationRelsPath = "ppt/_rels/presentation.xml.rels";
    const rels = relationships(await xml(presentationRelsPath));
    const byId = new Map(rels.map((rel) => [rel.id, rel]));
    const slideIds = [...presentation.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((match) => match[1]!);
    slideParts = slideIds.map((id) => resolveTarget(presentationRelsPath, byId.get(id)!.target));
    slideXml = await Promise.all(slideParts.map(xml));
  });

  it("is semantically deterministic across repeated offline exports", async () => {
    expect(second.plans).toEqual(first.plans);
    expect(second.degraded).toEqual(first.degraded);
    expect(second.overflow).toEqual(first.overflow);
    expect(first.degraded).toEqual([{ slide: 2, what: ["poll"] }]);
    expect(first.overflow).toEqual([]);
    expect(await packageSemantics(secondZip)).toEqual(await packageSemantics(zip));
  });

  it("preserves slide count, relationship-defined order, sources, text, and answer privacy", async () => {
    expect(slideParts).toEqual(["ppt/slides/slide1.xml", "ppt/slides/slide2.xml", "ppt/slides/slide3.xml", "ppt/slides/slide4.xml"]);
    slideXml.forEach((source, index) => expect(taggedValues(source, "a:t")).toContain(slideMarkers[index]));

    expect(taggedValues(slideXml[0]!, "a:t")).toEqual(
      expect.arrayContaining(["01 波速 Ω <来源>", "速度 = 340.5 m/s", "保留 & 符号", "教材 p. xii, 1"]),
    );
    const visibleText = slideXml.flatMap((source) => taggedValues(source, "a:t")).join("\n");
    expect(visibleText).not.toContain("ANSWER-EXPLANATION-SECRET");
    expect(visibleText).not.toContain("MISCONCEPTION-A-SECRET");
    expect(visibleText).not.toContain("MISCONCEPTION-C-SECRET");
    expect(visibleText).not.toContain("答案 Answer");
    expect(await xml("docProps/app.xml")).toContain("<Slides>4</Slides>");
  });

  it("keeps each speaker note linked to its slide, including hidden answers and font fallback guidance", async () => {
    for (const [index, slidePart] of slideParts.entries()) {
      const slideRelsPath = relsPathFor(slidePart);
      const noteRel = relationships(await xml(slideRelsPath)).find((rel) => rel.type.endsWith("/notesSlide"));
      expect(noteRel, `notes relationship for slide ${index + 1}`).toBeDefined();
      const notePart = resolveTarget(slideRelsPath, noteRel!.target);
      const noteText = taggedValues(await xml(notePart), "a:t").join("\n");
      expect(noteText).toContain(`NOTE-0${index + 1}`);

      const noteRelsPath = relsPathFor(notePart);
      const backLink = relationships(await xml(noteRelsPath)).find((rel) => rel.type.endsWith("/slide"));
      expect(resolveTarget(noteRelsPath, backLink!.target)).toBe(slidePart);
    }

    const quizNotes = taggedValues(await xml("ppt/notesSlides/notesSlide2.xml"), "a:t").join("\n");
    expect(quizNotes).toContain("答案 Answer：C. 0.75");
    expect(quizNotes).toContain("ANSWER-EXPLANATION-SECRET");
    expect(quizNotes).toContain("MISCONCEPTION-A-SECRET");
    expect(taggedValues(await xml("ppt/notesSlides/notesSlide1.xml"), "a:t").join("\n")).toContain(FONT_NOTE);
  });

  it("preserves native chart caches, embedded workbook values, and native table cells", async () => {
    const chartSlidePart = slideParts[2]!;
    const chartSlideRelsPath = relsPathFor(chartSlidePart);
    const chartRel = relationships(await xml(chartSlideRelsPath)).find((rel) => rel.type.endsWith("/chart"));
    const chartPart = resolveTarget(chartSlideRelsPath, chartRel!.target);
    const chart = await xml(chartPart);
    expect(taggedValues(chart, "c:v")).toEqual(expect.arrayContaining(["测量值", "甲&乙", "β<γ", "零", "0.125", "-3.5", "1200"]));

    const chartRelsPath = relsPathFor(chartPart);
    const workbookRel = relationships(await xml(chartRelsPath)).find((rel) => rel.type.endsWith("/package"));
    const workbookPart = resolveTarget(chartRelsPath, workbookRel!.target);
    const workbook = await JSZip.loadAsync(await zip.file(workbookPart)!.async("uint8array"));
    const sharedStrings = await workbook.file("xl/sharedStrings.xml")!.async("string");
    const sheet = await workbook.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(taggedValues(sharedStrings, "t")).toEqual(expect.arrayContaining(["测量值", "甲&乙", "β<γ", "零"]));
    expect(taggedValues(sheet, "v")).toEqual(expect.arrayContaining(["0.125", "-3.5", "1200"]));

    expect(taggedValues(slideXml[3]!, "a:t")).toEqual(
      expect.arrayContaining(["量 & 单位", "精确值", "速度 <v>", "340.5 m/s", "频率 f", "2.50 Hz", "TABLE-CAPTION-04"]),
    );
    expect(slideXml[3]).toContain("<a:tbl>");
  });

  it("keeps image relationships, language metadata, and explicit non-embedded font fallback metadata", async () => {
    const firstSlideRelsPath = relsPathFor(slideParts[0]!);
    const imageRel = relationships(await xml(firstSlideRelsPath)).find((rel) => rel.type.endsWith("/image"));
    expect(imageRel).toBeDefined();
    const imagePart = resolveTarget(firstSlideRelsPath, imageRel!.target);
    expect(imagePart).toMatch(/^ppt\/media\/.+\.png$/);
    expect([...await zip.file(imagePart)!.async("uint8array")].slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    const theme = await xml("ppt/theme/theme1.xml");
    expect(theme.match(new RegExp(`<a:latin typeface="${PPTX_FONT}"`, "g"))).toHaveLength(2);
    expect(slideXml[0]).toContain(`<a:ea typeface="${PPTX_FONT}"`);
    expect(slideXml[0]).toContain('lang="zh-CN"');
    expect(slideXml[1]).toContain('lang="en-US"');
    expect(Object.keys(zip.files).some((name) => name.startsWith("ppt/fonts/"))).toBe(false);
  });

  it("has valid internal package relationships and content-type declarations without external targets", async () => {
    const relParts = Object.keys(zip.files).filter((name) => name.endsWith(".rels"));
    for (const relsPart of relParts) {
      const rels = relationships(await xml(relsPart));
      expect(new Set(rels.map((rel) => rel.id)).size, `${relsPart} relationship IDs`).toBe(rels.length);
      for (const rel of rels) {
        expect(rel.external, `${relsPart} ${rel.id}`).toBe(false);
        expect(zip.file(resolveTarget(relsPart, rel.target)), `${relsPart} -> ${rel.target}`).not.toBeNull();
      }
    }

    const contentTypes = await xml("[Content_Types].xml");
    const defaults = new Set([...contentTypes.matchAll(/<Default Extension="([^"]+)"/g)].map((match) => match[1]!));
    const overrides = new Set([...contentTypes.matchAll(/<Override PartName="\/([^"]+)"/g)].map((match) => match[1]!));
    const payloadParts = Object.values(zip.files).filter((entry) => !entry.dir && entry.name !== "[Content_Types].xml" && !entry.name.endsWith(".rels"));
    for (const part of payloadParts) {
      const extension = posix.extname(part.name).slice(1);
      expect(overrides.has(part.name) || defaults.has(extension), `content type for ${part.name}`).toBe(true);
    }
  });
});
