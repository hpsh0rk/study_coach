import { describe, expect, it } from "vitest";
import type { ParsedPdf } from "@kj/schema";
import { fileProblem, ingestPdf, type IngestDeps, type IngestProgress } from "../src/textbook/ingest.ts";

const parsed: ParsedPdf = {
  title: "Waves",
  pageCount: 5,
  toc: [{ title: "1 Waves", page: 1, children: [{ title: "1.1 Speed", page: 3, children: [] }] }],
  pages: Array.from({ length: 5 }, (_, i) => ({ no: i + 1, text: `page ${i + 1} text` })),
};
const file = { name: "waves.pdf", size: 1234, type: "application/pdf", arrayBuffer: async () => new ArrayBuffer(8) };

function fakes(overrides: Partial<IngestDeps> = {}) {
  const calls: { create: unknown[]; batches: number[][] } = { create: [], batches: [] };
  const deps: IngestDeps = {
    parse: async (_d, _t, onProgress) => {
      onProgress(5, 5);
      return parsed;
    },
    create: async (body) => {
      calls.create.push(body);
      return { id: "doc_1", pageBatch: 2 };
    },
    putPages: async (_id, pages) => {
      calls.batches.push(pages.map((p) => p.no));
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("ingestPdf", () => {
  it("parses, builds the chapter tree and uploads pages in the server's batch size", async () => {
    const { deps, calls } = fakes();
    const progress: IngestProgress[] = [];
    expect(await ingestPdf(file, deps, (p) => progress.push(p))).toBe("doc_1");
    expect(calls.create).toEqual([
      expect.objectContaining({ filename: "waves.pdf", title: "Waves", sizeBytes: 1234, pageCount: 5, chapters: [expect.objectContaining({ title: "1 Waves", pageStart: 1, pageEnd: 5 }), expect.objectContaining({ title: "1.1 Speed", pageStart: 3, pageEnd: 5 })] }),
    ]);
    expect(calls.batches).toEqual([[1, 2], [3, 4], [5]]);
    expect(progress[0]).toEqual({ kind: "parsing", done: 0, total: 1 });
    expect(progress).toContainEqual({ kind: "parsing", done: 5, total: 5 });
    expect(progress.filter((p) => p.kind === "uploading").map((p) => p.done)).toEqual([0, 2, 4]);
  });

  it("stops at the first failed batch", async () => {
    const { deps, calls } = fakes({
      putPages: async (_id, pages) => {
        calls.batches.push(pages.map((p) => p.no));
        if (pages[0]!.no === 3) throw new Error("network");
      },
    });
    await expect(ingestPdf(file, deps)).rejects.toThrow("network");
    expect(calls.batches).toEqual([[1, 2], [3, 4]]);
  });
});

describe("fileProblem", () => {
  it("accepts PDFs up to 200 MB only", () => {
    expect(fileProblem(file)).toBeNull();
    expect(fileProblem({ name: "notes.docx", size: 10, type: "application/msword" })).toMatch(/PDF/);
    expect(fileProblem({ name: "big.pdf", size: 201 * 1024 * 1024, type: "application/pdf" })).toMatch(/200 MB/);
  });
});
