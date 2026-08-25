# Phase 0 telemetry handoff

## Proven offline

- Verification base: `aec9d54` against pre-Phase-0 base `d8e2258`.
- Complete plan/milestone/fix ledger through the verification base:
  - plans and documentation: `e899e5b` (telemetry contract), `d850246` (implementation plan), `fce1a6f` (plan fixture correction), `ac88176` (client response-correlation boundary), `c139629` (board-observer semantics), `93a9899` (telemetry smoke preparation), `00209ee` (safe smoke execution), and `aec9d54` (final gate list);
  - implementation milestones: `0f9b03b` (typed session telemetry), `912d4c2` (Realtime session telemetry), `f17a53a` (voice/reveal timing), `f12af31` (board permanence observer), and `65ff6ab` (parent-scoped session logs);
  - fixes: `ee146d3` (session-log projection hardening), `b4bd342` (Task 1 review gaps), `7a6023e` (observer-only Realtime telemetry), `1af8454` (released-start reconnect counting), `5210c01` (voice/response telemetry), `89ed343` (board observer ratification), `be4b590` (session-log cache prevention), and `1e74d49` (smoke-reporter safety boundary).
- The implemented data path is browser/provider lifecycle observer → versioned runtime envelope → server identity and payload validation → released `metric` event → parent-scoped `GET /api/sessions/:id/log` projection. It does not change lesson, board, interruption, response-creation, model, or transport ownership.
- Final static and offline gates passed: `npm run build` (147 modules transformed), `npm run typecheck:server`, `npm run lint`, `npm test` (47/47 files, 311/311 tests), `npm run test:smoke-report` (14/14), `npm audit --omit=dev` (0 vulnerabilities), `npm run test:integration` (47/47 files, 311/311 tests), `npm run test:security` (3/3 files, 15/15 tests), `npm run test:storage` (3/3 files, 5/5 tests), `npm run test:brand`, and `npm run test:runtime-models` (8/8 assertions).
- Browser gates ran sequentially and passed: `npm run test:e2e` (12/12), `npm run test:visual` (48/48 existing baselines without updates), and `npm run test:a11y` (3/3).
- Scope inspection against `d8e2258` found 32 Phase 0 files at `aec9d54` (6,522 insertions, 202 deletions). `git diff --check` passed. No visual snapshot path, runtime model/provider identifier, `response.create` or VAD ownership, learner-draft/Done behavior, or tutor-permanence behavior changed. The added code contains no explicit `any`, unused export, dead implementation, or commented-out implementation.
- No live smoke, provider call, deployment, paid resource, resource creation, snapshot update, or push occurred during final verification. The branch remained 21 commits ahead of its remote at the verification base. The three pre-existing untracked architecture prompt/review documents remained untouched and uncommitted.
- Runtime identifiers remain `gpt-realtime-2.1`, `gpt-4o-mini-transcribe`, and `gpt-5.6-terra`; Realtime reasoning remains `low`, fallback `none`, and summary `low`. WebSocket plus browser-owned PCM, generation cancellation, released-only replay, parent scoping, and every active runtime invariant remain unchanged.

## Requires authorized live verification

- Live remains unverified. Normal execution of `NOURA_BASE_URL=https://authorized-origin.example npm run e2e:live -- --authorized-live-run --text-only` may reach the configured provider and must not occur until deployment and live-provider authorization are explicit.
- An authorized synthetic run must capture `/api/version` and the parent-owned session log from the authenticated browser context, then retain the emitted JSON report with git SHA, runtime model IDs, session ID, elapsed duration, exact tutor-audio total, `response.done` token categories, Phase 0 aggregates, and unresolved observations.
- Provider token counts can be verified only from a real `response.done.response.usage` projection. Currency is not present there; any USD amount remains optional user input manually reconciled against the provider billing surface. Any local rate-card result must be labelled an estimate with source date.
- Physical acoustic onset/silence, target device/OS/browser, microphone/speaker path, room noise, real autoplay/permission behavior, and genuine browser zoom still require target-hardware evidence. The prepared synthetic browser report cannot verify them.
- Any future live smoke remains capped at two short synthetic sessions and must use synthetic learner data only.

## Deferred

- Phase 1 transport work, including any WebRTC or sideband design, migration, or playback-boundary rebinding, is not implemented by this handoff.
- Later blueprint phases are not implemented or claimed by this Phase 0 milestone.
- A true semantic false-barge-in rate is deferred until labelled live ground truth exists. Phase 0 reports gate and provider terminal outcomes separately and does not relabel them as semantic false positives.
- Real-user Production authentication, approved retention/deletion operations, ZDR/account evidence, legal/privacy ownership, target-hardware safety evaluation, and the other existing Production blockers remain outside Phase 0.
