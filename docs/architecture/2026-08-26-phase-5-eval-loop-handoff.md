# Phase 5 — Evaluation loop handoff

Starting HEAD: `3d2034f`. Branch: `devin/demo-day-interactive-tutor`.

## Proven offline

- Scripted synthetic lesson evaluation gate: `npm run test:lesson-eval`.
- Fixtures live under `server/lesson/eval/fixtures/` (10 JSON traces). Report
  written to `artifacts/evaluation/lesson-eval-report.json` (gitignored output).
- Five scoring dimensions each have a deterministic offline path with passing and
  failing (or negative-control) fixtures:
  1. **Reveal–narration coherence** — `revealNarrationCoherence.ts` walks a
     scripted timeline; each reveal must be narrated before the next reveal and
     narration may reference only already-visible object ids.
  2. **Object permanence** — `objectPermanence.ts` replays released tutor board
     events and fails on tutor removals outside announced section navigation or
     on `tutor_object_disappearance` metrics.
  3. **Turn-latency percentiles** — `turnLatencyPercentiles.ts` computes p50/p95
     for `speech_end_to_response_started` and `speech_end_to_first_audio` only
     when `minSamplesForPercentile` (default 5) is met; otherwise reports
     `insufficient_n`.
  4. **False barge-ins** — `falseBargeIns.ts` counts confirmed-then-cancelled
     gate+cancel pairs separately from labelled true interrupts and from
     unlabelled cancellations; negative-control fixture pins the
     confirmed-then-cancelled count.
  5. **Blueprint quality** — fixed rubric
     `server/lesson/eval/blueprint-quality-rubric.json`; structural scorer plus
     scripted judgments score triangle-angle-sum (good) and a weak blueprint
     fixture.
- Live path lock: `authorization.ts` requires `--authorized-live-run` and caps
  at two sessions; `scripts/evaluate-lesson.ts` refuses live invocation today
  (no provider calls).
- Composes with existing gates — does not replace `test:av`,
  `test:smoke-report`, or proxy interruption Vitest rows.
- Documentation updated in `docs/operations/testing-and-evaluation.md` and
  `README.md` verification commands.

### Gate results at handoff head

| Gate | Result |
| --- | --- |
| `npm run build` | ✓ |
| `npm run typecheck:server` | ✓ |
| `npm run lint` | ✓ |
| `npm test` | ✓ 71 files / 542 tests |
| `npm audit --omit=dev` | ✓ 0 vulnerabilities |
| `npm run test:integration` | ✓ 542 tests |
| `npm run test:e2e` | ✓ 24 tests |
| `npm run test:visual` | ✓ 53 baselines unchanged |
| `npm run test:a11y` | ✓ 4 tests |
| `npm run test:security` | ✓ 20 tests |
| `npm run test:storage` | ✓ 9 tests |
| `npm run test:brand` | ✓ |
| `npm run test:runtime-models` | ✓ 8 assertions |
| `npm run test:smoke-report` | ✓ 70 tests |
| `npm run test:lesson-eval` | ✓ 10 dimension gates |

## Requires authorized live verification

- End-to-end lesson quality judged by a live strong-model adapter against the
  same rubric (adapter stub exists; not wired to provider).
- Live latency percentile distributions on real sessions (offline fixtures prove
  the percentile math only).
- Semantic false-barge-in rate against labelled room-noise ground truth.
- Acoustic barge-in onset/silence and target-hardware microphone behavior.

Use the existing `npm run e2e:live -- --authorized-live-run` smoke reporter for
authorized provider sessions (≤2 short sessions per invocation). Do not fold
paid live eval into `npm test`.

## Deferred

- Wiring a live strong-model blueprint judge behind `--authorized-live-run`.
- Automated lesson-eval replay from captured session logs (fixtures are
  hand-authored traces today).
- CI workflow file change (gate is documented and runnable locally; not added to
  a remote pipeline in this phase).
- Regenerating or extending visual baselines.

## Module map (line counts)

| Module | Lines |
| --- | ---: |
| `server/lesson/eval/types.ts` | 103 |
| `server/lesson/eval/authorization.ts` | 34 |
| `server/lesson/eval/revealNarrationCoherence.ts` | 68 |
| `server/lesson/eval/objectPermanence.ts` | 54 |
| `server/lesson/eval/turnLatencyPercentiles.ts` | 58 |
| `server/lesson/eval/falseBargeIns.ts` | 58 |
| `server/lesson/eval/blueprintQuality.ts` | 213 |
| `server/lesson/eval/blueprint-quality-rubric.json` | 38 |
| `server/lesson/eval/runLessonEval.ts` | 143 |
| `server/lesson/eval/runLessonEval.test.ts` | 139 |
| `scripts/evaluate-lesson.ts` | 33 |
| Fixtures (10 JSON) | ~280 |

## Risks

- Blueprint structural scorer is conservative; live rubric judging may disagree
  on edge cases — keep scripted judgments for regression anchors.
- Object permanence offline scoring trusts fixture event logs; it does not
  re-render the board.
- Turn-latency fixtures prove percentile honesty, not that production latency
  meets a target.
