import { describe, expect, it } from "vitest";
import type { ParsedPdf } from "@kj/schema";
import type { DocumentRow, TextbookLookup } from "../src/textbook/api.ts";
import { fileProblem, ingestPdf, sha256Hex, type IngestDeps, type IngestProgress } from "../src/textbook/ingest.ts";

const parsed: ParsedPdf = {
  title: "Waves",
  pageCount: 5,
  toc: [{ title: "1 Waves", page: 1, children: [{ title: "1.1 Speed", page: 3, children: [] }] }],
  pages: Array.from({ length: 5 }, (_, i) => ({ no: i + 1, text: `page ${i + 1} text` })),
};
const file = { name: "waves.pdf", size: 1234, type: "application/pdf", arrayBuffer: async () => new TextEncoder().encode("%PDF-1.7 waves").buffer as ArrayBuffer };
const doc: DocumentRow = { id: "doc_old", filename: "waves.pdf", title: "Waves", pageCount: 5, pagesReceived: 5, hasBookmarks: true, createdAt: 1 };

function fakes(lookups: TextbookLookup[] = [{ status: "none", pageBatch: 2 }], overrides: Partial<IngestDeps> = {}) {
  const calls = { create: [] as unknown[], batches: [] as number[][], parsed: 0, restored: [] as string[], asked: 0, hashes: [] as string[] };
  const deps: IngestDeps = {
    hash: sha256Hex,
    lookup: async (sha) => {
      calls.hashes.push(sha);
      return lookups.shift() ?? { status: "none", pageBatch: 2 };
    },
    parse: async (_d, _t, onProgress) => {
      calls.parsed++;
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
    restore: async (id) => {
      calls.restored.push(id);
    },
    confirmRestore: () => {
      calls.asked++;
      return true;
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("ingestPdf", () => {
  it("a new file: hashes, parses, builds the chapter tree and uploads pages in the server's batch size", async () => {
    const { deps, calls } = fakes();
    const progress: IngestProgress[] = [];
    expect(await ingestPdf(file, deps, (p) => progress.push(p))).toEqual({ id: "doc_1", outcome: "new" });
    const sha = await sha256Hex(await file.arrayBuffer());
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.hashes).toEqual([sha]);
    expect(calls.create).toEqual([
      expect.objectContaining({ filename: "waves.pdf", title: "Waves", sizeBytes: 1234, pageCount: 5, sha256: sha, chapters: [expect.objectContaining({ title: "1 Waves", pageStart: 1, pageEnd: 5 }), expect.objectContaining({ title: "1.1 Speed", pageStart: 3, pageEnd: 5 })] }),
    ]);
    expect(calls.batches).toEqual([[1, 2], [3, 4], [5]]);
    expect(progress[0]).toEqual({ kind: "checking" });
    expect(progress).toContainEqual({ kind: "parsing", done: 5, total: 5 });
    expect(progress.flatMap((p) => (p.kind === "uploading" ? [p.done] : []))).toEqual([0, 2, 4]);
  });

  it("a file already here: no parsing, no upload", async () => {
    const { deps, calls } = fakes([{ status: "ready", document: doc, pageBatch: 2 }]);
    const progress: IngestProgress[] = [];
    expect(await ingestPdf(file, deps, (p) => progress.push(p))).toEqual({ id: "doc_old", outcome: "ready" });
    expect([calls.parsed, calls.create.length, calls.batches.length]).toEqual([0, 0, 0]);
    expect(progress).toEqual([{ kind: "checking" }]);
  });

  it("an interrupted upload: sends only the missing pages to the existing textbook", async () => {
    const { deps, calls } = fakes([{ status: "incomplete", document: { ...doc, pagesReceived: 2 }, missing: [{ start: 2, end: 2 }, { start: 4, end: 5 }], pageBatch: 2 }]);
    expect(await ingestPdf(file, deps)).toEqual({ id: "doc_old", outcome: "resumed" });
    expect(calls.create).toEqual([]);
    expect(calls.batches).toEqual([[2, 4], [5]]);
  });

  it("a deleted copy: restores it when the teacher agrees", async () => {
    const { deps, calls } = fakes([
      { status: "archived", document: doc, pageBatch: 2 },
      { status: "ready", document: doc, pageBatch: 2 },
    ]);
    expect(await ingestPdf(file, deps)).toEqual({ id: "doc_old", outcome: "restored" });
    expect(calls.restored).toEqual(["doc_old"]);
    expect([calls.parsed, calls.create.length]).toEqual([0, 0]);
  });

  it("a deleted copy: uploads a new one when the teacher declines", async () => {
    const { deps, calls } = fakes([{ status: "archived", document: doc, pageBatch: 2 }], { confirmRestore: () => false });
    expect(await ingestPdf(file, deps)).toEqual({ id: "doc_1", outcome: "new" });
    expect(calls.restored).toEqual([]);
    expect(calls.create).toHaveLength(1);
  });

  it("stops at the first failed batch", async () => {
    const { deps, calls } = fakes(undefined, {
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
