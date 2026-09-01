# Drawing vNext M0 handoff — telemetry and model evidence

Status: implementation and authorized synthetic evidence complete on
2026-09-01. M1 implementation is in progress but is not accepted; see
`docs/architecture/2026-09-01-drawing-vnext-m1-handoff.md`.

## Outcome

M0 adds the four closed telemetry contracts required by Drawing vNext:

- `visual_first_paint`: accepted visual intent to the browser's first durable
  `ops_presented` acknowledgement;
- `visual_scene_complete`: accepted visual intent to the final durable
  storyboard step;
- `director_stream_first_op`: stream start to the first complete BoardOp that
  passes authored policy and browser preflight;
- `vision_audit_outcome`: bounded `approved|rejected|timeout|invalid|error`
  audit outcome and latency.

Timing starts from server-owned timestamps. Reconnect does not fabricate a new
intent timestamp. The smoke-report projection accepts only closed lanes,
providers, efforts, and audit outcomes.

The Director evaluator is offline by default and live only behind explicit
authorization. The final live evidence is the strict N=5 warm/cold matrix:

- 36 synthetic intents: 24 representative and 12 sealed holdout;
- five conditions: Terra/Luna low/medium plus the first-valid-step hedge;
- 1,800 composition rows;
- a pre-registered 25-intent cold trial-one blind-raster sample;
- 12 seeded semantic defects plus 12 clean controls for each audit candidate;
- 30 synthetic jittered board sketches for each grounding candidate.

Every retained row crosses strict schema parsing, authored BoardOp validation,
Director policy, the real `/dev/board` browser preflight, and storyboard
coverage. Live requests use a static prefix and dynamic suffix. Cold prompts
carry a run-scoped nonce; warm evidence requires the measured 1,792-token cache
block and is accepted by an aggregate ≥80% hit rule per condition. Failed and
usage-incomplete calls are charged their full reservation.

## Live decision

The canonical decision record is
`docs/architecture/2026-09-01-drawing-model-bakeoff-decision.md`; raw evidence
is `server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json`.

- **Composition:** no arm met the pre-registered 95% first-pass validity bar.
  No composition winner is adopted, and hedge adoption is off. Terra-low had
  the best validity (91.4%) and 2,834 ms p50 first-valid-op, but remains only
  the prompt-mandated M1 interim fallback behind rollback—not an evidence
  winner.
- **Vision audit:** adopt Luna-low with a 3,000 ms step-one budget. It caught
  100% of seeded defects, false-rejected 8.3% of clean controls, returned no
  invalid replies, and measured 2,398 ms p95.
- **Sketch grounding:** assistance remains off. Terra-low and Luna-low each
  achieved 10% accuracy, with zero paired gain and p=1.0.
- **Cache:** cold cells stayed cold; substantive warm-hit rates were
  98.3%–100% by condition.

The negative composition result is complete evidence, not an incomplete run.
M1 must improve deterministic/browser validity; lowering the 95% gate or
inventing a winner is not permitted.

## Proven offline

- Telemetry schemas, emitters, session aggregation, and smoke projection are
  closed and bounded.
- The default evaluator makes zero provider calls and labels its scripted
  decision `offline_fixture_only`.
- Strict template-first streamed proposals, early-step inspection, cold nonce,
  cache accounting, hard spend reservations, semantic judge retries,
  transport retries, and hashed multi-run resume are unit tested.
- Resume rejects discontinuous ledgers, open reservations, incompatible model
  caps, superseded cache flags, incomplete quality grades, duplicate/conflicting
  rows, and modified source hashes.
- The decision compiler independently reconstructs the matrix, quality sample,
  summaries, negative adoption decision, cache rates, vision decision, sketch
  decision, provider calls, phase costs, authorization arithmetic, and every
  source hash.

## Browser verification

The real local `/dev/board` harness validates and rasters the production BoardOp
contract. The inspected fraction fixture kept `3/5` and `2/3` legible and in
the correct order. The actual Lesson page's offline fake-transport storyboard
row captured first paint and completion: the exact scale remained visible,
later labels/points accumulated, and interruption did not erase revealed work.

## Spend and privacy

The user authorized a cumulative hard maximum of $30. The completed evidence
chain ended at $29.73066603 conservative liability, including stopped attempts,
failed calls, and usage-incomplete reservations. The final ledger and all
retained source ledgers have zero open reservations.

Only checked-in synthetic intents, synthetic board rasters, seeded synthetic
defects/controls, and synthetic jittered sketches were used. No child data,
learner identifier, account credential, deployment, generated-image call,
push, or runtime-default mutation occurred.

## Recorded evaluator-only module-size exceptions

Three M0-only modules exceed the repository's approximate 400-line guideline:

- `liveDirectorEval.ts` keeps the pre-registered matrix, spend-guarded provider
  lifecycle, raster grading, and summary calculation in one auditable runner;
- `decisionEvidence.ts` deliberately colocates the strict raw-report schemas
  with every independent reconstruction check, so schema and verifier changes
  cannot drift across modules;
- `liveStudies.ts` contains the paired vision-defect and sketch studies plus
  their shared retry/cost/statistical helpers.

They are evaluation tooling, not the production drawing runtime, and have no
runtime import from the application path. The resume and spend-ledger state
machines were split into focused modules. A later extraction is justified only
if it preserves one strict schema/reconstruction boundary; line-count-only
splitting would make the decision audit harder to review.

## Deferred to M1+

- Production streaming step intake, epoch aborts, adaptive reveal gating, and
  classic-vs-streamed A/B behavior remain M1.
- Role ports/defaults and any later composition re-evaluation remain M2. M2 may
  adopt Luna-low for audit, but may not claim a composition winner from M0.
- Deterministic template routing remains M3; the negative composition result
  strengthens its priority for exact and quantitative content.
- Generated-image decoupling remains M4; grounding hardening remains M5;
  precomputation and classic-path removal remain M6.

Official references checked for the run: [model comparison and
pricing](https://developers.openai.com/api/docs/models/compare), [GPT-5.6
Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), and [prompt
caching](https://developers.openai.com/api/docs/guides/prompt-caching).
