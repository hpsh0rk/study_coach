# Manual quality gates

These checks require credentials, desktop software, classroom hardware, or teacher judgment. CI must not run them. A deterministic replay or stub result is supporting evidence only and must never be recorded as a manual pass.

## Gate status and repository evidence

| Gate | Automated evidence | Required manual evidence |
| --- | --- | --- |
| Real text model and Messages gateway | `packages/ai/test/protocols.test.ts`; source-safe record/replay in `tools/eval` | one current recording per protocol/model plus S01–S08 core-scenario runs |
| Real MinerU | adapter/API tests, recorded formula replay, and committed `mineru-agent` formula/OCR/table recordings (`tools/eval/fixtures/quality-recordings/parser-{formula,ocr,table}-v1.json`) | re-record on service/self-host upgrades and verify publisher multi-column/merged-table pages |
| WPS / PowerPoint / Keynote | OOXML semantic tests, real Chromium ECharts-rasterized PPTX E2E + `pnpm --filter @kj/pptx browser-verify`, and LibreOffice geometry | the same browser-exported decks opened and inspected in each desktop application |
| Classroom environment | deterministic player/viewport/E2E matrix | projector, presenter laptop, clicker/pen, offline, and real-network observations |
| Teacher validation | bilingual reviewed fixtures and bounded mutation gates | blind review by 2–3 teachers and an explicit release decision |

Keep manual evidence outside committed source until it has been reviewed for student, teacher, provider, and gateway data. `test-results/manual/` is gitignored and is the default working location.

## 1. Real models and gateway

First run the narrow source-safe checks in [`tools/eval/QUALITY.md`](../tools/eval/QUALITY.md). For a Messages-compatible gateway, set `KJ_QUALITY_TEXT_PROTOCOL=messages`; a pass proves the real endpoint accepted and returned the fixed task through the production protocol implementation. It does not prove lesson quality.

For generation quality, use the reviewed eval directory containing `manifest.json`, `rubric.json`, `score.ts`, and `pdfs/*.pages.json`:

```bash
export KJ_EVAL_DIR=/absolute/path/to/reviewed/eval
export KJ_EVAL_API_KEY='...'
export KJ_EVAL_PROVIDER=custom
export KJ_EVAL_MODEL='model-name'
export KJ_EVAL_BASE_URL='https://gateway.example/v1'
export KJ_EVAL_PROTOCOL=messages
# Optional when the gateway requires it:
# export KJ_EVAL_HEADERS_JSON='{"x-source":"manual-eval"}'

pnpm eval:run --eval-dir "$KJ_EVAL_DIR" \
  --scenarios S01,S03,S05,S06,S07,S08 --runs 3 \
  --variant real-model --out test-results/manual/real-model
pnpm eval:render test-results/manual/real-model
pnpm eval:compare --eval-dir "$KJ_EVAL_DIR" \
  --base test-results/manual/real-model \
  test-results/manual/real-model \
  --out test-results/manual/real-model-score
```

Record the commit SHA, model and gateway identity, protocol, prompt versions, commands, per-run failures, calls/tokens/latency, and rendered P0 failures. Do not record keys, custom-header values, private URLs, or gateway response headers. Every run must pass deterministic P0 checks; report all runs and variance, not only the best or mean.

## 2. Real MinerU, OCR, and tables

Run all three fixed parser cases from [`tools/eval/QUALITY.md`](../tools/eval/QUALITY.md) against the configured MinerU backend (`KJ_QUALITY_PARSER_BASE_URL` for `selfhost`, or `KJ_QUALITY_PARSER_MODE=agent` for the cloud token-free agent API):

1. `parser-kinematics-v1`: outlined formulas and units;
2. `parser-ocr-v1`: a generated image-only page with exact text, values, and units;
3. `parser-table-v1`: a generated two-column table whose reviewed cells must remain on the correct Markdown/HTML rows.

Each command writes a sanitized fixture even when scoring fails. Preserve the failed fixture for diagnosis, but do not commit it until a human has checked the raw transcription for confidential service text and the replay passes:

```bash
pnpm quality:replay \
  test-results/manual/parser-formula-v1.json \
  test-results/manual/parser-ocr-v1.json \
  test-results/manual/parser-table-v1.json
```

A three-case pass is a compact drift check, not evidence for multi-column pages, merged cells, figures, handwriting, or real publisher scans.

## 3. WPS, PowerPoint, and Keynote

Generate one classic-theme and one chalk-theme lesson through the browser export path. The pair must include Chinese and Latin text, formula, native table, native chart, raster chart/function fallback, quiz answer in notes, sources, and an interaction that degrades to static PPTX.

Before opening them (or use `pnpm --filter @kj/pptx browser-verify` to produce a reproducible 10-slide classic/chalk browser-exported pair and verify OOXML, raster PNG dimensions, and LibreOffice bounds automatically):

```bash
pnpm --filter @kj/pptx render-check
pnpm --filter @kj/pptx browser-verify
sha256sum classic.pptx chalk.pptx
```

Open the exact same files in the current WPS for Mac, Microsoft PowerPoint, and Apple Keynote. Record application/OS versions and check every slide for:

- no clipped, overlapping, substituted, or unexpectedly reflowed text;
- Chinese, Latin, symbols, formulas, tables, native charts, raster images, and sources are legible;
- intended text, tables, charts, and shapes remain editable;
- speaker notes contain the intended notes/answers;
- projected slides contain no answer, explanation, or misconception text;
- save/reopen does not lose content or corrupt relationships.

Any blocking reflow, missing content, projected answer, or corrupt save is a failure. Application-specific cosmetic differences are observations, not automatic passes.

## 4. Classroom hardware smoke

Use one frozen reviewed lesson on the actual teacher laptop and projector. Record browser/OS, display resolution and scaling, network mode, clicker/pen models, and deck/version identity.

Check: presenter/audience window sync; next/previous/Home/End; fullscreen and black screen; notes and answers visible only to the presenter; poll tally then answer reveal; order/match drag and reveal; simulation; ink draw/erase/clear; resize; network-blocked offline HTML; student preview/review modes; and reconnect/real-network latency. Record observed latency and every intervention or workaround.

Do not infer this gate from Playwright: the manual pass requires the real display chain and input devices.

## 5. Blind teacher review

Use 2–3 teachers. Randomize deck labels and hide model/provider identity. For every reviewed deck, collect 1–5 ratings and short evidence for:

- factual trust and citation fit;
- sequence, prerequisite choice, difficulty progression, and remediation;
- level/language fit;
- pacing and classroom interaction usability;
- “teachable tomorrow” with the number and type of required edits.

Also record factual corrections, reordered/removed/added slides, semantic answer giveaways, and whether the teacher would use the deck. Report every reviewer separately plus the median. The release threshold is median at least 4/5 for factual trust, sequence/level fit, and teachable-tomorrow, with no scenario median below 3 and no accepted answer giveaway.

## Evidence record

For each gate, create a local Markdown or JSON record containing:

```text
gate:
repositoryCommit:
dateUtc:
operator:
environmentAndVersions:
inputsAndSha256:
commandsOrProcedure:
observations:
failuresAndWorkarounds:
result: pass | fail | incomplete
reviewedBy:
```

`incomplete` is the correct result when required software, hardware, credentials, scenarios, or reviewers were unavailable. Never replace an unrun observation with an expected or synthetic outcome.
