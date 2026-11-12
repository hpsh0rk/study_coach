/**
 * Manual real-service recording and offline replay for a tiny, source-safe quality corpus.
 *
 * Network calls are impossible unless `record`, one target, and `--confirm-real-call` are all supplied.
 * Replay reads committed JSON only and is exercised by the eval package tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { deflateSync } from "node:zlib";
import { chatCompletion, ProviderKind, ProviderProtocol, type ChatMessage, type ImageMessage, type ProviderConfig } from "@kj/ai";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { z } from "zod";
import { parseArgs, readJson, writeJson } from "./common.ts";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
export const QUALITY_CORPUS = path.join(ROOT, "tools/eval/fixtures/quality-corpus.json");
export const QUALITY_RECORDINGS = path.join(ROOT, "tools/eval/fixtures/quality-recordings");

const Quantity = z.object({ value: z.number(), unit: z.string().min(1) }).strict();
const TextAnswer = z
  .object({
    summary: z.string().min(1),
    citations: z.array(z.number().int().positive()).min(1),
    quantities: z.array(Quantity),
    studentQuestion: z.string().min(1),
    teacherAnswer: z.string().min(1),
  })
  .strict();

const ExpectedText = z.object({
  citations: z.array(z.number().int().positive()),
  quantities: z.array(Quantity),
  teacherAnswer: z.string(),
  forbiddenStudentAnswer: z.string(),
});
const ExpectedTranscription = z.object({
  snippets: z.array(z.string()),
  numbers: z.array(z.number()),
  units: z.array(z.string()),
  tableRows: z.array(z.array(z.string()).min(2)).optional(),
});
const TextCase = z.object({
  id: z.string(),
  target: z.literal("text"),
  promptVersion: z.string(),
  sourcePages: z.array(z.object({ no: z.number().int().positive(), text: z.string() })),
  expected: ExpectedText,
});
const VisionCase = z.object({
  id: z.string(),
  target: z.literal("vision"),
  promptVersion: z.string(),
  image: z.object({ generator: z.literal("synthetic-page-v1"), lines: z.array(z.string()).length(4) }),
  expected: ExpectedTranscription,
});
const ParserInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pdf"), path: z.string() }),
  z.object({ kind: z.literal("synthetic-ocr"), lines: z.array(z.string()).length(4) }),
  z.object({
    kind: z.literal("synthetic-table"),
    title: z.string(),
    columns: z.array(z.string()).length(2),
    rows: z.array(z.array(z.string()).length(2)).min(1),
  }),
]);
const ParserCase = z.object({
  id: z.string(),
  target: z.literal("parser"),
  promptVersion: z.string(),
  ocrMode: z.enum(["auto", "ocr"]).default("auto"),
  input: ParserInput,
  expected: ExpectedTranscription,
});
const QualityCase = z.discriminatedUnion("target", [TextCase, VisionCase, ParserCase]);
export type QualityCase = z.infer<typeof QualityCase>;
const Corpus = z.object({
  version: z.literal(1),
  sourceSafe: z.literal(true),
  provenance: z.string(),
  cases: z.array(QualityCase),
});

const Fixture = z.object({
  fixtureVersion: z.literal(1),
  corpusVersion: z.literal(1),
  caseId: z.string(),
  target: z.enum(["text", "vision", "parser"]),
  recordedAt: z.string().datetime(),
  implementation: z.object({
    kind: z.string(),
    model: z.string().optional(),
    protocol: z.string().optional(),
    version: z.string().nullable().optional(),
  }),
  output: z.object({ raw: z.string() }),
  metadata: z.object({
    latencyMs: z.number().nonnegative(),
    inputTokens: z.number().nonnegative().nullable(),
    outputTokens: z.number().nonnegative().nullable(),
    costUsd: z.number().nonnegative().nullable(),
  }),
});
export type QualityFixture = z.infer<typeof Fixture>;

export interface QualityCheck {
  passed: boolean;
  detail: string;
}
export interface QualityScore {
  caseId: string;
  target: QualityCase["target"];
  passed: boolean;
  checks: {
    schema: QualityCheck;
    citations: QualityCheck;
    numbersUnits: QualityCheck;
    answerLeakage: QualityCheck;
    metadata: QualityCheck;
  };
}

export function loadCorpus(): z.infer<typeof Corpus> {
  return Corpus.parse(readJson(QUALITY_CORPUS));
}

function jsonObject(text: string): unknown {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object");
  return JSON.parse(clean.slice(start, end + 1));
}

const unit = (s: string) =>
  s
    .toLowerCase()
    .replace(/²/g, "^2")
    .replace(/\\mathrm|\\text/g, "")
    .replace(/[{}$~\s]/g, "");
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);

function numbersIn(text: string): number[] {
  return [...text.matchAll(/(?<![A-Za-z])[-+]?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}

function scoreText(c: z.infer<typeof TextCase>, raw: string): Omit<QualityScore["checks"], "metadata"> {
  let parsed: z.infer<typeof TextAnswer> | undefined;
  let schema: QualityCheck;
  try {
    parsed = TextAnswer.parse(jsonObject(raw));
    schema = { passed: true, detail: "strict response schema accepted" };
  } catch (err) {
    schema = { passed: false, detail: `invalid response: ${(err as Error).message.slice(0, 180)}` };
  }
  if (!parsed) {
    const blocked = { passed: false, detail: "not scored because schema failed" };
    return { schema, citations: blocked, numbersUnits: blocked, answerLeakage: blocked };
  }
  const validPages = new Set(c.sourcePages.map((p) => p.no));
  const citationsOk = c.expected.citations.every((n) => parsed!.citations.includes(n)) && parsed.citations.every((n) => validPages.has(n));
  const quantitiesOk = c.expected.quantities.every((want) => parsed!.quantities.some((got) => close(got.value, want.value) && unit(got.unit) === unit(want.unit)));
  const answerOk = unit(parsed.teacherAnswer) === unit(c.expected.teacherAnswer);
  const student = parsed.studentQuestion.toLowerCase();
  const leakage = student.includes(c.expected.forbiddenStudentAnswer.toLowerCase()) || /\b(correct answer|answer\s*:)\b/i.test(student);
  return {
    schema,
    citations: { passed: citationsOk, detail: citationsOk ? "required citations are present and in corpus range" : `expected only corpus pages including ${c.expected.citations.join(", ")}` },
    numbersUnits: { passed: quantitiesOk && answerOk, detail: quantitiesOk && answerOk ? "all expected values, units, and teacher answer match" : "one or more expected values/units/answer are missing or changed" },
    answerLeakage: { passed: !leakage, detail: leakage ? "studentQuestion reveals or labels the answer" : "studentQuestion does not reveal the teacher answer" },
  };
}

function scoreTranscription(c: z.infer<typeof VisionCase> | z.infer<typeof ParserCase>, raw: string): Omit<QualityScore["checks"], "metadata"> {
  const normalized = unit(raw);
  const snippetsOk = c.expected.snippets.every((s) => normalized.includes(unit(s)));
  const gotNumbers = numbersIn(raw);
  const numbersOk = c.expected.numbers.every((n) => gotNumbers.some((got) => close(got, n)));
  const unitsOk = c.expected.units.every((u) => normalized.includes(unit(u)));
  const lines = raw
    .replace(/<\/tr\s*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .split(/\r?\n/)
    .map(unit);
  const tableRowsOk = (c.expected.tableRows ?? []).every((row) =>
    lines.some((line) => {
      let from = 0;
      return row.every((cell) => {
        const at = line.indexOf(unit(cell), from);
        if (at < 0) return false;
        from = at + unit(cell).length;
        return true;
      });
    }),
  );
  return {
    schema: { passed: raw.trim().length > 0, detail: raw.trim() ? "non-empty transcription" : "empty transcription" },
    citations: { passed: true, detail: "not applicable to page transcription" },
    numbersUnits: {
      passed: snippetsOk && numbersOk && unitsOk && tableRowsOk,
      detail:
        snippetsOk && numbersOk && unitsOk && tableRowsOk
          ? `required text, numbers, units${c.expected.tableRows?.length ? ", and table rows" : ""} were transcribed`
          : "required text, numbers, units, or table-row structure are missing",
    },
    answerLeakage: { passed: true, detail: "not applicable to page transcription" },
  };
}

export function scoreFixture(input: unknown, corpus = loadCorpus()): QualityScore {
  const fixture = Fixture.parse(input);
  assertFixtureSafe(fixture);
  const c = corpus.cases.find((item) => item.id === fixture.caseId);
  if (!c) throw new Error(`fixture references unknown case ${fixture.caseId}`);
  if (c.target !== fixture.target) throw new Error(`${fixture.caseId}: target does not match corpus`);
  const checks = c.target === "text" ? scoreText(c, fixture.output.raw) : scoreTranscription(c, fixture.output.raw);
  const m = fixture.metadata;
  const metadataOk = Number.isFinite(m.latencyMs) && m.latencyMs >= 0 && (m.inputTokens === null || m.inputTokens >= 0) && (m.outputTokens === null || m.outputTokens >= 0);
  const all = { ...checks, metadata: { passed: metadataOk, detail: metadataOk ? "latency and available usage/cost fields are typed" : "invalid metadata" } };
  return { caseId: c.id, target: c.target, passed: Object.values(all).every((x) => x.passed), checks: all };
}

const FORBIDDEN_KEYS = /^(?:api[-_]?key|authorization|headers?|base[-_]?url|endpoint|access[-_]?token|secret)$/i;
const CREDENTIAL_TEXT = /(?:authorization\s*:|bearer\s+[A-Za-z0-9._~+/-]{8,}|sk-[A-Za-z0-9_-]{8,}|api[_ -]?key\s*[:=])/i;
const PRIVATE_URL = /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[^/\s]+\.internal)(?=[:/\s]|$)/i;

export function redactFixture<T>(value: T, secrets: string[]): T {
  const scrub = (x: unknown): unknown => {
    if (typeof x === "string") return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join("[REDACTED]"), x);
    if (Array.isArray(x)) return x.map(scrub);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, scrub(v)]));
    return x;
  };
  return scrub(value) as T;
}

export function assertFixtureSafe(value: unknown): void {
  const visit = (x: unknown, at: string) => {
    if (typeof x === "string") {
      if (CREDENTIAL_TEXT.test(x)) throw new Error(`${at}: possible credential or authorization header`);
      if (PRIVATE_URL.test(x)) throw new Error(`${at}: private endpoint must not be recorded`);
      return;
    }
    if (Array.isArray(x)) return x.forEach((v, i) => visit(v, `${at}[${i}]`));
    if (!x || typeof x !== "object") return;
    for (const [k, v] of Object.entries(x)) {
      if (FORBIDDEN_KEYS.test(k)) throw new Error(`${at}.${k}: forbidden sensitive field`);
      visit(v, `${at}.${k}`);
    }
  };
  visit(value, "fixture");
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, sum]);
}

const FONT: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "/": ["00001", "00010", "00100", "01000", "10000", "00000", "00000"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  "=": ["00000", "11111", "00000", "11111", "00000", "00000", "00000"],
};

/** Deterministic PNG generated from corpus text; no image or user document is loaded. */
export function syntheticPage(lines: string[]): string {
  const width = 720;
  const height = 500;
  const rgb = Buffer.alloc(width * height * 3, 255);
  const draw = (text: string, x: number, y: number, scale: number) => {
    for (const char of text) {
      if (char === " ") {
        x += 4 * scale;
        continue;
      }
      const glyph = FONT[char];
      if (!glyph) throw new Error(`synthetic-page-v1 has no glyph for ${JSON.stringify(char)}`);
      glyph.forEach((row, gy) =>
        [...row].forEach((on, gx) => {
          if (on !== "1") return;
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++) {
              const p = ((y + gy * scale + dy) * width + x + gx * scale + dx) * 3;
              rgb.fill(17, p, p + 3);
            }
        }),
      );
      x += 6 * scale;
    }
  };
  const positions: [number, number][] = [
    [45, 6],
    [145, 8],
    [245, 8],
    [355, 7],
  ];
  lines.forEach((line, i) => draw(line, 55, positions[i]![0], positions[i]![1]));
  const rows = Buffer.concat(Array.from({ length: height }, (_, y) => Buffer.concat([Buffer.from([0]), rgb.subarray(y * width * 3, (y + 1) * width * 3)])));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(rows, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

function providerFromEnv(target: "text" | "vision", env: NodeJS.ProcessEnv): { provider: ProviderConfig; model: string } {
  const prefix = target === "text" ? "KJ_QUALITY_TEXT_" : "KJ_QUALITY_VISION_";
  const apiKey = env[`${prefix}API_KEY`];
  const baseUrl = env[`${prefix}BASE_URL`];
  const model = env[`${prefix}MODEL`];
  if (!apiKey || !baseUrl || !model) throw new Error(`${target}: set ${prefix}API_KEY, ${prefix}BASE_URL, and ${prefix}MODEL locally`);
  const kind = ProviderKind.parse(env[`${prefix}PROVIDER`] ?? "custom");
  const protocol = ProviderProtocol.parse(env[`${prefix}PROTOCOL`] ?? "openai");
  const maxTokens = env[`${prefix}MAX_TOKENS`] ? Number(env[`${prefix}MAX_TOKENS`]) : undefined;
  const headers = env[`${prefix}HEADERS_JSON`] ? z.record(z.string(), z.string()).parse(JSON.parse(env[`${prefix}HEADERS_JSON`]!)) : undefined;
  return { provider: { id: `quality-${target}`, kind, name: `quality-${target}`, apiKey, baseUrl, protocol, maxTokens, headers }, model };
}

function textMessages(c: z.infer<typeof TextCase>): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        'Use only the supplied synthetic source. Return one strict JSON object with keys summary, citations, quantities ({value,unit}), studentQuestion, teacherAnswer. Cite page numbers. The studentQuestion must ask for the result without revealing it; put the result only in teacherAnswer.',
    },
    { role: "user", content: c.sourcePages.map((p) => `[p.${p.no}] ${p.text}`).join("\n") },
  ];
}

const VISION_PROMPT =
  "Transcribe every line in this synthetic evaluation image in reading order. Copy every number and unit exactly; use [?] if unreadable. Output only the transcription.";

async function recordModel(c: z.infer<typeof TextCase> | z.infer<typeof VisionCase>, env: NodeJS.ProcessEnv) {
  const configured = providerFromEnv(c.target, env);
  const messages: (ChatMessage | ImageMessage)[] =
    c.target === "text"
      ? textMessages(c)
      : [{ role: "user", content: [{ type: "image_url", image_url: { url: syntheticPage(c.image.lines) } }, { type: "text", text: VISION_PROMPT }] }];
  const started = Date.now();
  const response = await chatCompletion(configured.provider, {
    model: configured.model,
    messages,
    temperature: 0,
    json: c.target === "text",
    maxTokens: c.target === "text" ? 900 : 500,
    timeoutMs: 90_000,
  });
  return {
    implementation: { kind: configured.provider.kind, model: response.model, protocol: configured.provider.protocol ?? "openai" },
    output: { raw: response.text },
    metadata: { latencyMs: Date.now() - started, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, costUsd: null },
    secrets: [configured.provider.apiKey, ...Object.values(configured.provider.headers ?? {})],
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function parserJson<T>(url: string, apiKey: string | undefined, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`parser HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function qualityParserPdf(input: z.infer<typeof ParserInput>): Promise<Uint8Array> {
  if (input.kind === "pdf") return fs.readFileSync(path.resolve(path.dirname(QUALITY_CORPUS), input.path));
  const doc = await PDFDocument.create();
  doc.setTitle(input.kind === "synthetic-ocr" ? "Source-safe OCR quality fixture" : "Source-safe table quality fixture");
  doc.setCreationDate(new Date("2026-01-01T00:00:00.000Z"));
  doc.setModificationDate(new Date("2026-01-01T00:00:00.000Z"));
  const page = doc.addPage([720, 500]);
  if (input.kind === "synthetic-ocr") {
    const png = syntheticPage(input.lines).split(",")[1]!;
    const image = await doc.embedPng(Buffer.from(png, "base64"));
    page.drawImage(image, { x: 0, y: 0, width: 720, height: 500 });
  } else {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText(input.title, { x: 70, y: 430, size: 24, font });
    const left = 70;
    const top = 370;
    const width = 580;
    const rowHeight = 54;
    const rows = [input.columns, ...input.rows];
    for (let i = 0; i <= rows.length; i++) page.drawLine({ start: { x: left, y: top - i * rowHeight }, end: { x: left + width, y: top - i * rowHeight }, thickness: 1 });
    for (const x of [left, left + width / 2, left + width]) page.drawLine({ start: { x, y: top }, end: { x, y: top - rows.length * rowHeight }, thickness: 1 });
    rows.forEach((row, i) =>
      row.forEach((cell, j) => page.drawText(cell, { x: left + j * (width / 2) + 18, y: top - i * rowHeight - 34, size: i === 0 ? 18 : 16, font })),
    );
  }
  return doc.save({ useObjectStreams: false });
}

async function recordParser(c: z.infer<typeof ParserCase>, env: NodeJS.ProcessEnv) {
  const entered = env.KJ_QUALITY_PARSER_BASE_URL;
  if (!entered) throw new Error("parser: set KJ_QUALITY_PARSER_BASE_URL locally (and KJ_QUALITY_PARSER_API_KEY when required)");
  const base = entered.replace(/\/+$/, "").replace(/\/v1$/, "");
  const key = env.KJ_QUALITY_PARSER_API_KEY;
  const started = Date.now();
  const health = await parserJson<{ version?: string }>(`${base}/v1/health`, key);
  const pdf = await qualityParserPdf(c.input);
  const query = new URLSearchParams({ filename: `${c.id}.pdf`, ocr_mode: c.ocrMode, output_formats: "markdown" });
  const created = await parserJson<{ task_id?: string }>(`${base}/v1/tasks?${query}`, key, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: Buffer.from(pdf),
  });
  if (!created.task_id) throw new Error("parser returned no task_id");
  const deadline = Date.now() + Number(env.KJ_QUALITY_PARSER_TIMEOUT_MS ?? 120_000);
  for (;;) {
    if (Date.now() >= deadline) throw new Error("parser timed out");
    const task = await parserJson<{ status?: string; files?: { status?: string; error?: { message?: string } }[] }>(`${base}/v1/tasks/${encodeURIComponent(created.task_id)}`, key);
    if (task.status === "completed" || task.status === "partial") break;
    if (!["queued", "running"].includes(task.status ?? "")) throw new Error(`parser failed: ${task.files?.[0]?.error?.message ?? task.status ?? "unknown"}`);
    await pause(1_000);
  }
  const result = await parserJson<{ files?: { content?: { markdown?: string } }[] }>(`${base}/v1/tasks/${encodeURIComponent(created.task_id)}/result`, key);
  const raw = result.files?.[0]?.content?.markdown;
  if (!raw) throw new Error("parser returned no Markdown");
  return {
    implementation: { kind: "mineru-selfhost", version: health.version ?? null },
    output: { raw },
    metadata: { latencyMs: Date.now() - started, inputTokens: null, outputTokens: null, costUsd: null },
    secrets: [key ?? ""],
  };
}

function selectedCase(target: QualityCase["target"], caseId?: string): QualityCase {
  const corpus = loadCorpus();
  const candidates = corpus.cases.filter((item) => item.target === target);
  if (caseId) {
    const selected = candidates.find((item) => item.id === caseId);
    if (!selected) throw new Error(`no ${target} case named ${caseId}`);
    return selected;
  }
  if (candidates.length !== 1) throw new Error(`${target}: choose one case with --case (${candidates.map((item) => item.id).join(", ")})`);
  return candidates[0]!;
}

async function recordCase(target: QualityCase["target"], caseId?: string, env: NodeJS.ProcessEnv = process.env): Promise<QualityFixture> {
  const corpus = loadCorpus();
  const c = selectedCase(target, caseId);
  const captured = c.target === "parser" ? await recordParser(c, env) : await recordModel(c, env);
  const fixture = redactFixture(
    {
      fixtureVersion: 1 as const,
      corpusVersion: corpus.version,
      caseId: c.id,
      target: c.target,
      recordedAt: new Date().toISOString(),
      implementation: captured.implementation,
      output: captured.output,
      metadata: captured.metadata,
    },
    captured.secrets,
  );
  assertFixtureSafe(fixture);
  return Fixture.parse(fixture);
}

function fixtureFiles(inputs: string[]): string[] {
  const paths = inputs.length ? inputs : [QUALITY_RECORDINGS];
  return paths.flatMap((entry) => {
    const absolute = path.resolve(entry);
    const stat = fs.statSync(absolute);
    return stat.isDirectory() ? fs.readdirSync(absolute).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(absolute, f)) : [absolute];
  });
}

export function replayFiles(inputs: string[] = []): QualityScore[] {
  return fixtureFiles(inputs).map((file) => scoreFixture(readJson(file)));
}

export function assertManualRecordAllowed(confirmed: boolean, env: NodeJS.ProcessEnv = process.env): void {
  if (env.CI) throw new Error("record is disabled in CI; run it manually with local/admin-equivalent credentials");
  if (!confirmed) throw new Error("record refuses network access without --confirm-real-call");
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { positional, opts } = parseArgs(rest);
  if (command === "record") {
    assertManualRecordAllowed(opts["confirm-real-call"] === "true");
    const target = z.enum(["text", "vision", "parser"]).parse(opts.target);
    if (!opts.out) throw new Error("record requires --out <reviewable fixture.json>");
    const fixture = await recordCase(target, opts.case);
    const score = scoreFixture(fixture);
    writeJson(opts.out, fixture);
    console.log(JSON.stringify(score, null, 2));
    if (!score.passed) process.exitCode = 1;
    return;
  }
  if (command === "replay") {
    const scores = replayFiles(positional);
    console.log(JSON.stringify(scores, null, 2));
    if (scores.some((s) => !s.passed)) process.exitCode = 1;
    return;
  }
  throw new Error("usage: quality.ts record --target text|vision|parser [--case <case-id>] --confirm-real-call --out <fixture.json> | replay [fixture-or-directory ...]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
