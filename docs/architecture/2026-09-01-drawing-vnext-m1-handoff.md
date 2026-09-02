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

The complete repository gate matrix is green on the current working tree:
build; server typecheck; lint (two pre-existing demo-video unused-variable
warnings only); 74 smoke-report tests; lesson evaluation; 740 unit tests; 738
integration tests; 27 E2E tests; 53 visual tests; 5 accessibility tests; 23
security tests; 10 storage tests; brand scan; runtime-model audit; M0 Director
offline evaluation; M1 artifact verification; and `npm audit --omit=dev` with
zero vulnerabilities.

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

The attempted multipass repair that numerically reached 95% was reverted after
manual screenshots showed material overlaps. The evidence and this handoff
preserve that negative result; they do not reinterpret it as success.

## Next allowed action

Remain in M1. Do not begin M2. A new validity intervention must preserve
visual quality and be evaluated against representative and holdout rows. The
authorized $30 synthetic bake-off cap remains hard, so no additional provider
study may be started without a new user authorization that explicitly changes
that ceiling.

## Continuation addendum: corrected acceptance complete

The architecture-owner correction linked from the decision record supersedes
the “not accepted” operational status above without erasing that history. M1
now passes G1–G5 under the corrected layered contract. The canonical acceptance
artifact is
`server/board/eval/results/2026-09-01-drawing-m1-corrected-acceptance.json`
(SHA-256 `72e12e65eed3361e169e29dabedbb87d26f83542022db8f7c21903360409c2e7`).

Proven offline: F1–F8 regressions; 360-row authority replay; G1/G2; actual
Lesson-page G4 distribution and inspected first-paint screenshots; permanence,
replay, build, type, lint, security, storage, visual and accessibility gates.
Provider-backed synthetic evidence: the separately authorized F9 study proves
G3 at 350/360 with Terra-medium escalation and 3.9643 mean blind grade. It used
53 calls and $0.2692976 of a $3.25 ceiling; no child data entered the study.
Target hardware, child use, and deployed behavior remain live-required and are
not inferred from these results.

Working-tree reconciliation preserved the pre-existing auth overlay entirely
unstaged. The dirty drawing-recovery number-line shortcut was moved out of the
classic Director into the deterministic template lane ahead of both Director
paths; explicit learner drawing commands retain their application-owned route.
No auth file or auth hunk is part of Drawing vNext staging.
