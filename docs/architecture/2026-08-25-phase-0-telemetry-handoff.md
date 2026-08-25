# Phase 0 telemetry handoff

## Proven offline

- Commit ledger: Phase 0 began at `d850246`; Task 1 completed through `b4bd342`, Task 2 through `1af8454`, Task 3 through `5210c01`, Task 4 through `89ed343`, and Task 5 through `be4b590`. Task 6 is the commit that introduces this handoff; its hash is recorded in the external Task 6 report because a commit cannot embed its own hash.
- The implemented data path is browser/provider lifecycle observer → versioned runtime envelope → server identity and payload validation → released `metric` event → parent-scoped `GET /api/sessions/:id/log` projection. It does not change lesson, board, interruption, response-creation, model, or transport ownership.
- `node --test scripts/e2e-live.test.mjs` passed 3/3 deterministic rows: help remains offline, fixture token data is not labelled live provider evidence, and a WAV fixture missing speech/provider observations exits nonzero.
- `node scripts/e2e-live.mjs --help`, `node --check scripts/e2e-live.mjs`, `npm run build`, `npm run typecheck:server`, `npm run lint`, `npm run test:brand`, and `git diff --check` passed.
- The existing E2E/visual snapshots are unchanged; Task 6 adds no snapshot file and does not execute browser E2E.
- No provider call, deployment, paid resource, resource creation, authorization request, or push occurred during Task 6. The three pre-existing untracked architecture prompt/review documents remain untouched and uncommitted.
- Runtime identifiers remain `gpt-realtime-2.1`, `gpt-4o-mini-transcribe`, and `gpt-5.6-terra`; Realtime reasoning remains `low`, fallback `none`, and summary `low`. WebSocket plus browser-owned PCM, generation cancellation, released-only replay, parent scoping, and every active runtime invariant remain unchanged.

## Requires authorized live verification

- Live remains unverified. Normal execution of `NOURA_BASE_URL=https://authorized-origin.example node scripts/e2e-live.mjs --text-only` may reach the configured provider and must not occur until deployment and live-provider authorization are explicit.
- An authorized synthetic run must capture `/api/version` and the parent-owned session log from the authenticated browser context, then retain the emitted JSON report with git SHA, runtime model IDs, session ID, elapsed duration, exact tutor-audio total, `response.done` token categories, Phase 0 aggregates, and unresolved observations.
- Provider token counts can be verified only from a real `response.done.response.usage` projection. Currency is not present there; any USD amount remains optional user input manually reconciled against the provider billing surface. Any local rate-card result must be labelled an estimate with source date.
- Physical acoustic onset/silence, target device/OS/browser, microphone/speaker path, room noise, real autoplay/permission behavior, and genuine browser zoom still require target-hardware evidence. The prepared synthetic browser report cannot verify them.
- Any future live smoke remains capped at two short synthetic sessions and must use synthetic learner data only.

## Deferred

- Phase 1 transport work, including any WebRTC or sideband design, migration, or playback-boundary rebinding, is not implemented by this handoff.
- Later blueprint phases are not implemented or claimed by this Phase 0 milestone.
- A true semantic false-barge-in rate is deferred until labelled live ground truth exists. Phase 0 reports gate and provider terminal outcomes separately and does not relabel them as semantic false positives.
- Real-user Production authentication, approved retention/deletion operations, ZDR/account evidence, legal/privacy ownership, target-hardware safety evaluation, and the other existing Production blockers remain outside Phase 0.
