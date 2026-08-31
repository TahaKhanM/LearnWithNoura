# Drawing vNext M0 handoff — telemetry and evaluation harness (2026-08-30)

Status: offline implementation complete; milestone acceptance remains open
because no live-provider spend was authorized in this session. M1 has not
started.

## Outcome

M0 now has a fail-closed measurement surface without changing any runtime
model default:

- `visual_first_paint`: accepted intent to the browser's first committed
  `ops_presented` acknowledgement;
- `visual_scene_complete`: accepted intent to the last durable storyboard
  step;
- `director_stream_first_op`: stream start to the first complete BoardOp that
  passes authored validation;
- `vision_audit_outcome`: audit latency with the closed
  `approved|rejected|timeout|invalid|error` verdict.

Visual timing is measured from server-owned timestamps. The browser supplies
only the already-trusted event acknowledgement, so it cannot choose the lane or
elapsed duration. Restored mid-stream runs omit an intent timestamp instead of
claiming reconnect-relative latency. The strict smoke-report projection accepts
the four new contracts and reconstructs their duration summaries from timeline
rows. `director_stream_first_op` and `vision_audit_outcome` have closed runtime
helpers now; their production call sites arrive with the M1 streaming/audit
pipeline and are not claimed as emitted by the classic path.

## Evaluation contract

`npm run test:director-eval` is offline by default and produced 1,800 scripted
rows: 36 intents × five configurations × warm/cold × five trials. The corpus is
24 representative plus 12 sealed holdout intents across all nine required
families. Fixture proposals cross `DirectorProposalSchema`,
`validateOps({ tier: 'authored' })`, `applyDirectorBoardPolicy`, and
`AnchorSceneSchema` storyboard coverage. Live decoding uses the template-first
strict vNext proposal with ordered `steps[].ops`; a hedge can win only after
step one clears authored/cumulative policy and browser preflight. The fixed
raster rubric pins `gpt-5.6-luna` at low effort as the blind judge and receives
the cumulative raster after every reveal, so storyboard coherence is visible.

The pre-registered composition rule is executable: ≥95% first-pass validity;
quality within one grade of `terra-med`; lowest p50 first-valid-op; cost as the
tie-breaker; the hedge only when it improves the best single p50 by at least
15% and stays below $0.10 mean composition cost. The live runner uses a $30
hard ceiling. Its complete 4,072-call plan is preflighted at a conservative
$29.433 including cache writes, context rasters, judge/audit/sketch calls,
aborted warm hedge legs, and one cache-miss contingency. A selected warm leg
without cached tokens stops immediately. Early stopping is round-robin and
requires >2× superiority on every recorded latency, validity, quality, and
cost metric after every arm has been sampled.

The audit corpus has twelve exact geometry-valid semantic defects plus matched
clean controls: four wrong shading, four mislabeled values, and four reversed
arrows. Every pair must also clear Director policy and the real browser
preflight before the study begins. The selected audit model must clear catch,
false-reject, invalid-reply, and maximum-p95 bars; `auditBudgetMs` is derived
from measured p95 plus margin. The sketch corpus contains ten synthetic
board-coordinate bases expanded with three deterministic jitter seeds each and
renders through the board harness. It cannot authorize semantic grading assist,
so the assist remains off. There is no real child data.

## Proven offline

- The untouched starting tree passed all fourteen README gates plus
  `test:runtime-models` before edits (626 unit tests, 26 E2E, 53 visual, five
  accessibility, 23 security, and ten storage tests).
- Telemetry schema, server emission, session aggregation, and smoke projection
  accept the new bounded contracts and reject unknown lanes, providers,
  efforts, and outcomes.
- A real anchor storyboard records one first-paint and one scene-complete
  metric while preserving its existing completion outcome.
- The default Director evaluator reports `providerCalls: 0`,
  `runtimeCostUsd: 0`, and `evidenceMode: deterministic_offline_fixture`.
- The offline fixture winner is deliberately labelled `offline_fixture_only`;
  it is not a runtime model decision.
- The expanded 16-command README gate set passed after the adversarial rework:
  667 unit tests, 665 integration-scope tests, 26 E2E, 53 visual, five
  accessibility, 23 security, ten storage, plus runtime-model and Director
  evaluation gates (36 focused evaluator tests and a scripted 4,072-call full
  matrix). The smoke reporter passed 74 tests. Lint retained only the two
  pre-existing unused-variable warnings under `demo/intro-video/`.

## Browser verification

The offline `storyboard-build` Playwright row drives the actual Lesson page
with the fake voice transport and now captures both decisive states. The
inspected first-paint screenshot showed only the exact 0–1 number-line scale,
with the Board status reporting one object. The inspected completed screenshot
kept that scale in place and added the exact `2/3` point plus the “One shared
scale” label; the typed interruption caption was visible and no revealed mark
vanished. The same row confirmed all three `ops_shown` acknowledgements and
passed in 6.2 seconds. The in-app browser also inspected the real `/dev/board`
fraction fixture: ticks, `3/5`, and `2/3` were legible, ordered on one scale,
and the long description named the correct number-line object.

## Requires authorized live verification

- The complete five-condition N=5 warm/cold bake-off on all 36 synthetic
  intents, including provider cache-token telemetry and combined hedge cost.
- Blind grading of the rendered candidate rasters through the configured real
  board harness.
- Terra-low versus Luna-low audit catch rate and latency on the seeded defects,
  which finalizes `auditBudgetMs` and the reveal-gate weight.
- The 30-item sketch accuracy/calibration comparison and any cheaper-model
  second-opinion decision.
- The required decision record
  `docs/architecture/2026-XX-XX-drawing-model-bakeoff-decision.md` plus raw JSON
  under `server/board/eval/results/`.

No live call, deployment, paid resource, push, or runtime-default change was
made. Until the authorized evidence exists, M0 is not accepted and M1 must not
begin.

## Provider-documentation check

Current official OpenAI documentation confirms that GPT-5.6 Terra and Luna
support streaming and Structured Outputs, stable-prefix prompt caching exposes
cached-token usage, and GPT-Image-2 supports partial images through the Image
API. References: [model comparison](https://developers.openai.com/api/docs/models/compare),
[prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), and
[image generation](https://developers.openai.com/api/docs/guides/image-generation).
