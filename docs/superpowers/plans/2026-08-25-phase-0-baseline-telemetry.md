# Phase 0 Baseline and Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add privacy-safe, event-sourced session telemetry and a parent-scoped structured session log without changing Noura's lesson, audio, turn, or board behavior.

**Architecture:** Define one typed telemetry contract in `shared/`, prepare and
pseudonymize accepted observations synchronously, submit them to one bounded
ordered non-blocking writer per connection, persist them as existing released
`metric` events, and project those events into a structured log. Browser and
provider lifecycle code supply facts to small pure observers; the realtime
proxy remains the trust boundary and never trusts client-supplied identity.
Known queue/persistence loss is represented by typed gap observations. Existing
event storage, generation envelopes, board state, and transport behavior remain
unchanged.

**Tech Stack:** TypeScript 6, Zod 4, React 19, Express 5, SQLite/Postgres repository contract, Vitest, Playwright.

## Global Constraints

- Phase 0 is observer-only: no lesson, provider, floor, draft, response, board, transport, or visual behavior changes.
- Persist telemetry through existing released `metric` events; add no SDK, table, migration, or external service.
- Never persist names, transcript text, board images, raw audio, pointer trails, auth material, provider credentials, or free-form diagnostic labels.
- The server remains the sole owner of `response.create`; `create_response: false` and `interrupt_response: false` remain unchanged.
- Preserve released-only replay, owner metadata, generation identity, immutable session ending, and evidence lineage.
- Preserve visible tutor permanence and explicit learner Done submission.
- Leave the three pre-existing untracked architecture prompt/review documents untouched.
- Do not update visual snapshots.
- Do not deploy, push, create paid resources, or run live-provider calls.
- No metric repository query or write may be awaited before initial response
  creation, cancellation, cue/response completion, or later message handling.
- Raw telemetry correlation IDs must be converted to deterministic
  field-specific session-scoped opaque tokens after proxy trust checks and
  before persistence; projection repeats this defense for historical/direct
  typed rows.
- The smoke gate fails closed on malformed endpoint data, origin/session/schema
  mismatch, inconsistent provider usage, truncation, or any telemetry gap.

## Final review hardening wave

The implementation tasks below describe the original milestone sequence. The
final review wave additionally follows
`docs/architecture/2026-08-25-phase-0-telemetry-hardening-decision.md` and uses
strict RED/GREEN coverage for:

1. a typed bounded `SessionTelemetryWriter` with one FIFO drain, swallowed
   persistence failures, ordered pending-gap writes, and explicit `flush()`;
2. asynchronous exact prior-start paging below the newly appended
   `session_started` event ID, after initial `response.create`;
3. `telemetry_gap` summary totals for server queue overflow, server persistence
   failure, and client pre-ready overflow;
4. server preparation and session-log defense-in-depth pseudonymization of all
   turn/generation/provider/visual/semantic/section/object identifiers;
5. exact rejection of untrusted board/narration response correlation plus
   bounded provider-terminal and pending-barge-in idempotency sets;
6. origin-only smoke configuration and exact hand-written endpoint/report
   projection with safe-integer duration and provider-usage reconciliation;
7. session-log `no-store` before authorization/ownership checks and one shared
   5,000-row endpoint/projection limit.

Projection consumes released repository rows in ascending event/server
chronology and does not reorder or infer missing rows. Barge-in counts are per
gate transition. An unrecovered browser/fallback/failed transport can still
lose final observations before a gap is delivered, so such a run cannot prove
telemetry completeness.

### Second consolidated review wave

Before final evidence is reconciled, strict RED/GREEN coverage additionally
requires:

1. a production SQLite worker-thread adapter for metric append and exact
   prior-start lookup, native async Postgres delegation, and a yielding
   test/in-memory adapter;
2. one ordered writer queue containing normal observations and gap barriers,
   with bounded gap reserve, adjacency-only merging, in-place failure
   replacement, and original gap reason/value recovery;
3. server-owned encoding metadata plus a session-derived token prefix;
   preparation always transforms input, while projection preserves only
   metadata-valid tokens belonging to the projected session;
4. exact reconstruction of all duration and lifecycle summary fields from
   strictly ascending timeline rows, including checked integer addition and
   required-duration presence in the timeline;
5. exact-map-only terminal telemetry identity, so unknown `response.done`
   events remain behaviorally finalized but emit no terminal metrics.

### Lifecycle accounting follow-up

Strict RED/GREEN coverage additionally requires fixed enum-keyed exact gap
counters, bounded client gap values, explicit accounting-overflow
incompleteness, transactional SQLite end cutoffs under concurrent worker
append, reconnect-history failure gaps, and a shared writer registry that
flushes before bounded repository shutdown. Gap counters are completeness
evidence, not chronological event evidence; only accepted normal observations
retain FIFO ordering.

The final distributed follow-up additionally requires truthful typed flush
failure, close-without-unregister on incomplete persistence, global gap-empty
draining, proxy lifecycle tracking through prior-start settlement, ordered
WebSocket/proxy/repository/worker shutdown, and a transactional PostgreSQL
session-row lock before every event insert.

## File Structure

**Create**

- `shared/sessionTelemetry.ts` — schemas and public telemetry/log types.
- `shared/sessionTelemetry.test.ts` — schema and historical normalization coverage.
- `server/session/sessionLog.ts` — released-event projection and aggregation.
- `server/session/sessionLog.test.ts` — deterministic log aggregation coverage.
- `server/session/telemetryRecorder.ts` — repository write boundary for validated observations.
- `server/session/telemetryRecorder.test.ts` — persistence and identity-authority coverage.
- `src/lesson/sessionTelemetry.ts` — browser-clock response/reveal correlation.
- `src/lesson/sessionTelemetry.test.ts` — signed timing coverage.
- `src/lesson/audioOut.test.ts` — playback-boundary receipt coverage.
- `src/board/renderedObjectTracker.ts` — pure rendered tutor-object visibility observer.
- `src/board/renderedObjectTracker.test.ts` — permanence/navigation observer coverage.
- `src/lesson/LessonPage.test.tsx` — navigation/disappearance integration coverage.
- `docs/architecture/2026-08-25-phase-0-telemetry-handoff.md` — offline/live/deferred handoff.

**Modify**

- `src/lesson/voiceInterruption.ts` and test — expose existing gate outcomes.
- `src/lesson/audioOut.ts` — return the already-scheduled playback boundary.
- `src/lesson/realtimeSession.ts` and test — emit typed client observations.
- `src/lesson/LessonPage.tsx` — report paint, navigation, and rendered IDs.
- `server/realtime/proxy.ts` and tests — delegate validated metric persistence and provider lifecycle observations.
- `server/api.ts` and `server/api.auth.test.ts` — add parent-scoped log retrieval.
- `scripts/e2e-live.mjs` — prepare configurable live smoke reporting.
- `README.md`
- `docs/architecture/2026-08-23-noura-runtime-architecture.md`
- `docs/operations/testing-and-evaluation.md`
- `docs/privacy/threat-model.md`

---

### Task 1: Typed telemetry contract and session-log projection

**Files:**
- Create: `shared/sessionTelemetry.ts`
- Create: `shared/sessionTelemetry.test.ts`
- Create: `server/session/sessionLog.ts`
- Create: `server/session/sessionLog.test.ts`

**Interfaces:**
- Produces:
  - `MetricInputSchema` and `MetricInput`
  - `MetricObservationSchema` and `MetricObservation`
  - `MetricContext`
  - `SessionTelemetryLog`
  - `attachMetricContext(input, context)`
  - `normalizeStoredMetric(payload)`
  - `buildSessionTelemetryLog(sessionId, events, limit)`
- Consumes: `EventRow` from `server/store/repo.ts`

- [ ] **Step 1: Write failing shared-schema tests**

Add tests that exercise the complete discriminated contract:

```ts
import { describe, expect, it } from 'vitest';
import {
  MetricInputSchema,
  attachMetricContext,
  normalizeStoredMetric,
} from './sessionTelemetry';

const context = {
  connectionEpoch: 2,
  turnId: 'turn-3',
  generationId: 'generation-4',
  providerResponseId: 'resp-1',
};

describe('session telemetry contract', () => {
  it('accepts signed board timing and attaches server-owned identity', () => {
    const input = MetricInputSchema.parse({
      schemaVersion: '1.0.0',
      name: 'board_reveal_to_narration',
      unit: 'ms',
      value: -820,
      visualCueId: 'cue-1',
      semanticObjectId: 'anchor-1',
    });
    expect(attachMetricContext(input, context)).toMatchObject({
      value: -820,
      connectionEpoch: 2,
      providerResponseId: 'resp-1',
    });
  });

  it('rejects unknown names, free-form outcomes, and non-finite values', () => {
    expect(MetricInputSchema.safeParse({ schemaVersion: '1.0.0', name: 'child_text', unit: 'count', value: 1 }).success).toBe(false);
    expect(MetricInputSchema.safeParse({
      schemaVersion: '1.0.0',
      name: 'barge_in_gate_outcome',
      unit: 'count',
      value: 1,
      dimensions: { outcome: 'arbitrary text' },
    }).success).toBe(false);
    expect(MetricInputSchema.safeParse({
      schemaVersion: '1.0.0',
      name: 'speech_end_to_first_audio',
      unit: 'ms',
      value: Number.POSITIVE_INFINITY,
    }).success).toBe(false);
  });

  it('normalizes historical duration rows without inventing correlation', () => {
    expect(normalizeStoredMetric({ name: 'speech_end_to_first_audio', ms: 420 })).toMatchObject({
      name: 'speech_end_to_first_audio',
      unit: 'ms',
      value: 420,
      legacy: true,
    });
  });
});
```

- [ ] **Step 2: Run the shared test and verify failure**

Run: `npx vitest run shared/sessionTelemetry.test.ts`

Expected: FAIL because `shared/sessionTelemetry.ts` does not exist.

- [ ] **Step 3: Implement the typed contract**

Implement:

```ts
export const TELEMETRY_SCHEMA_VERSION = '1.0.0' as const;

export type MetricContext = {
  connectionEpoch: number;
  turnId: string;
  generationId: string;
  providerResponseId?: string;
};

export function attachMetricContext(
  input: MetricInput,
  context: MetricContext,
): MetricObservation {
  return MetricObservationSchema.parse({ ...input, ...context });
}
```

Use a Zod discriminated union with exactly these names and dimensions:

- duration: `speech_end_to_response_started`, `speech_end_to_first_audio`, `ask_to_first_audio`, `board_reveal_to_narration`, `tutor_audio_output_duration`;
- gate: `barge_in_gate_outcome` with `local_only_rejected | provider_only_rejected | confirmed`;
- cancellation: `barge_in_cancel_outcome` with `provider_cancelled | provider_completed | provider_failed`;
- navigation: `section_navigation` with bounded previous/next semantic IDs and `initial_anchor | notice_open | picker | draft_restore`;
- reconnect: `session_reconnect`;
- disappearance: `tutor_object_disappearance` with bounded `objectId` and `scene_mutation | unknown`;
- usage: `provider_usage` with non-negative integer token fields for total, input text/audio/image, cached text/audio/image, and output text/audio.

All lifecycle observations use `unit: 'count'` and `value: 1`. Provider usage uses `unit: 'count'` and `value` equal to total tokens. Only board timing permits a negative duration.

`normalizeStoredMetric` must:

- return validated new observations unchanged;
- translate only the historical names `speech_end_to_response_started`, `speech_end_to_first_audio`, and `ask_to_first_audio` from `{ name, ms }`;
- reject all malformed or unknown payloads;
- mark historical normalized entries with `legacy: true` and omit generation correlation.

- [ ] **Step 4: Run the shared test and verify pass**

Run: `npx vitest run shared/sessionTelemetry.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing session-log projection tests**

Create fixtures with ordered released metric events and assert:

```ts
const log = buildSessionTelemetryLog('session-1', events, 5_000);

expect(log.summary.durations.board_reveal_to_narration).toEqual({
  count: 2,
  min: -900,
  max: 120,
  mean: -390,
  latest: 120,
});
expect(log.summary.bargeIn).toEqual({
  localOnlyRejected: 1,
  providerOnlyRejected: 1,
  confirmed: 2,
  providerCancelled: 1,
  providerCompleted: 0,
  providerFailed: 0,
  unresolved: 1,
});
expect(log.summary.sectionSwitchCount).toBe(1);
expect(log.summary.reconnectCount).toBe(2);
expect(log.summary.tutorObjectDisappearanceCount).toBe(1);
expect(log.timeline.map((entry) => entry.eventId)).toEqual([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
]);
```

Also assert that:

- `initial_anchor` does not increment section switches;
- a cancellation outcome resolves only the matching `providerResponseId`;
- malformed metrics are excluded;
- unreleased events passed accidentally are excluded;
- `truncated` is true when the input contains the full requested limit;
- no payload text outside the typed dimensions reaches the result.

- [ ] **Step 6: Run the projection test and verify failure**

Run: `npx vitest run server/session/sessionLog.test.ts`

Expected: FAIL because `server/session/sessionLog.ts` does not exist.

- [ ] **Step 7: Implement the pure projection**

Implement:

```ts
export function buildSessionTelemetryLog(
  sessionId: string,
  events: EventRow[],
  limit: number,
): SessionTelemetryLog
```

Filter `released === true && type === 'metric'`, normalize each payload, preserve chronological event order, aggregate durations, sum lifecycle counts, sum provider usage categories, and derive unresolved confirmed barge-ins by response ID. Use integer means rounded to the nearest millisecond. Set `truncated` when `events.length >= limit`.

- [ ] **Step 8: Run focused tests**

Run: `npx vitest run shared/sessionTelemetry.test.ts server/session/sessionLog.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the contract milestone**

```bash
git add shared/sessionTelemetry.ts shared/sessionTelemetry.test.ts server/session/sessionLog.ts server/session/sessionLog.test.ts
git commit -m "$(cat <<'EOF'
feat: define typed session telemetry
EOF
)"
```

---

### Task 2: Validated repository recording and realtime provider facts

**Files:**
- Create: `server/session/telemetryRecorder.ts`
- Create: `server/session/telemetryRecorder.test.ts`
- Modify: `server/realtime/proxy.ts`
- Modify: `server/realtime/proxy.test.ts`

**Interfaces:**
- Consumes: `MetricInput`, `MetricContext`, `DomainRepository`
- Produces:
  - `recordMetric(repo, sessionId, input, context): Promise<number | null>`
  - `metricContextFromIdentity(identity, providerResponseId?)`
  - proxy persistence for client metrics, reconnects, barge-in outcomes, provider usage, and output duration

- [ ] **Step 1: Write failing recorder tests**

Assert that `recordMetric`:

```ts
const id = await recordMetric(repo, session.id, {
  schemaVersion: '1.0.0',
  name: 'session_reconnect',
  unit: 'count',
  value: 1,
}, {
  connectionEpoch: 2,
  turnId: 'turn-0',
  generationId: 'generation-0',
});

expect(id).toEqual(expect.any(Number));
expect(repo.listEvents(session.id)).toEqual([
  expect.objectContaining({
    type: 'metric',
    released: true,
    payload: expect.objectContaining({ name: 'session_reconnect', connectionEpoch: 2 }),
  }),
]);
```

Also assert invalid input returns `null` and creates no event.

- [ ] **Step 2: Run the recorder test and verify failure**

Run: `npx vitest run server/session/telemetryRecorder.test.ts`

Expected: FAIL because the recorder does not exist.

- [ ] **Step 3: Implement the recorder**

Validate the input, attach server-owned context, and call
`repo.addEvent(sessionId, 'metric', observation)`. Do not export repository
internals or accept a client-provided session ID.

- [ ] **Step 4: Run the recorder test and verify pass**

Run: `npx vitest run server/session/telemetryRecorder.test.ts`

Expected: PASS.

- [ ] **Step 5: Add failing proxy tests for client identity authority**

Send a runtime envelope containing a valid metric payload plus spoofed identity fields inside the payload. Assert the stored observation uses the envelope's `connectionEpoch`, `turnId`, and `generationId`, not the payload fields. Send an unknown metric and assert no event is stored.

- [ ] **Step 6: Add failing proxy tests for reconnect and barge-in lifecycle**

Cover:

1. first `start` records no reconnect;
2. a second proxy connection with a higher connection epoch records exactly one `session_reconnect`, even before any transcript exists;
3. `interrupt { reason: 'voice' }` records `barge_in_gate_outcome: confirmed` against the active provider response;
4. matching `response.done` statuses record `provider_cancelled`, `provider_completed`, or `provider_failed`;
5. non-voice interruption records no voice gate outcome.

- [ ] **Step 7: Add a failing provider-usage test**

Emit:

```ts
upstream.emit({
  type: 'response.done',
  response: {
    id: 'response-usage',
    status: 'completed',
    output: [],
    usage: {
      total_tokens: 253,
      input_tokens: 132,
      output_tokens: 121,
      input_token_details: {
        text_tokens: 119,
        audio_tokens: 13,
        image_tokens: 0,
        cached_tokens: 64,
        cached_tokens_details: { text_tokens: 64, audio_tokens: 0, image_tokens: 0 },
      },
      output_token_details: { text_tokens: 30, audio_tokens: 91 },
    },
  },
});
```

Assert one `provider_usage` metric with bounded numeric dimensions and one
`tutor_audio_output_duration` duration derived from the existing segment sample
total. Assert no response text or audio bytes are persisted in either metric.

- [ ] **Step 8: Run proxy tests and verify failure**

Run: `npx vitest run server/realtime/proxy.test.ts`

Expected: FAIL on the new telemetry assertions.

- [ ] **Step 9: Integrate the recorder into the proxy**

Change the internal client handler to receive the validated runtime envelope:

```ts
async function handleClient(
  message: ClientMessage,
  envelope: RuntimeEventEnvelope,
): Promise<void>
```

Use envelope identity for client metrics. Keep all existing client-event
ordering and deduplication unchanged.

At `start`, inspect released `session_started` history before appending the new
row, store the accepted `connectionEpoch` in `session_started`, and record a
reconnect only when a prior start exists.

At voice interrupt, capture the active response ID before sending
`response.cancel`. At matching `response.done`, record the terminal
cancellation outcome and clear only that correlation.

Parse provider usage with a private Zod schema or bounded numeric reader in the
recorder module. Missing fields produce no fabricated zeros. Record output
duration before flushing the response segment.

- [ ] **Step 10: Run focused server tests**

Run:

```bash
npx vitest run server/session/telemetryRecorder.test.ts server/realtime/proxy.test.ts server/realtime/proxySession.integration.test.ts
```

Expected: PASS with existing response ownership, turn, and replay tests unchanged.

- [ ] **Step 11: Commit the server milestone**

```bash
git add server/session/telemetryRecorder.ts server/session/telemetryRecorder.test.ts server/realtime/proxy.ts server/realtime/proxy.test.ts
git commit -m "$(cat <<'EOF'
feat: record realtime session telemetry
EOF
)"
```

---

### Task 3: Voice-gate outcomes and browser timing correlation

**Files:**
- Create: `src/lesson/sessionTelemetry.ts`
- Create: `src/lesson/sessionTelemetry.test.ts`
- Modify: `src/lesson/voiceInterruption.ts`
- Modify: `src/lesson/voiceInterruption.test.ts`
- Modify: `src/lesson/audioOut.ts`
- Create: `src/lesson/audioOut.test.ts`
- Modify: `src/lesson/realtimeSession.ts`
- Modify: `src/lesson/realtimeSession.test.ts`
- Modify: `server/realtime/proxy.ts`
- Modify: `server/realtime/proxy.test.ts`

**Interfaces:**
- Produces:
  - `VoiceGateDecision { shouldInterrupt: boolean; rejectedOutcome?: 'local_only_rejected' | 'provider_only_rejected' }`
  - `AudioAppendReceipt { playbackStartsInMs: number }`
  - `ResponseTimingTracker.noteNarrationScheduled(responseId, boundaryMs)`
  - `ResponseTimingTracker.noteBoardReveal(responseId, revealMs, correlation)`
  - `RealtimeSession.noteBoardReveal(identity, cue)`
- Produces a trusted response correlation only when the client envelope's
  `providerResponseId` maps to the same accepted generation on the server.
- Consumes: typed `MetricInput`

- [ ] **Step 1: Write failing voice-gate outcome tests**

Retain all current interruption assertions and add:

```ts
expect(gate.endServerSpeech()).toEqual({
  shouldInterrupt: false,
  rejectedOutcome: 'provider_only_rejected',
});
```

Drive seven local hot frames without provider confirmation, then a cool frame
after the existing `MAX_HOT_GAP_MS`; assert one
`local_only_rejected`. Drive both confirmations and assert
`shouldInterrupt: true` with no rejected outcome.

- [ ] **Step 2: Run gate tests and verify failure**

Run: `npx vitest run src/lesson/voiceInterruption.test.ts`

Expected: FAIL because methods still return booleans/void.

- [ ] **Step 3: Refactor gate return values without changing decisions**

Return structured decisions from `observeEnergy`, `confirmServerSpeech`, and
`endServerSpeech`. Emit a rejected outcome only at an existing state-clearing
transition. Do not change constants, thresholds, windows, or call frequency.

- [ ] **Step 4: Run gate tests and verify pass**

Run: `npx vitest run src/lesson/voiceInterruption.test.ts`

Expected: PASS, including every pre-existing noise and dual-confirmation row.

- [ ] **Step 5: Write failing AudioOut scheduling test**

Mock the audio context at `currentTime = 4`. Append a first chunk and assert the
returned receipt exposes the existing 50 ms schedule lead:

```ts
expect(audio.append('response-1', 'item-1', pcm)).toEqual({
  playbackStartsInMs: 50,
});
```

Append another chunk to the same response and assert the receipt is `null`,
because narration start is recorded once.

- [ ] **Step 6: Implement the append receipt**

Return `AudioAppendReceipt | null` from `append`. Compute
`Math.max(0, Math.round((at - ctx.currentTime) * 1000))` for a newly created
response timeline. Do not alter scheduling, gain, decoding, source lifecycle,
or the PCM clock.

- [ ] **Step 7: Run AudioOut tests**

Run: `npx vitest run src/lesson/audioOut.test.ts`

Expected: PASS.

- [ ] **Step 8: Write failing response-timing tracker tests**

Assert:

```ts
tracker.noteNarrationScheduled('response-1', 1_000);
expect(tracker.noteBoardReveal('response-1', 1_820, {
  visualCueId: 'cue-1',
  semanticObjectId: 'anchor-1',
})).toMatchObject({
  name: 'board_reveal_to_narration',
  value: -820,
});
```

Also cover reveal before narration, duplicate reveal IDs, missing narration,
and `resetGeneration`.

- [ ] **Step 9: Implement `ResponseTimingTracker`**

Store only monotonic numeric boundaries keyed by response ID and seen visual
cue IDs. Return a typed metric input or `null`. Bound maps to the latest 64
responses/cues to match existing session caches.

- [ ] **Step 10: Run timing tests**

Run: `npx vitest run src/lesson/sessionTelemetry.test.ts`

Expected: PASS.

- [ ] **Step 11: Write failing RealtimeSession emission tests**

Capture outbound envelopes and assert:

- existing speech and ask metrics use the new schema;
- metric identity is carried only by the runtime envelope;
- a valid provider response ID is carried in the envelope for correlated board
  timing, while a forged or generation-mismatched ID is not persisted;
- local/provider-only gate outcomes emit typed metrics;
- confirmed gate still sends one `interrupt` and advances generation once;
- first audio registers the scheduled narration boundary;
- `noteBoardReveal` emits a signed correlated metric only for the current identity.

- [ ] **Step 12: Integrate typed browser telemetry**

Add one private method:

```ts
private emitMetric(
  input: MetricInput,
  identity = this.scope.identity,
  providerResponseId?: string,
): void {
  this.sendUsingIdentity(identity, 'metric', input, { providerResponseId });
}
```

Replace raw metric sends with schema-built inputs. Adapt gate call sites to the
new structured decisions. Feed first-chunk receipts to
`ResponseTimingTracker`. Extend `VisualCueMetadata` with `responseId` and add:

```ts
noteBoardReveal(identity: GenerationIdentity, cue: VisualCueMetadata): void
```

Extend `sendUsingIdentity` with an optional fourth argument containing only
runtime-envelope correlation fields; keep all existing callers unchanged.
`noteBoardReveal` must ignore stale identity and missing response ID, and pass
the response ID as envelope correlation rather than duplicating it in the
metric payload.

- [ ] **Step 13: Validate provider-response correlation on the server**

Write the failing proxy tests first. For an allowed client metric, accept
`envelope.providerResponseId` only when `responseIdentities` maps that response
to the same connection epoch, turn, and generation as the envelope. Persist
that trusted ID through `metricContextFromIdentity`; omit forged, unknown, or
generation-mismatched response IDs. This validation must not broaden the
client metric-name allowlist from Task 2.

- [ ] **Step 14: Run lesson and proxy unit tests**

Run:

```bash
npx vitest run src/lesson/voiceInterruption.test.ts src/lesson/audioOut.test.ts src/lesson/sessionTelemetry.test.ts src/lesson/realtimeSession.test.ts server/realtime/proxy.test.ts
```

Expected: PASS with unchanged draft, cue-release, and interruption assertions.

- [ ] **Step 15: Commit the client timing milestone**

```bash
git add src/lesson/sessionTelemetry.ts src/lesson/sessionTelemetry.test.ts src/lesson/voiceInterruption.ts src/lesson/voiceInterruption.test.ts src/lesson/audioOut.ts src/lesson/audioOut.test.ts src/lesson/realtimeSession.ts src/lesson/realtimeSession.test.ts server/realtime/proxy.ts server/realtime/proxy.test.ts
git commit -m "$(cat <<'EOF'
feat: observe voice and reveal timing
EOF
)"
```

---

### Task 4: Explicit navigation and tutor-object disappearance observer

**Files:**
- Create: `src/board/renderedObjectTracker.ts`
- Create: `src/board/renderedObjectTracker.test.ts`
- Modify: `src/lesson/LessonPage.tsx`
- Create: `src/lesson/LessonPage.test.tsx`
- Modify: `src/lesson/realtimeSession.ts`
- Modify: `src/lesson/realtimeSession.test.ts`

**Interfaces:**
- Produces:
  - `AnnouncedBoardNavigation`
  - `RenderedTutorObjectTracker.observe(snapshot)`
  - `RealtimeSession.recordSectionNavigation(...)`
  - `RealtimeSession.recordTutorObjectDisappearance(...)`
- Consumes: `SceneItem.owner`, active semantic group ID, typed metric inputs

- [ ] **Step 1: Write failing pure tracker tests**

Use snapshots containing both the currently rendered tutor IDs and all tutor
IDs in the logical scene. Cover:

```ts
expect(tracker.observe({
  visibleTutorIds: ['a', 'b'],
  allTutorIds: ['a', 'b'],
})).toEqual([]);

expect(tracker.observe({
  visibleTutorIds: ['b'],
  allTutorIds: ['b'],
})).toEqual([{ objectId: 'a', cause: 'scene_mutation' }]);
```

Also assert:

- additive updates emit nothing;
- an announced section navigation suppresses IDs that remain in the full scene;
- a real full-scene removal still emits during the same navigation render;
- an announced atomic group replacement suppresses only the tutor IDs retired
  by that replacement;
- an unannounced visibility-filter removal emits `unknown`;
- `reset` prevents teardown/reinitialization events.

- [ ] **Step 2: Run tracker tests and verify failure**

Run: `npx vitest run src/board/renderedObjectTracker.test.ts`

Expected: FAIL because the tracker does not exist.

- [ ] **Step 3: Implement the pure tracker**

Use sets and explicit input only. Do not inspect the DOM, install a
`MutationObserver`, use a timer, or mutate scene state.

- [ ] **Step 4: Run tracker tests**

Run: `npx vitest run src/board/renderedObjectTracker.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing LessonPage integration tests**

Using the existing component harness:

- create the initial anchor and assert one `initial_anchor` navigation metric;
- open a notice with cause `notice_open` and assert one section switch;
- change the picker with cause `picker`;
- restore a draft with cause `draft_restore`;
- prove a draft-restore metric queued while the socket is connecting is sent
  after `ready`;
- assert navigation does not emit disappearance for tutor IDs still present in
  the full scene;
- apply an atomic group replacement and assert retired tutor IDs do not emit
  disappearance;
- apply a scene mutation that removes a previously rendered tutor ID and assert
  one disappearance metric;
- unmount and assert no disappearance.

Do not add or update screenshots.

- [ ] **Step 6: Add public typed session recorders**

Implement:

```ts
recordSectionNavigation(input: {
  previousGroupId: string | null;
  nextGroupId: string;
  cause: NavigationCause;
}): void

recordTutorObjectDisappearance(input: {
  objectId: string;
  cause: 'scene_mutation' | 'unknown';
}): void
```

Each method validates through `MetricInputSchema` before sending.
Keep a bounded queue for validated, uncorrelated client metrics emitted while
the socket is connecting and flush it with the current accepted identity after
`ready`. Do not queue response-correlated metrics across a connection boundary.

- [ ] **Step 7: Integrate exact navigation correlation in LessonPage**

Replace `openSection(groupId)` with `openSection(groupId, cause)`. Before the
state change, store one `AnnouncedBoardNavigation` in a ref and emit one
navigation observation. Pass explicit causes from:

- first anchor registration;
- section notice button;
- picker change;
- draft restoration.

After render, feed the tracker:

```ts
tracker.observe({
  visibleTutorIds: visibleScene.items.filter((item) => item.owner === 'tutor').map((item) => item.id),
  allTutorIds: scene.items.filter((item) => item.owner === 'tutor').map((item) => item.id),
  navigation: pendingNavigationRef.current,
  intentionallyRetiredTutorIds: pendingReplacementIdsRef.current,
});
```

Observe the committed React state directly; do not add timer or microtask
coalescing whose browser semantics differ from the test harness. Consume the
pending navigation and exact replacement-ID set once. Reset the tracker on
session change/unmount.

In `applyTutorOps`, include `responseId` in cue metadata and call
`session.noteBoardReveal(identity, cue)` immediately after `await nextPaint()`,
before waiting for animation completion. When `cue.replacesGroup` is present,
announce only the tutor IDs currently owned by that group as intentionally
retired before committing the atomic replacement; other removals in the same
render remain observable.

- [ ] **Step 8: Run focused UI and board tests**

Run:

```bash
npx vitest run src/board/renderedObjectTracker.test.ts src/lesson/LessonPage.test.tsx src/lesson/realtimeSession.test.ts
```

Expected: PASS.

- [ ] **Step 9: Run the unchanged interaction E2E**

Run: `npx playwright test tests/e2e/interaction-lifecycle.spec.ts`

Expected: all existing rows PASS, including section announcement, draft Done,
and tutor-object permanence.

- [ ] **Step 10: Commit the board observer milestone**

```bash
git add src/board/renderedObjectTracker.ts src/board/renderedObjectTracker.test.ts src/lesson/LessonPage.tsx src/lesson/LessonPage.test.tsx src/lesson/realtimeSession.ts src/lesson/realtimeSession.test.ts
git commit -m "$(cat <<'EOF'
feat: observe board permanence
EOF
)"
```

---

### Task 5: Parent-scoped session log API

**Files:**
- Modify: `server/api.ts`
- Modify: `server/api.auth.test.ts`

**Interfaces:**
- Consumes: `buildSessionTelemetryLog`, `repo.getSessionForParent`, `repo.listEvents`
- Produces: `GET /api/sessions/:id/log`

- [ ] **Step 1: Write failing API authorization and response tests**

Create metrics for parent A's session, then assert:

```ts
const response = await request(app)
  .get(`/api/sessions/${sessionA.id}/log`)
  .set('x-test-parent', 'parent-a');

expect(response.status).toBe(200);
expect(response.body).toMatchObject({
  schemaVersion: '1.0.0',
  sessionId: sessionA.id,
  summary: {
    reconnectCount: 1,
    tutorObjectDisappearanceCount: 0,
  },
});
expect(JSON.stringify(response.body)).not.toContain('Synthetic A');
```

Assert no parent returns `401` and parent B receives `404`.

- [ ] **Step 2: Run API test and verify failure**

Run: `npx vitest run server/api.auth.test.ts`

Expected: FAIL with `404` for the missing route.

- [ ] **Step 3: Implement the endpoint**

After the existing session GET route, add:

```ts
router.get('/sessions/:id/log', async (req, res) => {
  const parentId = parent(req);
  if (!parentId) {
    res.status(401).json({ error: 'Parent authentication required.' });
    return;
  }
  const session = await repo.getSessionForParent(req.params.id, parentId);
  if (!session) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const limit = 5_000;
  const events = await repo.listEvents(session.id, limit);
  res.json(buildSessionTelemetryLog(session.id, events, limit));
});
```

Do not expose `listEventsForInternalAudit`.

- [ ] **Step 4: Run API and security tests**

Run:

```bash
npx vitest run server/api.auth.test.ts server/security.test.ts server/store/repo.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the API milestone**

```bash
git add server/api.ts server/api.auth.test.ts
git commit -m "$(cat <<'EOF'
feat: expose parent-scoped session logs
EOF
)"
```

---

### Task 6: Prepare the synthetic live smoke and synchronize documentation

**Files:**
- Modify: `scripts/e2e-live.mjs`
- Create: `scripts/e2e-live.node-test.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/architecture/2026-08-23-noura-runtime-architecture.md`
- Modify: `docs/operations/testing-and-evaluation.md`
- Modify: `docs/privacy/threat-model.md`
- Create: `docs/architecture/2026-08-25-phase-0-telemetry-handoff.md`

**Interfaces:**
- Consumes: `/api/version`, `/api/sessions/:id/log`
- Produces: a prepared, not executed, configurable synthetic smoke report

- [ ] **Step 1: Refactor the smoke script without running it**

Use:

```js
const baseUrl = new URL(process.env.NOURA_BASE_URL ?? 'http://localhost:5173');
const providerReportedCostUsd = process.env.NOURA_PROVIDER_REPORTED_COST_USD
  ? Number(process.env.NOURA_PROVIDER_REPORTED_COST_USD)
  : null;
```

Navigate with `new URL('/', baseUrl)`. Capture the session ID from the lesson
URL after session creation. Before closing the authenticated browser context,
fetch `/api/version` and `/api/sessions/${sessionId}/log` with `page.evaluate`.

Print one JSON report containing:

- base URL and git SHA;
- runtime model IDs;
- session ID;
- elapsed smoke duration;
- total tutor audio output duration;
- provider token-usage totals;
- optional provider-reported currency cost;
- required Phase 0 duration/count aggregates;
- `requiresAuthorizedLiveVerification` entries for acoustic onset, target
  hardware, and any absent observations.

Require an explicit `--authorized-live-run` argument before any browser launch
or application request. `--help`, deterministic fixture reporting, and invalid
configuration remain offline and side-effect free. Configuration failures must
return the same structured failure-report shape rather than an uncaught stack.
The report may include bounded counts of caption lines and browser errors, but
must never retain raw tutor/learner caption text or raw console-error strings.

If the WAV scenario is selected, set a nonzero exit code when speech response
metrics or provider usage are absent. In text-only mode, do not require
speech-end metrics. Never query SQLite directly after browser close.

Do not execute this script in Phase 0.
Add `test:smoke-report` and `e2e:live` package scripts. The live command must
still require callers to pass `--authorized-live-run`; the package script must
not silently opt in for them.

- [ ] **Step 2: Update README**

Document:

- released `metric` events as the telemetry source;
- the parent-scoped log endpoint;
- exact offline meaning of first audio and signed reveal/narration gap;
- that no live latency claim has been made;
- the prepared smoke command using `NOURA_BASE_URL`;
- the explicit `--authorized-live-run` guard and offline reporter test command;
- the authorization boundary.

- [ ] **Step 3: Update runtime architecture and privacy docs**

Runtime architecture must show browser observers → runtime envelope → server
validation → released metric event → session log projection.

Privacy must list allowed telemetry fields and explicitly prohibit transcript,
name, image, raw audio, pointer, token, and credential content.

- [ ] **Step 4: Update the testing runbook**

Replace "provider-reported cost" ambiguity with:

- provider-reported token usage from `response.done`;
- optional currency amount manually reconciled from the provider billing
  surface;
- any local rate-card calculation labelled as an estimate with source date.

Add the prepared command, expected report fields, and an explicit "do not run
without authorization" warning. Document that a truncated log or missing
provider usage fails the smoke gate and that retained reports contain counts,
not transcript/console text.

- [ ] **Step 5: Write the Phase 0 handoff**

Use exactly three sections:

1. `Proven offline`
2. `Requires authorized live verification`
3. `Deferred`

Record commits, test evidence, unchanged snapshots, no provider calls, no
deployment, and no push. Defer Phase 1 transport changes and any true semantic
false-barge-in rate requiring labeled/live ground truth.

- [ ] **Step 6: Run static gates for docs/script integration**

Run:

```bash
npm run build
npm run typecheck:server
npm run lint
npm run test:brand
npm run test:smoke-report
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit the documentation/smoke milestone**

```bash
git add scripts/e2e-live.mjs scripts/e2e-live.node-test.mjs package.json README.md docs/architecture/2026-08-23-noura-runtime-architecture.md docs/operations/testing-and-evaluation.md docs/privacy/threat-model.md docs/architecture/2026-08-25-phase-0-telemetry-handoff.md
git commit -m "$(cat <<'EOF'
docs: prepare phase zero telemetry smoke
EOF
)"
```

---

### Task 7: Full Phase 0 verification and stop boundary

**Files:**
- Verify all modified files
- Update only `docs/architecture/2026-08-25-phase-0-telemetry-handoff.md` if final evidence differs

**Interfaces:**
- Produces: complete offline acceptance evidence and an explicit live authorization request

- [ ] **Step 1: Run build, server typecheck, and lint**

Run:

```bash
npm run build
npm run typecheck:server
npm run lint
```

Expected: all PASS.

- [ ] **Step 2: Run all unit and policy suites**

Run:

```bash
npm test
npm run test:smoke-report
npm audit --omit=dev
npm run test:integration
npm run test:security
npm run test:storage
npm run test:brand
npm run test:runtime-models
```

Expected: all PASS.

- [ ] **Step 3: Run browser suites sequentially**

Run:

```bash
npm run test:e2e
npm run test:visual
npm run test:a11y
```

Expected:

- all E2E rows PASS;
- all 48 existing visual baselines PASS without updates;
- all accessibility rows PASS.

- [ ] **Step 4: Verify repository scope**

Run:

```bash
git status --short
git diff d8e2258..HEAD --stat
git diff d8e2258..HEAD -- scripts/e2e-live.mjs README.md docs server shared src
```

Confirm:

- only Phase 0 files changed;
- the three pre-existing untracked architecture documents remain untracked and unchanged;
- no provider/model identifier changed;
- no `response.create`, VAD ownership, draft, or permanence behavior changed;
- no visual snapshot file changed;
- no dead code, `any`, unused export, or commented-out implementation remains.

- [ ] **Step 5: Reconcile the handoff with actual evidence**

If counts or commands differ from the draft handoff, update it with exact
observed results. Do not claim deployed latency, acoustic onset, target-device
behavior, provider billing, or semantic false-barge-in accuracy.

- [ ] **Step 6: Commit final evidence only if the handoff changed**

```bash
git add docs/architecture/2026-08-25-phase-0-telemetry-handoff.md
git commit -m "$(cat <<'EOF'
docs: record phase zero verification
EOF
)"
```

Skip the commit when the handoff already matches the final evidence.

- [ ] **Step 7: Stop and request authorization**

Report:

- what is proven offline;
- what remains unverified live;
- commit hashes;
- that nothing was pushed or deployed and no paid call ran.

Request explicit authorization for deployment and at most two short synthetic
live sessions. Do not begin Phase 1.
