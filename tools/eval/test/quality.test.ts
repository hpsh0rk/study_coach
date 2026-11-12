import * as fs from "node:fs";
import * as path from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { assertFixtureSafe, assertManualRecordAllowed, loadCorpus, qualityParserPdf, QUALITY_RECORDINGS, recordCase, redactFixture, replayFiles, scoreFixture, syntheticPage } from "../src/quality.ts";

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

  it("accepts both bare quantities and worked full-sentence teacherAnswer strings while rejecting wrong numbers, units, or contradictions", () => {
    const withAnswer = (teacherAnswer: string) => {
      const fixture = JSON.parse(fs.readFileSync(path.join(QUALITY_RECORDINGS, "synthetic-text-v1.json"), "utf8"));
      const response = JSON.parse(fixture.output.raw);
      response.teacherAnswer = teacherAnswer;
      fixture.output.raw = JSON.stringify(response);
      return scoreFixture(fixture);
    };

    for (const valid of [
      "36 m",
      "$36\\,\\mathrm{m}$",
      "36 meters",
      "12 m/s × 3 s = 36 m",
      "Distance equals speed multiplied by time: 12 m/s × 3 s = 36 m, so the cart travels 36 m.",
      "The cart travels 36 m because d = 12 m/s × 3 s.",
    ]) {
      const score = withAnswer(valid);
      expect(score.passed, `expected valid teacherAnswer to pass: ${valid}`).toBe(true);
      expect(score.checks.numbersUnits.passed).toBe(true);
    }

    for (const invalid of [
      "36 km",
      "48 m",
      "36 m/s",
      "36 min",
      "136 m",
      "36",
      "12 m/s × 3 s = 36 km",
      "12 m/s × 3 s = 48 m",
      "Not 36 m; the cart travels 48 m.",
      "36 m or 48 m",
    ]) {
      const score = withAnswer(invalid);
      expect(score.passed, `expected invalid teacherAnswer to fail: ${invalid}`).toBe(false);
      expect(score.checks.numbersUnits.passed).toBe(false);
    }
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

    const liveFormula = scoreFixture({
      ...base,
      caseId: "parser-kinematics-v1",
      target: "parser",
      output: {
        raw: "## 3.1 Equations of motion\n\n$$\n\\mathtt { v } = \\mathtt { u } + \\mathtt { a } \\mathtt { t }\n$$\n\n$$\n\\mathsf { s } = \\mathrm { u t } + \\mathsf { a t } ^ { 2 } / 2\n$$\n\nA car accelerating from rest at $2 ~ \\mathrm { m } / \\mathrm { s } ^ { 2 }$ reaches after ten seconds.",
      },
    });
    expect(liveFormula.passed).toBe(true);
  });

  it("records text via createAiLayer.callStructured (with 1-turn repair) and vision via callVision + cleanVisionText", async () => {
    const textCalls: Record<string, unknown>[] = [];
    const textReplies = [
      '{"summary":"bad"}',
      JSON.stringify({
        summary: "Constant-speed cart travels 36 m in 3 s.",
        citations: [1, 2],
        quantities: [
          { value: 12, unit: "m/s" },
          { value: 3, unit: "s" },
          { value: 36, unit: "m" },
        ],
        studentQuestion: "A cart moves at 12 m/s for 3 s. How far does it travel?",
        teacherAnswer: "36 m",
      }),
    ];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      textCalls.push({ headers: init?.headers, body: JSON.parse(String(init?.body ?? "{}")) });
      const text = textReplies.shift()!;
      const events = [
        { type: "message_start", message: { model: "glm-5.3-flash", usage: { input_tokens: 20, output_tokens: 2 } } },
        { type: "content_block_delta", delta: { type: "text_delta", text } },
        { type: "message_delta", usage: { output_tokens: 15 } },
        { type: "message_stop" },
      ];
      return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    });
    try {
      const textFixture = await recordCase("text", undefined, {
        KJ_QUALITY_TEXT_API_KEY: "sk-secret-local-1234",
        KJ_QUALITY_TEXT_BASE_URL: "https://gateway.example.test/v1",
        KJ_QUALITY_TEXT_MODEL: "glm-5.3-flash",
        KJ_QUALITY_TEXT_PROVIDER: "custom",
        KJ_QUALITY_TEXT_PROTOCOL: "messages",
        KJ_QUALITY_TEXT_HEADERS_JSON: '{"x-source":"manual-eval"}',
      });
      expect(textCalls).toHaveLength(2);
      expect(scoreFixture(textFixture).passed).toBe(true);
      expect(textFixture.metadata).toMatchObject({ inputTokens: 40, outputTokens: 30 });

      spy.mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.thinking).toEqual({ type: "disabled" });
        return Response.json({
          model: "glm-4.6v-flash",
          choices: [{ message: { content: "```markdown\nSYNTHETIC EVAL\nSPEED: 12 M/S\nTIME: 3 S\nDISTANCE = 36 M\n```" } }],
          usage: { prompt_tokens: 100, completion_tokens: 18 },
        });
      });
      const visionFixture = await recordCase("vision", undefined, {
        KJ_QUALITY_VISION_API_KEY: "sk-vision-secret-1234",
        KJ_QUALITY_VISION_BASE_URL: "https://vision.example.test/v4",
        KJ_QUALITY_VISION_MODEL: "glm-4.6v-flash",
        KJ_QUALITY_VISION_PROVIDER: "glm",
      });
      expect(visionFixture.output.raw).not.toContain("```");
      expect(scoreFixture(visionFixture).passed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("records MinerU agent mode with KJPAGE separators and host allowlisting alongside selfhost mode", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const target = String(url);
      if (target === "https://mineru.net/api/v1/agent/parse/file") {
        expect(JSON.parse(String(init?.body))).toMatchObject({ is_ocr: true, enable_formula: true, enable_table: true });
        return Response.json({ code: 0, data: { task_id: "t-ocr", file_url: "https://mineru.oss-cn-shanghai.aliyuncs.com/upload.pdf" } });
      }
      if (target === "https://mineru.oss-cn-shanghai.aliyuncs.com/upload.pdf") {
        const uploaded = await PDFDocument.load(init?.body as Uint8Array);
        expect(uploaded.getPageCount()).toBe(2);
        return new Response(null, { status: 200 });
      }
      if (target === "https://mineru.net/api/v1/agent/parse/t-ocr") {
        return Response.json({ code: 0, data: { state: "done", markdown_url: "https://cdn-mineru.openxlab.org.cn/t-ocr/full.md" } });
      }
      if (target === "https://cdn-mineru.openxlab.org.cn/t-ocr/full.md") {
        return new Response("KJPAGE 1\nSYNTHETIC TEST\nSPEED: 12 M/S\nTIME: 3 S\nDISTANCE = 36 M\n");
      }
      throw new Error(`unexpected URL ${target}`);
    });
    try {
      const agentFixture = await recordCase("parser", "parser-ocr-v1", { KJ_QUALITY_PARSER_MODE: "agent" });
      expect(agentFixture.implementation).toEqual({ kind: "mineru-agent", version: null });
      expect(scoreFixture(agentFixture).passed).toBe(true);

      spy.mockImplementationOnce(async () => Response.json({ code: 0, data: { task_id: "t-bad", file_url: "https://evil.example/upload.pdf" } }));
      await expect(recordCase("parser", "parser-ocr-v1", { KJ_QUALITY_PARSER_MODE: "agent" })).rejects.toThrow(/unexpected upload URL/);
    } finally {
      spy.mockRestore();
    }
  });
});
