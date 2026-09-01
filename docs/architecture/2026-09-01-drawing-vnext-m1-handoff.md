# Drawing vNext M1 handoff

Date: 2026-09-01
Milestone status: **not accepted**
Rollback: `NOURA_DIRECTOR_PIPELINE=classic` (default)

## Implemented behind the rollback flag

- Strict step-structured OpenAI streaming with an incremental parser.
- Cumulative deterministic policy and connected-browser preflight before
  every staged step.
- Incremental storyboard intake with one terminal `directed_scene` write.
- AbortController epoch scoping, queued-cue cancellation, serialized step and
  progress persistence, and one-shot reconnect abandonment bridge.
- Connected-browser candidate rendering; provider keys remain server-only.
- Terra-low composition with one pre-commit validity retry at Terra-medium.
- M0-selected Luna-low semantic audit with a 3,000 ms step-one budget.
  Invalid/rejected verdicts fail closed; render/provider errors and the real
  next-reveal timeout proceed under deterministic authority.
- Audit output is a closed control signal. Free-form judge text never enters
  tutor instructions, board context, logs, or telemetry dimensions.
- Illustration headers fall back to the classic illustration lane before any
  streamed overlay can reveal.
- `director_stream_first_op` and `vision_audit_outcome` runtime telemetry,
  attributed to the identity captured at dispatch.
- Runtime decomposition: `visualRequests.ts` is 400 committed lines; anchor,
  streaming orchestration, and outcomes live in narrow modules.

## Safety and permanence evidence

Focused clean-index tests cover:

- first step delivered before stream completion;
- malformed/invalid tail and browser rejection;
- audit reject before step one and after step-one budget;
- audit timeout at the actual narration playback boundary;
- epoch abort before and after intake;
- same-connection interruption versus socket reconnect;
- queued event cancellation without retracting first paint;
- durable `ops_shown` before late-reject abandonment;
- Postgres-like delayed event and progress write ordering;
- no retry after a callback has committed a step;
- classic illustration fallback before partial reveal;
- captured-identity telemetry and audit PII exclusion.

The real lesson-page Playwright case
`a late audit cancellation preserves step one and removes queued step two`
passed. The inspected screenshot shows the first number line cleanly visible,
the rejected second marker absent, no stale partial object, and the ordinary
lesson controls still usable.

## Evaluation result

See
`docs/architecture/2026-09-01-drawing-vnext-m1-ab-decision.md` and the
committed raw/derived artifacts under `server/board/eval/results/`.

- Paired diagram validity: 290 / 320 in both arms.
- Blind-grade reuse: 24 / 24 with exact final ops/raster parity.
- Conservative provider-critical-path readiness cut: 43.6066%.
- Full Terra-low first-pass validity: 329 / 360 (91.3889%).
- Actual learner-browser first-paint acceptance: still requires separate
  `ops_presented` evidence.
- Additional provider calls / spend: 0 / $0.

## Acceptance blockers

1. The absolute 95% deterministic/browser first-pass validity gate is unmet.
2. The ≥40% evidence is provider-critical-path readiness, not an actual
   end-to-end `ops_presented` latency distribution.
3. Full README gates and final browser milestone report must be rerun after a
   quality-preserving validity improvement.

The attempted multipass repair that numerically reached 95% was reverted after
manual screenshots showed material overlaps. The evidence and this handoff
preserve that negative result; they do not reinterpret it as success.

## Next allowed action

Remain in M1. Do not begin M2. A new validity intervention must preserve
visual quality and be evaluated against representative and holdout rows. The
authorized $30 synthetic bake-off cap remains hard, so no additional provider
study may be started without a new user authorization that explicitly changes
that ceiling.
