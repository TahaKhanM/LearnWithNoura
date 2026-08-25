# Phase 0 baseline and telemetry design

Status: approved for implementation on 2026-08-25.

This note narrows Phase 0 of the Noura architecture overhaul into an
observer-only change. It does not change lesson behavior, provider behavior,
board behavior, or turn ownership. It establishes the measurements needed to
evaluate later transport and sequencing work honestly.

## Baseline

The untouched branch passed every required gate on 2026-08-25:

- `npm run build`
- `npm run typecheck:server`
- `npm run lint`
- `npm test` — 40 files, 233 tests
- `npm run test:e2e` — 12 tests
- `npm run test:visual` — 48 tests
- `npm run test:a11y` — 3 tests
- `npm run test:security`
- `npm run test:storage`
- `npm run test:brand`

No visual snapshot was updated. The three pre-existing untracked architecture
documents are source material only and remain untouched.

## Provider verification

The provider assumptions in the overhaul prompt match the current OpenAI
documentation, so no provider-conflict decision note is required:

- The WebRTC unified interface sends browser SDP through an application server
  to `POST /v1/realtime/calls`, authenticated by the server's standard API key.
- The SDP response exposes a `Location` header whose final path component is
  the `call_id`.
- A server can attach
  `wss://api.openai.com/v1/realtime?call_id={callId}` as a sideband control
  connection for the same call.
- WebRTC carries model audio as a media track and carries Realtime JSON events
  on the data channel. WebRTC/SIP output-buffer events include
  `output_audio_buffer.started`, `.stopped`, and `.cleared`.
- `response.create` supports response-scoped `instructions` and
  `max_output_tokens`.
- Semantic VAD supports `low`, `medium`, `high`, and `auto` eagerness.
  Input noise reduction supports near-field and far-field modes.
- `gpt-realtime-2.1` supports text, audio, and image input plus configurable
  reasoning effort.
- GPT Image 1.5 and GPT Image 2 support streamed partial images.

References checked:

- <https://developers.openai.com/api/docs/guides/realtime-webrtc>
- <https://developers.openai.com/api/docs/guides/realtime-server-controls>
- <https://developers.openai.com/api/docs/guides/realtime-conversations>
- <https://developers.openai.com/api/docs/guides/realtime-vad>
- <https://developers.openai.com/api/docs/models/gpt-realtime-2.1>
- <https://developers.openai.com/api/docs/guides/image-generation>
- <https://developers.openai.com/api/reference/resources/realtime/client-events/>

## Constraints

Phase 0 must preserve:

- permanent visible tutor work;
- explicit learner drafts and idempotent Done submission;
- server-only `response.create` ownership;
- released-only replay and generation identity;
- immutable ended sessions and evidence lineage;
- the existing exact geometry compiler and quality gates;
- server-only provider credentials;
- the current provider and runtime model identifiers.

Instrumentation must not contain names, transcript text, board images, raw
audio, pointer trails, auth material, or provider credentials.

## Architectural choice

Three implementation shapes were considered.

1. Add more untyped `{ name, ms }` writes directly in `RealtimeSession`.
   This is small but repeats the current weakness: names, units, correlation,
   aggregation, and privacy constraints remain implicit.
2. Add a dedicated telemetry table or third-party metrics SDK. This duplicates
   the event log, expands storage migrations, and violates the Phase 0 scope.
3. Define a typed observation contract, persist observations as existing
   released `metric` events, and project a structured session log from those
   events.

The third option is selected. It keeps one event-sourced truth while making the
contract explicit and reusable by the WebRTC and interleaving phases.

## Module boundaries

Phase 0 introduces small single-purpose modules:

- `shared/sessionTelemetry.ts`
  - owns metric names, units, dimensions, schemas, and public log types;
  - validates both new observations and historical `{ name, ms }` rows;
  - contains no browser or repository dependency.
- `src/lesson/sessionTelemetry.ts`
  - owns browser-clock timing correlation and barge-in candidate outcomes;
  - exposes observations to `RealtimeSession`;
  - contains no React code.
- `src/board/renderedObjectTracker.ts`
  - compares successive rendered tutor-object sets;
  - consumes explicit navigation identities;
  - reports unexplained disappearance without mutating the scene.
- `server/session/sessionLog.ts`
  - normalizes released metric rows;
  - builds aggregates and a bounded metric timeline;
  - contains no Express or provider logic.

Existing modules only supply lifecycle facts:

- `RealtimeSession` emits client observations and preserves envelope identity.
- `VoiceInterruptionGate` reports existing state transitions without changing
  its thresholds or interruption decision.
- `LessonPage` supplies first committed paint, explicit navigation, and
  rendered tutor IDs.
- `proxy.ts` validates and persists observations and records provider-side
  cancellation/reconnect outcomes.
- `server/api.ts` authorizes and serves the projected log.

No new module may own lesson decisions, board mutations, response creation, or
transport retry behavior.

## Observation contract

New writes use one versioned, discriminated payload:

```ts
interface MetricObservation {
  schemaVersion: '1.0.0';
  name: MetricName;
  unit: 'ms' | 'count';
  value: number;
  connectionEpoch: number;
  turnId: string;
  generationId: string;
  providerResponseId?: string;
  visualCueId?: string;
  semanticObjectId?: string;
  dimensions?: MetricDimensions;
}
```

The containing event row remains the authority for `sessionId`, event ID, and
server timestamp. The runtime envelope remains the authority for accepting the
connection, turn, and generation identity before persistence.

Duration values are finite integers. They are non-negative except for
`board_reveal_to_narration`, whose sign carries ordering. Lifecycle count
observations have value `1`; provider-usage count observations contain the
reported token count. Session totals are always derived rather than
overwritten.

Historical metric rows using `{ name, ms }` remain readable through a narrow
normalizer because stored event replay is a compatibility boundary. New code
does not write the historical shape.

Unknown or malformed observations are not persisted. Bounded enum dimensions
replace free-form labels.

## Metric definitions

### Speech end to response start

Name: `speech_end_to_response_started`

Start: the accepted learner-floor `speech_stopped` event. Speech stops ignored
while Noura owns the floor or while a drawing draft is open do not start the
clock.

End: the first accepted `response_started` for the resulting generation.

This preserves the current metric semantics.

### Speech end to first audio

Name: `speech_end_to_first_audio`

Start: the same accepted learner-floor `speech_stopped`.

End: the first accepted tutor audio chunk for the resulting response.

This remains a browser-received-audio measurement in Phase 0. It is not
reported as an acoustic-onset measurement. Phase 1 can rebind its end boundary
to WebRTC playback events while retaining the metric name.

### Barge-in diagnostics

The current gate has no "confirmed, then cancelled" state. Dual confirmation
immediately interrupts Noura. Phase 0 therefore records facts rather than
claiming semantic false positives without live ground truth.

`barge_in_gate_outcome` dimensions:

- `local_only_rejected`
- `provider_only_rejected`
- `confirmed`

The first two are existing one-sided candidates that expire under the current
gate rules. Instrumentation adds no timer or threshold.

`barge_in_cancel_outcome` dimensions:

- `provider_cancelled`
- `provider_completed`
- `provider_failed`
- `unresolved`

The server correlates a confirmed voice interrupt with the provider response
that was active at the time. A terminal provider event records the terminal
outcome. `unresolved` is derived when projecting the log if no terminal event
exists; no timeout is added.

The structured log exposes these outcome counts separately. It does not call a
rejected candidate or cancellation failure a proven false barge-in.

### Board reveal to narration

Name: `board_reveal_to_narration`

The observation uses one browser monotonic clock:

- narration boundary: the first scheduled audible sample for the response,
  derived from the Web Audio scheduling clock when the first chunk is queued;
- reveal boundary: the first committed browser paint after an accepted visual
  checkpoint enters the visible scene.

Value:

`narrationBoundaryMs - revealBoundaryMs`

- positive: the board appeared before narration;
- zero: same measured millisecond;
- negative: narration began before the board appeared.

The observation is correlated by response ID and, where available, visual cue
and semantic object IDs. Replay, rejected checkpoints, and visual cues without
a correlated narration boundary produce no duration.

This is not animation-completion time. The item becomes board truth before its
draw-on presentation completes, so first committed paint is the stable Phase 0
boundary.

### Section navigation

Name: `section_navigation`

Every actual section change records bounded dimensions:

- previous and next semantic group IDs;
- cause: `initial_anchor`, `notice_open`, `picker`, or `draft_restore`.

`initial_anchor` is observable but is not included in the derived
`sectionSwitchCount`, because it does not replace an existing rendered view.
All other causes are announced or directly learner-initiated navigation.

### Reconnect

Name: `session_reconnect`

Every `session_started` event stores the accepted connection epoch. Before
writing it, the server checks released history for an earlier
`session_started`. Every start after the first records one reconnect
observation. This counts early reconnects even when no transcript exists, is
durable across browser refreshes, and avoids treating a private in-memory retry
counter as truth.

The first connection is not a reconnect. The session log derives a per-session
count by summing observations.

### Tutor-object disappearance

Name: `tutor_object_disappearance`

The tracker compares tutor IDs in successive scenes actually passed to
`BoardCanvas`. A disappearance is emitted only when an ID leaves that rendered
set without the exact render transition carrying an explicit section
navigation identity.

The observation contains only bounded identifiers and a cause:

- `scene_mutation`
- `unknown`

Focus clipping does not remove items from the rendered scene and is excluded.
Announced section navigation is correlated and excluded. Initial render,
component teardown, rejected candidates, and replay initialization are also
excluded.

The detector does not repair the board. It makes any current or future
permanence violation visible in the session log.

### Provider usage for the prepared live smoke

Name: `provider_usage`

The server reads the documented `response.done.response.usage` object and
records bounded token-category counts for each response. Categories cover
input text/audio/image, cached input text/audio/image, and output text/audio.
The server also records `tutor_audio_output_duration` from the response's
existing PCM sample total. No content is retained.

OpenAI documents these usage fields as corresponding to billing, but does not
return a per-response currency charge in `response.done`. The smoke therefore
records provider-reported token usage and accepts an optional currency amount
copied from the provider's billing surface after an authorized run. It must
label any rate-card calculation as an estimate, never as provider-reported
cost.

## Structured session log

`GET /api/sessions/:id/log` returns a parent-scoped, privacy-safe projection:

```ts
interface SessionTelemetryLog {
  schemaVersion: '1.0.0';
  sessionId: string;
  truncated: boolean;
  summary: {
    durations: Record<string, DurationAggregate>;
    bargeIn: BargeInOutcomeCounts;
    sectionSwitchCount: number;
    reconnectCount: number;
    tutorObjectDisappearanceCount: number;
  };
  timeline: SessionMetricEntry[];
}
```

Duration aggregates contain count, minimum, maximum, mean, and latest values.
The timeline contains event ID, server timestamp, metric name, value, unit,
generation correlation, and bounded dimensions.

The endpoint:

- requires the existing parent authentication;
- resolves the session with `getSessionForParent`;
- reads released events only;
- returns `401` without a parent and `404` for cross-parent access;
- never uses the internal-audit event path;
- returns at most the repository's 5,000-event bound and marks a full result as
  potentially truncated.

No transcript or evidence text is copied into the telemetry response.

## Synthetic live smoke preparation

The existing `scripts/e2e-live.mjs` is prepared, not executed:

- accept a configurable base URL instead of assuming localhost;
- retain synthetic-only learner and goal data;
- capture the created session ID;
- retrieve `/api/sessions/:id/log` through the authenticated browser context;
- print model/runtime identifiers, audio duration, provider-reported token
  usage, an optional externally supplied provider cost, metric aggregates, and
  unresolved verification items;
- fail clearly when required telemetry is absent;
- make no deployment or provider call on its own.

The operations runbook documents that deployment, paid calls, target-hardware
acoustics, and live latency remain unauthorized and unverified.

## Test strategy

Tests are written before each behavior-neutral observer implementation:

- schema tests accept every metric variant, reject free-form or private data,
  and normalize historical duration rows;
- session-log tests cover signed duration aggregation, count aggregation,
  unresolved barge-in outcomes, ordering, bounds, and malformed-row exclusion;
- voice-gate tests cover local-only, provider-only, and confirmed outcomes
  without changing gate decisions;
- realtime-session tests cover existing speech metrics with full generation
  correlation and board/narration timing;
- rendered-object tracker tests cover stable objects, additive updates,
  announced navigation, unexplained removal, and teardown;
- proxy tests cover validated persistence, reconnect counts, cancellation
  outcomes, and rejection of malformed metrics;
- API tests cover successful retrieval, unauthenticated access, and
  cross-parent isolation.

The existing E2E, visual, and accessibility suites run unchanged. Phase 0 does
not modify visual snapshots.

## Acceptance and reporting

Phase 0 is complete only when:

- every required gate is green;
- all observations have deterministic unit coverage;
- the session log is retrievable and parent-scoped;
- no product behavior or visual baseline changes;
- README, runtime architecture, privacy, and testing docs match the
  implementation;
- a handoff note separates offline proof, authorized-live requirements, and
  deferred work;
- coherent implementation and documentation milestones are committed;
- no push, deployment, paid resource, or live-provider call has occurred.

At that point the phase stops and requests explicit authorization for the
deployment and synthetic live smoke. Phase 1 does not start until Phase 0's
acceptance criteria are met.
