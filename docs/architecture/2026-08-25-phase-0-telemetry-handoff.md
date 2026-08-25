# Phase 0 telemetry handoff

## Second-review status

The producer-authority follow-up is complete at code head `ddc2ad1`.
Browser/visual/accessibility evidence remains intentionally pending controller
rerun; no live/provider/hardware claim is added.

## Proven offline

- Producer-authority code head: `ddc2ad1` against reviewer head `2706aca`.
- Timeout terminalization code head: `bc79203` against reviewer head `9f31e96`.
- Shutdown admission code head: `011861e` against reviewer head `2b089c2`.
- Distributed lifecycle code head: `a3c72a1` against reviewer head `887d21a`.
  Code commits are `f2d02c5`, `a3c72a1`, and `011861e`.
- Lifecycle hardening code head: `fcf8a64` against reviewer head `b4281da`.
  Commits are `524af68` (ratified contract) and `fcf8a64` (lifecycle fixes).
  The preceding wave was `4fced4d` against `fef2bc8`.
  The wave is `99f4f39` (decision/design clarification), `2c7b526`
  (off-thread ordered telemetry), and `4fced4d` (complete smoke
  reconciliation/docs).
- The implemented path is browser/provider observer → trusted runtime envelope
  → synchronous typed preparation and session-owned ID encoding → bounded
  ordered non-blocking writer → real async repository boundary → released
  `metric` event → parent-scoped log projection. Production SQLite telemetry
  append/prior-start paging runs in a worker; Postgres stays natively async.
  Repository latency cannot hold initial `response.create`, cancellation,
  cue/response completion, or later messages.
- `telemetry_gap` projects fixed exact counters for server queue, persistence,
  reconnect-history, accounting-overflow, and browser pre-ready loss. Accepted
  normal rows remain FIFO; gap counters are completeness, not chronology,
  evidence under saturation. A pending gap blocks later normal acceptance.
  The smoke gate rejects any gap. This is honest known-loss accounting, not a
  guarantee after an unrecovered browser/fallback/failed transport.
- Raw turn, generation, provider-response, visual-cue, semantic-object,
  section, and object IDs are absent from prepared writes and are
  defense-in-depth pseudonymized during projection. Preparation always
  transforms input; projection preserves only valid server metadata plus a
  current-session token prefix. Board/narration timing requires exact accepted
  response correlation. Duplicate provider terminal events cannot duplicate
  usage, tutor duration, or cancellation outcome, and unknown terminal response
  IDs emit no terminal telemetry.
- The smoke reporter accepts an HTTP(S) origin only, validates exact
  `/api/version` and session-log allowlists, requires origin/session/schema
  agreement, requires strictly ascending event IDs, reconstructs every duration
  and lifecycle field from timeline rows, and uses checked safe-integer totals.
  Session-log `200`, `401`, `404`, and handled `500` paths remain `no-store`.
- Strict second-wave RED was observed before implementation: the focused
  command failed 11 tests plus the missing adapter module, and the smoke suite
  failed seven new reconciliation assertions. Final GREEN evidence:
  - focused shared/session-log/recorder/writer/proxy/RealtimeSession/API suite:
    8 files, 104 tests passed;
  - `npm test`: 50 files, 349 tests passed;
  - `npm run test:smoke-report`: 45 tests passed;
  - `npm run test:integration`: 50 files, 349 tests passed;
  - `npm run test:security`: 3 files, 16 tests passed;
  - `npm run test:storage`: 3 files, 6 tests passed;
  - `npm run build`: 147 modules transformed;
  - `npm run typecheck:server`, `npm run lint`, `npm run test:brand`,
    `npm run test:runtime-models` (8/8 assertions), and `git diff --check`
    passed.
- Per instruction, browser/visual/accessibility suites were not run in this fix
  wave. Their earlier pre-hardening results are historical only; the controller
  must rerun every browser gate against the reviewed head.
- Final producer-authority lifecycle/proxy/writer focus: 3 files, 69 tests.
  Deadline expiry reports forced only when sealed side-effect chains are
  settled; otherwise the injected fatal process hook runs and repository close
  is skipped.
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
