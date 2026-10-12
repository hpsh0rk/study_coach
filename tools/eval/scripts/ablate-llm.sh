#!/usr/bin/env bash
# The ablations that need a real model (ablation-plan §4): P0 first, then P1 with P1=1.
#
#   KJ_EVAL_DIR=<eval set> DEEPSEEK_API_KEY=... bash tools/eval/scripts/ablate-llm.sh [out=results/ablation-llm]
#   (or GLM_API_KEY, or KJ_EVAL_API_KEY + KJ_EVAL_PROVIDER/KJ_EVAL_MODEL/KJ_EVAL_BASE_URL)
#
# Scores with score.ts and compares every variant with B0 (paired bootstrap CIs). Judge scores
# (J1–J5, pairwise) are not automated yet; the decks it writes are the judge's input.
set -euo pipefail
E="${KJ_EVAL_DIR:?set KJ_EVAL_DIR to the eval set (manifest.json, pdfs/, score.ts, rubric.json)}"
if [[ -z "${KJ_EVAL_API_KEY:-}${DEEPSEEK_API_KEY:-}${GLM_API_KEY:-}${ZHIPU_API_KEY:-}" ]]; then
  echo "no model key: set DEEPSEEK_API_KEY, GLM_API_KEY or KJ_EVAL_API_KEY (the stub would make every variant identical)" >&2
  exit 2
fi
R="${1:-results/ablation-llm}"
RUNS="${RUNS:-3}"
mkdir -p "$R"

run() { [[ -d "$R/$1" ]] || pnpm -s eval:run --eval-dir "$E" --runs "$RUNS" --variant "$1" --out "$R/$1" "${@:2}"; }

# P0
run B0                                                                                     # full pipeline
run B0b                                                                                    # A0: noise baseline (same config again)
run A4 --flags slideCheckRetry=false --reuse-outlines "$R/B0"                              # slide check-retry
run A8none --flags writerSource=none --reuse-outlines "$R/B0"                              # writer source: none
run A8all --flags writerSource=all --reuse-outlines "$R/B0"                                # writer source: whole selection
run A4b --flags outlineCheckRetry=false                                                    # outline check-retry
run A6 --flags phases=false                                                                # learning-loop phases
run A7 --flags visualPlanning=writer                                                       # visuals chosen by the writer
VARIANTS=(B0b A4 A8none A8all A4b A6 A7)

if [[ "${P1:-0}" == "1" ]]; then
  run A3 --flags budgetsInPrompt=false,slideCheckRetry=false,truncateFallback=false --reuse-outlines "$R/B0"
  run A3p --flags budgetsInPrompt=false --reuse-outlines "$R/B0"                           # prompt budgets only
  run A2 --flags outline=skip
  VARIANTS+=(A3 A3p A2)
fi

pnpm -s eval:render "$R/B0" "${VARIANTS[@]/#/$R/}"
pnpm -s eval:compare --eval-dir "$E" --base "$R/B0" "${VARIANTS[@]/#/$R/}" --out "$R/compare"
