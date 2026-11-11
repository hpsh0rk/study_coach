# Core-quality CI contract

The deterministic CI suite protects mechanics and regression behavior without model keys or external services. It is not evidence that a real model writes a faithful, teachable lesson, or that WPS renders a browser-exported file correctly.

## First distinct increment: student-audience canaries

PRs #50–#53 independently cover PPTX structure, chapter/scope semantics, PDF classification/routing, and safe real-model record/replay. This branch adds the next separate P0 gate: teacher-only canaries at the canonical server payload used by student links and student offline exports.

Offline CI now requires:

- preview payloads contain no speaker notes, warnings, verification details, quiz explanations/misconceptions, experiment outcomes/explanations, or question answers;
- review payloads may show the selected answer and explanation, but still contain no teacher metadata or misconception labels;
- a malformed `faded` slide that lost `fadeFrom` fails closed by removing its final answer-bearing step from preview serialization;
- review mode still exposes that faded step, preserving the explicit preview/review contract.

The contract is covered in `apps/app/test/audience-canaries.test.ts` through `studentSlide`, the shared server transformation for student links and files. No test calls a model, parser, or other external service.

## Boundaries

Existing CI separately checks PDF page classification, chapter/scope rules, outline and slide validation, HTML overflow/interactions, and PPTX planning/rendering. [PR #50](https://github.com/hpsh0rk/study_coach/pull/50) adds six OOXML structural tests; [PR #51](https://github.com/hpsh0rk/study_coach/pull/51) adds eight chapter/scope cases and fixes two scope defects; [PR #52](https://github.com/hpsh0rk/study_coach/pull/52) adds a 14-page bilingual PDF golden and fixes classification/routing/page-marker defects; [PR #53](https://github.com/hpsh0rk/study_coach/pull/53) adds safe confirmed real text/vision/parser recording plus offline replay and quality scoring.

This increment proves canonical JSON removal, not semantic giveaways in stems/options or absence from every DOM/accessibility/message channel. Remaining manual or model-backed gaps include owner-recorded live text/vision/parser outputs, claim-level citation support, scientific correctness, teaching sequence, real generated-deck overflow at every reveal/theme/viewport, browser chart-image export, and WPS/PowerPoint/Keynote editability and visual parity.

Intended merge order is #52 → #51 → #50 → #53 → this branch, with a final combined test run. The earlier PRs overlap `docs/architecture.md` and some textbook files with each other; this branch deliberately touches neither.
