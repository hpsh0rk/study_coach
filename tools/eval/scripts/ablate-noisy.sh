#!/usr/bin/env bash
# Fault-injection ablations (no model needed): what each deterministic safeguard catches, and its cost.
#
#   KJ_EVAL_DIR=<dir with manifest.json, pdfs/, score.ts, rubric.json> bash tools/eval/scripts/ablate-noisy.sh [out=results/ablation-noisy] [noise=realistic]
set -euo pipefail
E="${KJ_EVAL_DIR:?set KJ_EVAL_DIR to the eval set (manifest.json, pdfs/, score.ts, rubric.json)}"
R="${1:-results/ablation-noisy}"
NOISE="${2:-realistic}"
RUNS="${RUNS:-3}"
rm -rf "$R"

run() { pnpm -s eval:run --eval-dir "$E" --runs "$RUNS" --noise "$NOISE" --variant "$1" --out "$R/$1" "${@:2}"; }

pnpm -s eval:run --eval-dir "$E" --noise none --variant clean --out "$R/clean"            # budget-clean stub answers, no faults
run N0                                                                                     # full pipeline
run N0b --seed kj-b                                                                        # A0: same config, other fault draws
run A4 --flags slideCheckRetry=false --reuse-outlines "$R/N0"                              # no slide check-retry
run T --flags truncateFallback=false --reuse-outlines "$R/N0"                              # no truncation
run A4T --flags slideCheckRetry=false,truncateFallback=false --reuse-outlines "$R/N0"      # neither (A3 minus the prompt half)
run A4b --flags outlineCheckRetry=false                                                    # no outline check-retry
run A8none --flags writerSource=none --reuse-outlines "$R/N0"                              # cost side of A8 only
run A8all --flags writerSource=all --reuse-outlines "$R/N0"

pnpm -s eval:render "$R"/clean "$R"/N0 "$R"/N0b "$R"/A4 "$R"/T "$R"/A4T "$R"/A4b "$R"/A8none "$R"/A8all
pnpm -s eval:faults --from "$R/clean" --eval-dir "$E" --out "$R/faults" --seeds 10
pnpm -s eval:compare --eval-dir "$E" --base "$R/N0" "$R/N0b" "$R/A4" "$R/T" "$R/A4T" "$R/A4b" "$R/A8none" "$R/A8all" --out "$R/compare"
