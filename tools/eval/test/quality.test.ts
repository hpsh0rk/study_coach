import * as fs from "node:fs";
import * as path from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { assertFixtureSafe, assertManualRecordAllowed, loadCorpus, qualityParserPdf, QUALITY_RECORDINGS, redactFixture, replayFiles, scoreFixture, syntheticPage } from "../src/quality.ts";

describe("manual quality record/replay", () => {
  it("replays every committed fixture offline and passes objective checks", () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline replay attempted network access"));
    const scores = replayFiles();
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
    expect([...new Set(scores.map((score) => score.caseId))].sort()).toEqual(loadCorpus().cases.map((c) => c.id).sort());
    expect(scores).toEqual(scores.map(() => expect.objectContaining({ passed: true })));
    expect(scores[0]!.checks).toMatchObject({
      schema: { passed: true },
      citations: { passed: true },
      numbersUnits: { passed: true },
      answerLeakage: { passed: true },
      metadata: { passed: true },
    });
  });

  it("uses only the fixed, explicitly source-safe corpus", () => {
    const corpus = loadCorpus();
    expect(corpus.sourceSafe).toBe(true);
    expect(corpus.cases.map((c) => c.id)).toEqual(["text-grounding-v1", "vision-transcription-v1", "parser-kinematics-v1", "parser-ocr-v1", "parser-table-v1"]);
    for (const c of corpus.cases) {
      if (c.target === "vision") expect(() => syntheticPage(c.image.lines)).not.toThrow();
      if (c.target === "parser" && c.input.kind === "synthetic-ocr") {
        const lines = c.input.lines;
        expect(() => syntheticPage(lines)).not.toThrow();
      }
    }
    expect(fs.readdirSync(QUALITY_RECORDINGS).every((name) => name.endsWith(".json"))).toBe(true);
  });

  it("allows recording only after explicit confirmation and never in CI", () => {
    expect(() => assertManualRecordAllowed(false, {})).toThrow(/--confirm-real-call/);
    expect(() => assertManualRecordAllowed(true, { CI: "true" })).toThrow(/disabled in CI/);
    expect(() => assertManualRecordAllowed(true, {})).not.toThrow();
  });

  it("redacts known secrets and rejects credential fields or private endpoints", () => {
    expect(redactFixture({ output: "echo sk-local-secret-value" }, ["sk-local-secret-value"])).toEqual({ output: "echo [REDACTED]" });
    expect(() => assertFixtureSafe({ headers: { authorization: "anything" } })).toThrow(/forbidden sensitive field/);
    expect(() => assertFixtureSafe({ output: "Authorization: secret" })).toThrow(/credential/);
    expect(() => assertFixtureSafe({ output: "Bearer abcdefghijklmnop" })).toThrow(/credential/);
    expect(() => assertFixtureSafe({ output: "http://127.0.0.1:8000/v1" })).toThrow(/private endpoint/);
  });

  it("fails replay when the student-facing question leaks the answer", () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(QUALITY_RECORDINGS, "synthetic-text-v1.json"), "utf8"));
    const response = JSON.parse(fixture.output.raw);
    response.studentQuestion = "The correct answer is 36 m. Explain why.";
    fixture.output.raw = JSON.stringify(response);
    const score = scoreFixture(fixture);
    expect(score.passed).toBe(false);
    expect(score.checks.answerLeakage.passed).toBe(false);
  });

  it("generates a stable PNG data URL without loading a document", () => {
    const lines = ["SYNTHETIC EVAL", "SPEED: 12 M/S", "TIME: 3 S", "DISTANCE = 36 M"];
    const first = syntheticPage(lines);
    expect(first).toBe(syntheticPage(lines));
    expect(Buffer.from(first.split(",")[1]!, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("builds valid fixed parser PDFs without loading user documents", async () => {
    const parserCases = loadCorpus().cases.filter((c) => c.target === "parser");
    for (const c of parserCases) {
      const pdf = await PDFDocument.load(await qualityParserPdf(c.input));
      expect(pdf.getPageCount()).toBe(c.input.kind === "pdf" ? 3 : 1);
    }
  });

  it("scores OCR text and requires table cells to remain on their reviewed rows", () => {
    const base = {
      fixtureVersion: 1,
      corpusVersion: 1,
      recordedAt: "2026-11-12T00:00:00.000Z",
      implementation: { kind: "test", version: "1" },
      metadata: { latencyMs: 1, inputTokens: null, outputTokens: null, costUsd: null },
    };
    const ocr = scoreFixture({
      ...base,
      caseId: "parser-ocr-v1",
      target: "parser",
      output: { raw: "SYNTHETIC TEST\nSPEED: 12 M/S\nTIME: 3 S\nDISTANCE = 36 M" },
    });
    expect(ocr.passed).toBe(true);

    const table = {
      ...base,
      caseId: "parser-table-v1",
      target: "parser",
      output: { raw: "SYNTHETIC TABLE\n| time | velocity |\n| --- | --- |\n| 0 s | 12 m/s |\n| 2 s | 20 m/s |" },
    };
    expect(scoreFixture(table).passed).toBe(true);
    table.output.raw = "SYNTHETIC TABLE\ntime\nvelocity\n0 s\n12 m/s\n2 s\n20 m/s";
    const flattened = scoreFixture(table);
    expect(flattened.passed).toBe(false);
    expect(flattened.checks.numbersUnits.passed).toBe(false);
  });
});
