# Phase 0 telemetry handoff

## Proven offline

- Final reviewed code head: `e03cde8` against pre-Phase-0 base `d8e2258`.
  The final whole-branch reviewer verdict is **Ready to merge**, with no
  Critical or Important findings.
- Complete Phase 0 commit ledger through the reviewed head:
  - contract, plan, and initial implementation:
    `e899e5b`, `d850246`, `0f9b03b`, `fce1a6f`, `ee146d3`, `b4bd342`,
    `912d4c2`, `7a6023e`, `1af8454`, `ac88176`, `f17a53a`, `5210c01`,
    `f12af31`, `c139629`, `89ed343`, `65ff6ab`, `be4b590`, `93a9899`,
    `00209ee`, `1e74d49`, `aec9d54`, `29736a5`, and `0e1cfaa`;
  - ratified hardening and exact evidence:
    `9e5449f`, `c513c2f`, `3924e0b`, `fef2bc8`, `99f4f39`, `2c7b526`,
    `4fced4d`, `b4281da`, `524af68`, `fcf8a64`, `887d21a`, `f2d02c5`,
    `c114378`, `a3c72a1`, `2b089c2`, `011861e`, `9f31e96`, `bc79203`,
    `2706aca`, `ddc2ad1`, `f8f0c6d`, `4115c0e`, and `4de3853`;
  - final test and cleanup commits:
    `115b9de` (condition-driven fatal-staging shutdown test), `e59941a`
    (unused shutdown test-hook removal), and `e03cde8` (reviewed local
    15-second budgets for the three deliberate heavy contracts).
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
- Definitive sequential evidence at `e03cde8`:
  - `npm run build`: 147 modules, Vite 159 ms, wall 2.346 s;
  - `npm run typecheck:server`: pass, wall 1.755 s;
  - `npm run lint`: pass, wall 0.453 s;
  - `npm test`: 50/50 files and 351/351 tests, Vitest 10.79 s, wall 11.449 s;
  - `npm run test:smoke-report`: 45/45 tests, Node 1,203.094 ms, wall 1.659 s;
  - `npm audit --omit=dev`: 0 vulnerabilities, wall 0.796 s;
  - `npm run test:integration`: 50/50 files and 351/351 tests, Vitest 13.86 s,
    wall 14.539 s;
  - `npm run test:security`: 3/3 files and 16/16 tests, Vitest 837 ms,
    wall 1.522 s;
  - `npm run test:storage`: 3/3 files and 6/6 tests, Vitest 697 ms,
    wall 1.310 s;
  - `npm run test:brand`: pass, wall 0.469 s;
  - `npm run test:runtime-models`: 8/8 assertions and no changed runtime lines,
    wall 0.443 s;
  - `npm run test:e2e`: 12/12 Chromium rows, Playwright 31.9 s,
    wall 32.941 s;
  - `npm run test:visual`: 48/48 existing Chromium baselines without updates,
    Playwright 59.3 s, wall 60.031 s;
  - `npm run test:a11y`: 3/3 Chromium rows, Playwright 8.6 s, wall 9.409 s;
  - `git diff --check`: pass, wall 0.225 s.
- Final scope against `d8e2258` is 49 Phase 0 files, 11,134 insertions, and 245
  deletions. No snapshot path changed. Added-code review found no explicit
  TypeScript `any`, dead implementation, unused export, commented-out
  implementation, or deferred-code marker.
- No visual snapshot, runtime model/provider identifier, `response.create` or
  VAD ownership, learner draft/Done behavior, tutor permanence behavior, broad
  parent-route cache policy, dependency, migration, table, or service changed.
- Nothing was pushed or deployed; no provider/live smoke/paid/resource call ran.
  The three pre-existing untracked architecture prompt/review documents remain
  untouched and uncommitted, with SHA-256 hashes
  `f8d4fbc9b58f50382402531a9a402babb60734e68d449129480f605e53569f23`,
  `c96d8a90af6b3ceed89ab82f1155a6b54c5bf064c696bb819a6087f0b617580e`,
  and `6aad9f869949c89ca263fdd12dabe85d4aa64f77cb404b509d967843610a6b02`.
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
