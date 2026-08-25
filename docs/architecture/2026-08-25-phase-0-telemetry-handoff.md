# Phase 0 telemetry handoff

## Second-review status

The offline evidence below describes the first hardening wave at `3924e0b` and
is historical, not final evidence for the current reviewed head. A second
consolidated wave is in progress to add the production SQLite worker boundary,
ordered gap barriers, session-owned encoding metadata, complete timeline
reconciliation, and exact-map-only terminal telemetry. Final commit and gate
evidence will be replaced only after all required non-browser gates pass.

## Proven offline

- Final hardening code head: `3924e0b` against pre-wave head `0e1cfaa`.
  The consolidated wave is `9e5449f` (decision/design), `c513c2f`
  (ordered telemetry runtime), and `3924e0b` (exact smoke/API/docs).
- The implemented path is browser/provider observer → trusted runtime envelope
  → synchronous typed preparation and session-scoped ID pseudonymization →
  bounded ordered non-blocking writer → released `metric` event →
  parent-scoped log projection. Repository latency cannot hold initial
  `response.create`, cancellation, cue/response completion, or later messages.
- `telemetry_gap` projects aggregated server queue, server persistence, and
  browser pre-ready queue loss. Pending server gaps precede later observations;
  the smoke gate rejects any gap. This is honest known-loss accounting, not a
  guarantee after an unrecovered browser/fallback/failed transport.
- Raw turn, generation, provider-response, visual-cue, semantic-object,
  section, and object IDs are absent from prepared writes and are
  defense-in-depth pseudonymized during projection. Board/narration timing
  requires exact accepted-response correlation. Duplicate provider terminal
  events cannot duplicate usage, tutor duration, or cancellation outcome.
- The smoke reporter accepts an HTTP(S) origin only, validates exact
  `/api/version` and session-log allowlists, requires origin/session/schema
  agreement, and reconciles safe positive provider timeline rows exactly to
  summary totals. Session-log `200`, `401`, `404`, and handled `500` paths are
  `no-store`.
- Strict RED was observed before implementation: the focused telemetry command
  failed 19 tests plus the missing writer module, and the smoke reporter command
  failed 21 new assertions. GREEN evidence at the code head:
  - focused shared/session-log/recorder/writer/proxy/RealtimeSession/API suite:
    8 files, 106 tests passed;
  - `npm test`: 48 files, 323 tests passed;
  - `npm run test:smoke-report`: 34 tests passed;
  - `npm run test:integration`: 48 files, 323 tests passed;
  - `npm run test:security`: 3 files, 16 tests passed;
  - `npm run build`: 147 modules transformed;
  - `npm run typecheck:server`, `npm run lint`, `npm run test:brand`,
    `npm run test:runtime-models` (8/8 assertions), and `git diff --check`
    passed.
- Per instruction, browser/visual/accessibility suites were not run in this fix
  wave. Their earlier pre-hardening results are historical only; the controller
  must rerun every browser gate against the reviewed head.
- No visual snapshot, runtime model/provider identifier, `response.create` or
  VAD ownership, learner draft/Done behavior, tutor permanence behavior, broad
  parent-route cache policy, dependency, migration, table, or service changed.
- Nothing was pushed or deployed; no provider/live smoke/paid/resource call ran.
  The three pre-existing untracked architecture prompt/review documents remain
  untouched and uncommitted.
- Runtime identifiers remain `gpt-realtime-2.1`, `gpt-4o-mini-transcribe`, and `gpt-5.6-terra`; Realtime reasoning remains `low`, fallback `none`, and summary `low`. WebSocket plus browser-owned PCM, generation cancellation, released-only replay, parent scoping, and every active runtime invariant remain unchanged.

## Requires authorized live verification

- Please explicitly authorize deployment of Phase 0 and at most two short synthetic live sessions using synthetic learner data only. Phase 1 has not begun and will not begin under this authorization request.
- Live remains unverified. Normal execution of `NOURA_BASE_URL=https://authorized-origin.example npm run e2e:live -- --authorized-live-run --text-only` may reach the configured provider and must not occur until deployment and live-provider authorization are explicit.
- An authorized synthetic run must capture `/api/version` and the parent-owned
  session log from the authenticated browser context, then retain the exact
  allowlisted report with git SHA, runtime model IDs, session ID, elapsed
  duration, tutor-audio total, reconciled `response.done` token categories,
  Phase 0 aggregates/gap totals, and unresolved observations.
- Provider token counts can be verified only from a real `response.done.response.usage` projection. Currency is not present there; any USD amount remains optional user input manually reconciled against the provider billing surface. Any local rate-card result must be labelled an estimate with source date.
- Physical acoustic onset/silence, target device/OS/browser, microphone/speaker path, room noise, real autoplay/permission behavior, and genuine browser zoom still require target-hardware evidence. The prepared synthetic browser report cannot verify them.
- Any future live smoke remains capped at two short synthetic sessions and must use synthetic learner data only.

## Deferred

- Phase 1 transport work, including any WebRTC or sideband design, migration, or playback-boundary rebinding, is not implemented by this handoff.
- Later blueprint phases are not implemented or claimed by this Phase 0 milestone.
- A true semantic false-barge-in rate is deferred until labelled live ground truth exists. Phase 0 reports gate and provider terminal outcomes separately and does not relabel them as semantic false positives.
- Real-user Production authentication, approved retention/deletion operations, ZDR/account evidence, legal/privacy ownership, target-hardware safety evaluation, and the other existing Production blockers remain outside Phase 0.
