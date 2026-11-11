# Deterministic classroom deck fixtures

`@kj/templates/testing/classroom` contains two reviewed, replay-only lessons:

- English physics: wave speed, with prerequisite retrieval, explanation, wave-string investigation, worked example, faded practice, hinge poll and exit check.
- Chinese physics: Newton's second law, with prerequisite retrieval, explanation, faded calculation, hinge poll and exit check.

CI never calls a model or external service. The fixtures pin source pages, outline rows, generated slide payloads and compact oracles.

## Machine checks

| Aspect | Deterministic oracle |
| --- | --- |
| Claim support and citations | Each decisive claim names its exact supporting page. The test proves the cited page contains the canary claim and adjacent pages do not. A slide with no citation gets no source text to borrow. |
| Number and unit fidelity | Values, formulas and calculations are checked only against cited pages. Quantity checks compare normalized value plus dimension, including `20 kHz` = `20 000 Hz`, Chinese units, and wrong-unit mutations such as `120 km/s` vs `120 m/s`. |
| Teacher/student boundary | Unique canaries in notes, misconceptions, explanations, question answers and faded answer steps must be absent from hidden-answer student payloads. A faded slide missing `fadeFrom` fails closed by hiding its final step. |
| Outline/deck identity | Every outline row appears exactly once in the replayed deck, in the same order, with matching page type and source pages. |
| Pedagogy dependencies | Each objective has an instruction, learner action and assessment in that order. Every numbered learning loop must contain both instruction and learner activity. Retrieval fixtures use prerequisites rather than today's source pages. |
| Polls and interactions | Hinge checks have a valid answer and two reveal steps: tally before answer. Deterministic experiment content carries the confirmed prediction outcome. |
| Overflow and reveal state | All 14 replayed slides run in classic and chalk themes at every real reveal state. The player matrix covers 1920×1080, 1024×768, 1024×576 and 1280×720 at 2× device scale; CI checks slot overflow, clipped descendants, source/control collisions, body font policy, page errors and no hidden final content. |

## Baseline and result

Before the fixes, the existing core suites were green (`142/142` tests), but the new 22-test classroom matrix had six failing oracle groups (`16/22` passing):

1. an uncited `120 m/s` claim borrowed support from the whole selection;
2. `120 km/s` passed against a cited `120 m/s`;
3. a learning loop with explanation only was not flagged;
4. deterministic retrieval cited and repeated today's topic;
5. deterministic hinge/experiment interaction metadata was missing;
6. a faded student activity without `fadeFrom` leaked its final teacher-only answer.

The reveal-step browser matrix also found 8 failing render configurations out of 208: both faded slides overflowed at step 0 in both themes and viewports because the blank-answer placeholder forced the hidden body into a second grid row.

After the fixes, the classroom matrix passes `22/22` and the browser matrix passes `208/208`; the full unit suite, lint, typecheck, build and overflow browser suite are the release gates.

## Citation and scientific mutation gates

The follow-up mutation suite reuses the same four reviewed classroom claims and the same `verifyNumbers` path. It adds:

- 12 citation mutations: adjacent wrong page, truncated supporting page and explicit contradiction for each reviewed claim;
- 10 physics/chemistry mutations: wrong law, unit, sign, context and significant figures in each subject;
- six clean controls (four citation claims plus two scientific claim sets).

Baseline on PR #55 caught all citation mutations but only 6/10 scientific mutations: `18/22` seeded catches overall (81.8%), with `0/6` clean false positives. The missed cases were a wrong physics law with the same symbol set, lost significant figures in both subjects, and a reversed chemistry sign.

After the focused fixes the gate catches `22/22` seeded mutations (100%) with `0/6` clean false positives (0%). Formula checking now distinguishes equivalent multiplicative rearrangements (`F=ma`, `a=F/m`) from a different relationship (`a=Fm`); signed values must match their cited sign; and directly cited prose quantities preserve significant-figure precision.

Citation, chemistry-equation and same-unit context mutations use reviewed exact anchors. They prove those committed claims and mutations only. They do not claim paraphrase, entailment or open-domain contradiction detection.

## Runtime viewport and interaction follow-up

The PR #55 baseline was `208/208` gallery configurations: 13 slides × 4 requested reveal indices × 2 themes × 2 DPR-1 viewports. It rendered the fixed 1920×1080 gallery canvas, so it did not prove real player scaling, 1024×576, high-DPI, resize or fullscreen behavior. The classroom replay also had no simulation slide.

The follow-up keeps that gallery gate (`224/224` after adding the reviewed wave-string investigation) and adds:

- `280/280` real player cells: 35 actual slide/reveal states × 2 themes × 4 viewport profiles;
- four profiles: 1920×1080 DPR 1, 1024×768 DPR 1, 1024×576 DPR 1, and 1280×720 DPR 2;
- deterministic poll tally/reveal, simulation canvas/outcome, three live resize sizes, and fullscreen enter/exit;
- the existing full-flow checks for bidirectional presenter sync and a network-blocked offline file, including its embedded simulation.

The baseline run was green and the expanded matrix found no production defect. Only test/dev fixture surfaces changed; runtime behavior was not altered.
The completed branch passes `362/362` unit/API tests and `15/15` Playwright tests; the latter includes bidirectional presenter sync and the zero-network offline run.

## Deliberate limits

These fixtures prove closed-world canaries and seeded mutations, not open-ended teaching quality. A real model or teacher is still required for:

- bilingual paraphrase-level claim support, contradiction and wrong-context judgments;
- semantic answer giveaways in a stem or distractor that contain no teacher-only field/canary;
- whether prerequisites, difficulty progression, remediation and objective coverage are pedagogically appropriate;
- whether a generated lesson is accurate, level-appropriate and teachable without reordering;
- classroom usability of polls, pacing and projection on real hardware.
