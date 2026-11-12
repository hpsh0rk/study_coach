# Manual quality record/replay

This is a small smoke benchmark for real text models, vision models, and a self-hosted MinerU parser. It is separate from connection-test buttons: those prove reachability, while this checks fixed tasks for schema, citations, numbers/units, student-answer leakage, OCR, table-row structure, and available latency/token/cost metadata.

The corpus is repository-authored synthetic material in `fixtures/quality-corpus.json`. Vision and OCR images and the parser table PDF are generated deterministically in memory; the formula parser case uses `fixtures/pdfs/kinematics-outlines.pdf`. The OCR case explicitly requests MinerU's `ocr` mode; formula and table cases use `auto`. There is no option to upload or select another document.

## Offline replay (CI-safe)

```bash
pnpm quality:replay
```

Replay reads `fixtures/quality-recordings/*.json`, makes no network calls, and exits nonzero when an objective check or fixture redaction check fails. The same replay runs in the eval package's Vitest suite, where `fetch` is trapped and asserted to have zero calls, so normal CI (`pnpm test`) covers it. Recording also refuses to run whenever `CI` is set. One explicitly labelled `synthetic-mock` fixture per corpus case proves every scoring path without an external call; the three `parser-{formula,ocr,table}-v1.json` fixtures are sanitized live `mineru-agent` recordings, while real text/vision model recordings remain manual owner gates.

## Record a real result manually

Recording requires an explicit target, `--confirm-real-call`, an output path, and local environment variables. It never reads application databases or CI secrets. Use the same endpoint, model, protocol, and key that an administrator configured, but provide them only in your local shell:

```bash
# Text model
KJ_QUALITY_TEXT_API_KEY='...' \
KJ_QUALITY_TEXT_BASE_URL='https://gateway.example/v1' \
KJ_QUALITY_TEXT_MODEL='model-name' \
KJ_QUALITY_TEXT_PROVIDER='custom' \
pnpm quality:record --target text --confirm-real-call \
  --out tools/eval/fixtures/quality-recordings/text-model-name-v1.json

# The same source-safe task through an Anthropic Messages-compatible gateway
KJ_QUALITY_TEXT_API_KEY='...' \
KJ_QUALITY_TEXT_BASE_URL='https://gateway.example' \
KJ_QUALITY_TEXT_MODEL='model-name' \
KJ_QUALITY_TEXT_PROVIDER='custom' \
KJ_QUALITY_TEXT_PROTOCOL='messages' \
pnpm quality:record --target text --confirm-real-call \
  --out tools/eval/fixtures/quality-recordings/messages-model-name-v1.json

# Vision model
KJ_QUALITY_VISION_API_KEY='...' \
KJ_QUALITY_VISION_BASE_URL='https://gateway.example/v1' \
KJ_QUALITY_VISION_MODEL='vision-model-name' \
KJ_QUALITY_VISION_PROVIDER='custom' \
pnpm quality:record --target vision --confirm-real-call \
  --out tools/eval/fixtures/quality-recordings/vision-model-name-v1.json

# Self-hosted MinerU 4+ parser (default) or cloud token-free agent API (`KJ_QUALITY_PARSER_MODE=agent`)
KJ_QUALITY_PARSER_BASE_URL='https://parser.example' \
KJ_QUALITY_PARSER_API_KEY='...' \
pnpm quality:record --target parser --case parser-kinematics-v1 \
  --confirm-real-call --out tools/eval/fixtures/quality-recordings/parser-formula-v1.json

KJ_QUALITY_PARSER_BASE_URL='https://parser.example' \
KJ_QUALITY_PARSER_API_KEY='...' \
pnpm quality:record --target parser --case parser-ocr-v1 \
  --confirm-real-call --out tools/eval/fixtures/quality-recordings/parser-ocr-v1.json

KJ_QUALITY_PARSER_BASE_URL='https://parser.example' \
KJ_QUALITY_PARSER_API_KEY='...' \
pnpm quality:record --target parser --case parser-table-v1 \
  --confirm-real-call --out tools/eval/fixtures/quality-recordings/parser-table-v1.json
```

Optional text/vision variables are `KJ_QUALITY_{TEXT,VISION}_PROTOCOL=openai|messages`, `KJ_QUALITY_{TEXT,VISION}_MAX_TOKENS`, and `KJ_QUALITY_{TEXT,VISION}_HEADERS_JSON` (a JSON object for gateway-specific headers). Text recording runs through `@kj/ai` `createAiLayer.callStructured` (JSON Schema prompt + 1-turn repair loop) and vision recording runs through `createAiLayer.callVision` + `cleanVisionText`, matching production model calls. For MinerU's cloud token-free agent API instead of a self-hosted server, set `KJ_QUALITY_PARSER_MODE=agent` (wraps the PDF with `KJPAGE` separator pages and enforces the MinerU host allowlist). Keep all credentials and sensitive header values in local environment variables, never command arguments. Parser timeout can be changed with `KJ_QUALITY_PARSER_TIMEOUT_MS`.

The command prints the score and exits nonzero for a quality failure, but still writes the sanitized fixture for review. Before committing a real recording:

1. Inspect the diff. A fixture should contain only implementation identity, raw output, and typed metadata.
2. Run `pnpm quality:replay <fixture.json>` and `pnpm --filter @kj/eval test`.
3. Do not commit a recording if its output reproduces confidential gateway text.

Known keys are replaced with `[REDACTED]`. Recording/replay reject credential-shaped text, authorization/header/key fields, and private/local endpoint URLs. Base URLs, request headers, prompts, source images, PDFs, task IDs, and parser URLs are never stored. `costUsd` is `null` because the current provider protocols do not report cost; token counts are stored when the provider reports them.

These are narrow service-drift checks. A passing text case does not establish six-scenario lesson quality, a passing parser case does not establish publisher-layout recall, and no fixture is evidence of WPS, classroom, or teacher acceptance. Follow `docs/manual-quality-gates.md` for those gates and record actual observations rather than inferring them from replay.
