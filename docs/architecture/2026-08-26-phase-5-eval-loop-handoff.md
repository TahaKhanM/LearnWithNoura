# Phase 5 — Evaluation loop handoff (rework)

Starting HEAD: `f74ddb2`. Branch: `devin/demo-day-interactive-tutor`. Rework commit addresses adversarial review High 1–4 and listed Mediums.

## Proven offline

- Scripted synthetic lesson evaluation gate: `npm run test:lesson-eval`.
- Fixtures live under `server/lesson/eval/fixtures/` (12 JSON traces). Report
  written to `artifacts/evaluation/lesson-eval-report.json` (gitignored output).
- Five scoring dimensions each have a deterministic offline path with passing and
  failing (or negative-control) fixtures, bound to production modules where noted:
  1. **Reveal–narration coherence** — `revealNarrationCoherence.ts` walks a
     scripted timeline; each reveal must be narrated before the next reveal;
     referenced object ids are derived from the storyboard step’s `objectIds`
     (not fixture-authored `referencedObjectIds`). When `anchorScene` is present,
     reveal ops are cross-checked against production `storyboardRunSteps`
     (`server/realtime/storyboardRunner.ts`). Three fixtures: coherent pass,
     narration-before-reveal fail, consecutive-reveals-without-narration fail.
  2. **Object permanence** — `objectPermanence.ts` replays production `BoardOp`
     batches through `applyOps` (`src/board/scene.ts`) and scores disappearances
     with `RenderedTutorObjectTracker` (`src/board/renderedObjectTracker.ts`).
     Tutor `erase`, `clear`, and same-id overwrite outside announced section
     navigation fail. Three fixtures: adds-only pass, erase fail, same-id
     overwrite fail.
  3. **Turn-latency percentiles** — `turnLatencyPercentiles.ts` computes p50/p95
     for `speech_end_to_response_started` and `speech_end_to_first_audio` only
     when n ≥ 5 (hard floor regardless of fixture `minSamplesForPercentile`);
     otherwise reports `insufficient_n` with no percentile keys.
  4. **False barge-ins** — `falseBargeIns.ts` counts confirmed-then-cancelled,
     `provider_completed` after confirmed (`providerCompletedAfterConfirmed`),
     `provider_failed`, and unlabelled cancellations. Scorer `pass` matches pinned
     expected counts only — never echoes `expectPass`. Two fixtures pin all four
     expected counts.
  5. **Blueprint quality** — fixed rubric
     `server/lesson/eval/blueprint-quality-rubric.json` at `passThreshold: 0.7`;
     structural scorer only (no fixture uses `scriptedJudgments`). Weak fixture
     fails at ~0.6375 (duplicate stage purpose + missing check tasks); good
     triangle fixture passes at 1.0. Manipulate-check dimension is N/A (excluded
     from weighted total) when no manipulate checks exist; no-assessment scans
     anchor illustration intent only.
- Live path lock: `authorization.ts` requires `--authorized-live-run` and caps
  at two sessions; `scripts/evaluate-lesson.ts` parses flags before `outputDir`
  and refuses live invocation (live blueprint judging is **not implemented**).
- Gate envelope: `gates[].pass` means scorer pass matched `expectPass`; raw
  scorer pass is in `details.pass` (script output also emits `scorerPass`).
- Composes with existing gates — does not replace `test:av`,
  `test:smoke-report`, or proxy interruption Vitest rows.
- Documentation updated in `docs/operations/testing-and-evaluation.md` and
  `README.md` verification commands.

### Gate results at rework head

| Gate | Result |
| --- | --- |
| `npm run build` | ✓ |
| `npm run typecheck:server` | ✓ |
| `npm run lint` | ✓ |
| `npm test` | ✓ 71 files / 546 tests |
| `npm run test:lesson-eval` | ✓ 12 dimension gates |

## Requires authorized live verification

- End-to-end lesson quality judged by a live strong-model adapter against the
  same rubric (not implemented; no adapter wired to provider).
- Live latency percentile distributions on real sessions (offline fixtures prove
  the percentile math only).
- Semantic false-barge-in rate against labelled room-noise ground truth.
- Acoustic barge-in onset/silence and target-hardware microphone behavior.

Use the existing `npm run e2e:live -- --authorized-live-run` smoke reporter for
authorized provider sessions (≤2 short sessions per invocation). Do not fold
paid live eval into `npm test`.

## Deferred

- Live strong-model blueprint judging (not implemented).
- Automated lesson-eval replay from captured session logs (fixtures are
  hand-authored traces today).
- Driving `storyboardRunner` end-to-end through fake transport for reveal scoring
  (offline gate binds `storyboardRunSteps` derivation; full runner replay remains
  covered by `storyboardRunner.test.ts`).
- CI workflow file change (gate is documented and runnable locally; not added to
  a remote pipeline in this phase).
- Regenerating or extending visual baselines.

## Module map (line counts)

| Module | Lines |
| --- | ---: |
| `server/lesson/eval/types.ts` | ~120 |
| `server/lesson/eval/authorization.ts` | 34 |
| `server/lesson/eval/revealNarrationCoherence.ts` | ~115 |
| `server/lesson/eval/objectPermanence.ts` | ~70 |
| `server/lesson/eval/turnLatencyPercentiles.ts` | ~65 |
| `server/lesson/eval/falseBargeIns.ts` | ~75 |
| `server/lesson/eval/blueprintQuality.ts` | ~250 |
| `server/lesson/eval/blueprint-quality-rubric.json` | 38 |
| `server/lesson/eval/runLessonEval.ts` | ~145 |
| `server/lesson/eval/runLessonEval.test.ts` | ~175 |
| `scripts/evaluate-lesson.ts` | ~35 |
| Fixtures (12 JSON) | ~350 |

## Risks

- Blueprint structural scorer is conservative; a future live rubric judge may
  disagree on edge cases — add `scriptedJudgments` to a fixture only when anchoring
  a specific regression.
- Object permanence offline scoring replays ops through production scene/tracker
  modules but does not open a browser renderer.
- Turn-latency fixtures prove percentile honesty, not that production latency
  meets a target.
