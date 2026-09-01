# Noura testing and evaluation runbook

## Default offline gates

Run the commands in README, including `npm run test:smoke-report` before
`npm test`. The deterministic Node reporter suite checks the explicit
authorization boundary, origin-only configuration, redirect/session/schema
mismatches, exact endpoint allowlists, safe-integer duration/provider rows,
strictly ascending timeline order, complete duration/lifecycle/usage/gap
summary reconstruction, telemetry-gap/truncation gates, and
privacy redaction without opening a browser or claiming live evidence.
Unit/property coverage also uses a synchronous-blocking fake plus the
production SQLite worker adapter to prove telemetry
cannot delay response creation, cancellation, cue/response completion, or
later messages; verifies writer ordering/gap recovery, identifier
pseudonymization, strict response correlation, terminal deduplication, storage
cutoffs, owner-aware operations, render inspection, committed animation
cancellation, character priority/smoothing, Postgres snapshot parity, summary
citation validation, security capabilities, and Production fail-closed
configuration.

Browser suites use a dedicated synthetic SQLite directory and separate ports. Visual baselines cover Noura Home at 1440×900, 834×1112, 390×844 and 844×390 plus every canonical semantic scene at desktop, tablet and mobile-focus widths.

## Offline lesson evaluation (Phase 5)

`npm run test:lesson-eval` reads checked-in fixtures under
`server/lesson/eval/fixtures/`, scores five dimensions through production
modules, writes `artifacts/evaluation/lesson-eval-report.json`, and exits
nonzero on gate failure. This is the default synthetic lesson gate: it makes
no provider call, claims no live latency or acoustic evidence, and never
labels a single duration observation as a percentile.

Scoring dimensions (all deterministic offline):

1. **Reveal–narration coherence** — scripted storyboard timelines must
   narrate each reveal before the next reveal; referenced object ids are
   derived from each storyboard step’s `objectIds`. When `anchorScene` is
   present, reveal ops are bound to production `storyboardRunSteps`. Includes
   passing, narration-before-reveal failing, and consecutive-reveal failing
   fixtures.
2. **Object permanence** — production `BoardOp` batches replayed through
   `applyOps` and scored with `RenderedTutorObjectTracker`; tutor erase,
   clear, and same-id overwrite outside announced section navigation fail.
   Includes one passing log and two failing logs (erase and overwrite).
3. **Turn-latency percentiles** — Phase 0 fixtures of
   `speech_end_to_response_started` and `speech_end_to_first_audio` compute
   p50/p95 only when n ≥ 5 (hard floor); otherwise the report states
   `insufficient_n`.
4. **False barge-ins** — dual-gate traces count confirmed-then-cancelled,
   `provider_completed` after confirmed, `provider_failed`, and unlabelled
   cancellations separately. Scorer pass matches pinned expected counts only.
   Includes fixtures that pin all four expected counts.
5. **Blueprint quality** — fixed rubric at
   `server/lesson/eval/blueprint-quality-rubric.json` (`passThreshold: 0.7`);
   default offline path uses structural scoring for known-good and known-weak
   compiled-lesson fixtures. Live strong-model judging is **not implemented**;
   the default script refuses live invocation.

The blueprint rubric, fixtures, and scorer modules compose with — and do not
replace — `npm run test:av`, `npm run test:smoke-report`, and the existing
Vitest/proxy interruption rows.

## Drawing Director evaluation (Drawing vNext M0)

`npm run test:director-eval` writes
`artifacts/evaluation/director-eval-report.json` from deterministic offline
fixtures. It covers 24 representative and 12 sealed holdout intents across
exact maths/geometry, graphs/charts, scientific systems, timelines/causal
structure, grammar, comparisons/part-whole, unfamiliar abstractions,
diagram-plus-illustration requests, and revisions against exact released
existing-board BoardOps plus a rendered board raster. The holdout split is
never returned by the prompt-tuning helper.

The offline matrix is five trials for both cold and warm cache states under
`terra-low`, `terra-med`, `luna-low`, `luna-med`, and the first-valid-step
`terra-low+luna-low` hedge. Synthetic timings exercise the aggregation and
pre-registered decision rule; proposals use the template-first strict vNext
`steps[].ops` schema and cross the authored BoardOp validator,
permanence/density/id policy, browser preflight, and storyboard-coverage
validator. Fixed fixture grades exercise the blind raster rubric contract.
They are not provider or model-quality evidence.

The same gate scores 12 exact semantic-defect rasters plus 12 matched clean
controls that authored validation, Director policy, and browser preflight all
accept (wrong shading, mislabeled value, reversed arrow). It materializes 30
synthetic sketches from ten board-coordinate bases with three deterministic
jitter seeds and renders them through the real board harness. No child data is
used. The cheaper sketch second opinion remains off: this corpus measures
interpretation rather than semantic check grading, even when a paired
significance test finds an interpretation gain.

Live evaluation is a separate, explicit path:

```bash
# DO NOT RUN without fresh provider-spend authorization.
NOURA_BOARD_HARNESS_URL=http://127.0.0.1:5173/dev/board \
npm run test:director-eval -- --authorized-live-run --max-spend-usd 30
```

The live path uses only checked-in synthetic inputs, streams every composition
condition, validates and rasters through the configured real board harness,
blind-grades the pre-registered cold trial-one sample with the pinned rubric
judge, measures cache-token usage, runs the seeded vision-audit and sketch
studies, aborts losing hedge legs, and refuses any next call whose full
reservation would cross the configured cap. The base completed design is 2,397
provider calls (2,160 composition legs, up to 125 judges, four warmups, 48
audit calls, and 60 sketch calls), plus separately recorded bounded retries.
Unused completion headroom is not charged; failed and usage-incomplete calls
retain their full reservation.

Warm cache behavior is measured rather than assumed: every cold cell must stay
cold, and each condition must achieve at least an 80% hit rate at the measured
1,792-token provider reporting boundary. Individual misses remain raw data.
Each live event and trial checkpoint is synchronously appended to NDJSON.
`--resume-from` may be repeated to merge compatible, non-overlapping rows from
hashed zero-open-reservation sources; incompatible caps, stale cache flags, and
incomplete quality grades are discarded and rerun. Raw decision evidence
belongs under `server/board/eval/results/`; do not copy the offline artifact
there or present an offline fixture winner as an adopted model. The completed
M0 decision is documented in
`docs/architecture/2026-09-01-drawing-model-bakeoff-decision.md`.

## Drawing M1 paired delivery replay

`npm run test:director-m1-eval` verifies two committed artifacts against the
pinned M0 Terra-low source:

- `2026-09-01-drawing-m1-pipeline-browser-observations.json` is the raw local
  browser ledger (atomic verdicts, every cumulative step verdict, render
  hashes, final loopback origin, and external request count);
- `2026-09-01-drawing-m1-pipeline-study.json` is the derived 360-row paired
  delivery report.

The default verifier makes no browser or provider call. It validates source
hashes, the policy-pinned browser-ledger hash, the full row matrix,
diagram-only validity tolerance, complete 24/24 blind-grade reuse, exact final
ops/raster parity, browser observation mappings, and every aggregate.

This is a same-proposal delivery-path comparison, not a generator/model A/B.
Its latency result is a conservative provider-critical-path readiness cut,
not actual learner-browser first paint. The report intentionally has
`m1AcceptancePass: false`: full first-pass validity is 329/360 (91.3889%),
below the unchanged 95% gate, and actual `ops_presented` latency remains a
separate acceptance requirement.

Provider-free regeneration accepts only a loopback `/dev/board` URL, aborts
non-loopback HTTP/WebSocket traffic, verifies the final origin/path, and must
record `externalRequestCount: 0`:

```bash
npm run client -- --host 127.0.0.1 --port 5180
npm run test:director-m1-eval -- --regenerate \
  --harness-url http://127.0.0.1:5180/dev/board
```

Voice-interruption unit/integration rows cover short loud noise plus server VAD,
sustained local energy without server confirmation, adaptive room-noise
calibration, sustained speech with both detectors, one-turn high-eagerness
endpointing with medium restoration, the `speech_stopped → thinking` phase, and
speech-end-to-response/audio metrics. Reported gate outcomes count observed
state transitions, not semantic speech episodes or proven false positives.
These deterministic checks prevent cancellation and turn-latency lifecycle
regressions but do not replace labelled or physical-room microphone testing.

The actual Lesson browser rows require an animated tutor object to survive callback/phase re-renders and mid-animation learner interruption, finish visibly, emit replay acknowledgement after identity replacement, retain the learner stroke, and send a board-only response request with sanitized path operations plus a size-bounded JPEG board context. Another adversarial browser row reconstructs the reported triangle/text overlap, requires the annotation coordinate to move, samples the rendered triangle path every two board units and fails if any stroke enters the padded text box. A separate row verifies the visible thinking state at speech stop before reply audio.

Board Intelligence v2 tests reconstruct released tutor and learner objects while excluding unheard events; require reusable section/object IDs in Realtime/fallback context; enforce relevance/action/density policy; suppress exact raw redraws and mostly equivalent semantic scenes; preserve learner marks across section clear/replace; and feed client quality rejection back to the agent. Learner-sketch tests cover line/underline/circle features, bounds, nearest/touched tutor objects, section ownership and the 960×576 full-board/detail composite. These features do not prove learner intent.

Canonical geometry includes every exact subject template plus relationship-map, worked-step, comparison and proportional part–whole grammars at desktop, tablet and mobile-focus sizes. Compact traversal must expose every required annotation/equation without clipping. The real Lesson has desktop/mobile board-awareness baselines; adversarial browser coverage verifies section isolation, section-bound learner marks, specific highlight de-emphasis, status semantics and the original triangle/text stroke collision.

## Controlled live-provider smoke

Offline fixtures are the default. `npm run test:av` drives the production `ResponseCueTimeline` and `CharacterAttentionController`; it derives one caption-cue error and one visual-cue error from observed scheduler releases, final correction from observed playback completion, pending/stale cues from post-cancel scheduler state, interruption attention from controller output, and audio resumption/silence from PCM windows. It retains seven non-redundant gates and publishes a full 7×7 negative-control matrix. Every row mutates captured trace or PCM input, must make its named gate false, and must leave all six unrelated gates at the passing baseline; the evaluator exits nonzero if isolation fails. It does not report distribution percentiles from single observations. The JSON report and WAV are written under `artifacts/evaluation/`; they are deterministic offline production-module evidence, not provider, rendered-browser, frame-performance or target-hardware evidence. The former generic drawbox MP4 and assigned mobile-frame/render-phase metrics were removed because they did not observe a Noura application surface.

The synthetic live reporter remains excluded from every default gate:

```bash
# DO NOT RUN without explicit deployment and live-provider authorization.
NOURA_BASE_URL=https://authorized-origin.example npm run e2e:live -- --authorized-live-run --text-only
```

`NOURA_BASE_URL` must be exactly an HTTP(S) origin: userinfo, a non-root path,
query, and fragment are rejected before any browser launch and are never copied
into a failure report. The WAV form supplies one synthetic capture path instead
of `--text-only`. The script captures the created lesson session ID, then uses
the still-authenticated browser context to read `/api/version` and
`GET /api/sessions/:id/log`; it never queries SQLite directly. It requires the
actual origin, session ID, and both schema versions to match. A WAV report exits
nonzero when speech-end-to-response-start, speech-end-to-first-audio,
tutor-audio-duration, or provider-usage observations are absent. Text-only mode
requires its text-ask first-audio boundary and does not require either
speech-end metric.

For a login-gated target, pass the demo account only through
`NOURA_SMOKE_LOGIN_EMAIL` and `NOURA_SMOKE_LOGIN_PASSWORD`. The harness detects
the login boundary, authenticates in the browser, and retains neither value in
its report.

For an authorized protected `*.vercel.app` target, provide the temporary
32-character automation credential only through
`NOURA_VERCEL_PROTECTION_BYPASS`. The harness validates the target, performs a
manual-redirect server-side bootstrap, accepts only Vercel's host-bound
`_vercel_jwt` cookie, and opens the browser without the raw secret in request
headers. Revoke the bypass and remove temporary data-service access immediately
afterward.

The one JSON report contains:

- preparation/evidence mode, configured base URL, actual navigated origin, git SHA, runtime model IDs, scenario, session ID, and elapsed smoke duration;
- the exact sum of logged `tutor_audio_output_duration` rows;
- provider-reported token-usage totals projected from `response.done.response.usage`;
- optional `NOURA_PROVIDER_REPORTED_COST_USD`, explicitly identified as user-supplied from the provider billing surface;
- the exact allowlisted Phase 0 duration/count/gap summary and truncation state;
- bounded tutor-caption, learner-line, board-item, and browser-console-error counts plus hardcoded milestone labels, never raw caption, learner, or console strings;
- smoke-gate missing observations plus `requiresAuthorizedLiveVerification` entries for acoustic onset/silence and target hardware.

The smoke gate fails if the parent-scoped log is truncated, any telemetry gap
is present, or provider usage is absent, non-positive, unsafe, internally
inconsistent, or unequal to the sum of validated timeline usage rows.
`response.done` does not contain a per-response currency charge. After an
authorized run, any currency amount must be manually reconciled from the
provider billing surface. A local rate-card multiplication is allowed only when
labelled **estimate**, with the rate-card source and source date; it is never
“provider-reported cost.” `--report-fixture <path>` and
`npm run test:smoke-report` are offline deterministic report checks and remain
explicitly non-provider evidence even if a fixture contains token counts.

Known gaps are honest incompleteness evidence, not proof that every loss can be
reported. If the browser never reaches another accepted `ready`, or a
fallback/failed transport phase never recovers, final observations can be lost
before the aggregate client gap is delivered. Reject such a run as unable to
prove telemetry completeness.

The August 26 recovery exercise produced a passing provider-backed synthetic
lesson after the nested Vercel route adapter was deployed. A later smoke on the
login-gated production deployment authenticated successfully, recovered a
complete gap-free parent-scoped log, and observed audio, captions, and an
initial board drawing, but failed the strict gate because its follow-up turn did
not produce the required second board change within 40 seconds. Do not loop paid
calls for screenshots. Every future deployment or provider run requires fresh
explicit authorization and must remain short and synthetic. Drawing reliability,
live latency distributions, billed currency, acoustic silence, and
target-hardware results remain UNVERIFIED.

## Target hardware

Record device, OS, browser, headphones/speakers, noise condition, autoplay, permission denial, single/repeated barge-in, portrait/landscape, touch/pointer/drawing gaze and reduced motion. Measure:

- child acoustic onset → detector;
- detector → stop scheduled;
- scheduled stop → recorded acoustic silence;
- provider cancellation confirmation;
- provider speech end → response start;
- provider speech end → first reply audio;
- caption phrase and visual cue error;
- avatar mouth/gaze/pen timestamps;
- frame intervals and long tasks.

If loopback/recorded hardware evidence is absent, mark acoustic results UNVERIFIED. Synthetic PCM cannot substitute for target hardware.

Browser coverage includes a real Lesson component with deterministic fake WebSocket/PCM events for start, listening, thinking, speaking, semantic visual focus, question caption, highlight gaze and drawing interruption. It asserts stale future visual rejection, semantic view geometry, 44 px controls, focus visibility/order, reduced motion, 320 px, mobile landscape and a 640×400 effective-viewport reflow surrogate for a 1280×800 page at 200%. The surrogate exercises the compact width/height media-query path and checks labelled section/previous/next/overview controls, 2 px focus appearance, full required-text containment, at least 16 px active educational text, at least 44 px controls and no two-dimensional document overflow. Playwright does not automate browser UI zoom here, so genuine browser zoom remains UNVERIFIED. This proves browser integration without claiming live provider or physical-device behavior.

Camera scenarios are not applicable because camera support is not implemented.
