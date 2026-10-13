import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { separatorText } from "@kj/textbook";
import { ApiError } from "../src/api.ts";
import { parseExternally, pdfCutter, type ExternalDeps } from "../src/textbook/external.ts";

const md = (count: number, missing: number[] = []) =>
  Array.from({ length: count }, (_, i) => (missing.includes(i + 1) ? "" : `${separatorText(i + 1)}\n$$ v_${i + 1} = u + a t $$`)).join("\n");

function fakes(over: Partial<ExternalDeps> = {}, opts: { size?: (pages: number[]) => number; missing?: number[] } = {}) {
  const calls = { created: [] as { pages: number[]; ocr: boolean }[], uploaded: [] as number[], saved: [] as number[][], polls: 0 };
  let jobs = 0;
  const pagesOf = new Map<string, number[]>();
  const deps: ExternalDeps = {
    async cut(pages) {
      return new Uint8Array(opts.size?.(pages) ?? pages.length * 100);
    },
    async create(pages, ocr) {
      calls.created.push({ pages, ocr });
      const id = `job${++jobs}`;
      pagesOf.set(id, pages);
      return { reused: [], job: { id, pages } };
    },
    async upload(_job, pdf) {
      calls.uploaded.push(pdf.byteLength);
    },
    async poll() {
      calls.polls++;
      return { state: calls.polls % 2 ? "running" : "ready" };
    },
    async result(job) {
      return new TextEncoder().encode(md(pagesOf.get(job)!.length, opts.missing)).buffer as ArrayBuffer;
    },
    async save(_job, pages) {
      calls.saved.push(pages.map((p) => p.no));
      return pages.map((p) => ({ no: p.no, words: 8, chars: p.text.length, flags: [], parser: "mineru-agent/1" }));
    },
    async sleep() {},
    ...over,
  };
  return { deps, calls };
}

const info = { maxPagesPerJob: 2, maxBytes: 1000 };

describe("external parsing in the browser", () => {
  it("sends scans and broken fonts with OCR, formula pages without, a few pages per job, and maps results back by page", async () => {
    const { deps, calls } = fakes();
    const progress: number[] = [];
    const out = await parseExternally(
      [
        { no: 3, kind: "formula-lost" },
        { no: 5, kind: "scanned" },
        { no: 8, kind: "formula-lost" },
        { no: 9, kind: "formula-lost" },
        { no: 12, kind: "garbled" },
      ],
      info,
      deps,
      (done) => progress.push(done),
    );
    expect(calls.created).toEqual([
      { pages: [5, 12], ocr: true },
      { pages: [3, 8], ocr: false },
      { pages: [9], ocr: false },
    ]);
    expect(calls.saved).toEqual([[5, 12], [3, 8], [9]]);
    expect(out.saved.map((p) => p.no)).toEqual([5, 12, 3, 8, 9]);
    expect(out).toMatchObject({ missed: [], stopped: null });
    expect(progress).toEqual([0, 2, 4, 5]);
  });

  it("halves a sub-PDF over the size limit before creating the job; a single page too large is left for pasting", async () => {
    const { deps, calls } = fakes({}, { size: (p) => (p.includes(7) ? 5000 : p.length * 600) });
    const out = await parseExternally([1, 2, 7].map((no) => ({ no, kind: "formula-lost" as const })), info, deps);
    expect(calls.created.map((c) => c.pages)).toEqual([[1], [2]]);
    expect(out.missed).toEqual([7]);
  });

  it("pages whose separator did not come back are reported, not saved", async () => {
    const { deps, calls } = fakes({}, { missing: [2] });
    const out = await parseExternally([4, 6].map((no) => ({ no, kind: "formula-lost" as const })), info, deps);
    expect(calls.saved).toEqual([[4]]);
    expect(out.missed).toEqual([6]);
  });

  it("stops at a refusal that will not go away (quota), keeping what was read", async () => {
    let n = 0;
    const { deps } = fakes();
    const create = deps.create;
    deps.create = async (pages, ocr) => {
      if (++n === 2) throw new ApiError(429, "PARSE_QUOTA", "你今天的外部解析额度用完了");
      return create(pages, ocr);
    };
    const out = await parseExternally([1, 2, 3, 4, 5].map((no) => ({ no, kind: "formula-lost" as const })), info, deps);
    expect(out.saved.map((p) => p.no)).toEqual([1, 2]);
    expect(out.missed).toEqual([3, 4, 5]);
    expect(out.stopped).toContain("额度");
  });

  it("a job the parser could not take is missed, the run goes on, and the reason is kept for the teacher", async () => {
    let n = 0;
    const { deps } = fakes();
    const create = deps.create;
    deps.create = async (pages, ocr) => {
      if (++n === 1) throw new ApiError(502, "PARSER_FAILED", "外部解析服务出错：unexpected URL");
      return create(pages, ocr);
    };
    const out = await parseExternally([1, 2, 3].map((no) => ({ no, kind: "formula-lost" as const })), { ...info, maxPagesPerJob: 2 }, deps);
    expect(out).toMatchObject({ missed: [1, 2], stopped: null, failure: "外部解析服务出错：unexpected URL" });
    expect(out.saved.map((p) => p.no)).toEqual([3]);
  });

  it("cuts the pages out of the book, each behind a separator page", async () => {
    const book = await PDFDocument.create();
    const font = await book.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 5; i++) book.addPage([300 + i, 400]).drawText(`page ${i}`, { x: 20, y: 200, font });
    const cut = pdfCutter(new Blob([(await book.save()) as Uint8Array<ArrayBuffer>]));
    const sub = await PDFDocument.load(await cut([2, 5]));
    expect(sub.getPages().map((p) => p.getSize().width)).toEqual([302, 302, 305, 305]);
  });
});
