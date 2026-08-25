# Phase 0 telemetry hardening decision

Status: approved for the final Phase 0 fix wave on 2026-08-25.

## Context

The first Phase 0 implementation proved the observation boundaries but left
telemetry persistence on lesson-critical async paths, did not account for every
bounded-queue or persistence loss, retained correlation identifiers verbatim,
accepted weak client response correlation, and allowed the smoke reporter to
trust data shapes that were broader than its evidence claim.

Phase 0 remains observer-only. Hardening must not change response ownership,
VAD flags, cue release, cancellation, lesson state, board permanence, provider
or model selection, or transport behavior.

## Decision

### Ordered, non-blocking server writer

Server observations are prepared synchronously and submitted to one typed
`SessionTelemetryWriter` per accepted connection. The writer owns a bounded
FIFO and one asynchronous drain. Lesson and provider handlers enqueue without
awaiting repository work, so telemetry cannot delay initial `response.create`,
cue flush, `response_done`, `response.cancel`, or subsequent client/provider
messages. Repository rejection is contained inside the writer. `flush()` is an
explicit test and close boundary, not a lesson-lifecycle dependency.

The accepted `session_started` row is still part of runtime history. After that
row is appended, its event ID becomes an exclusive upper bound for an exact,
paged released-history lookup. Initial model response creation happens before
that lookup or any reconnect observation is awaited.

### Explicit completeness gaps

Loss is data, not an implementation detail. A typed `telemetry_gap` observation
uses only the bounded reasons `server_queue_overflow`,
`server_persistence_failure`, and `client_queue_overflow`, with a positive
integer value that may aggregate losses.

The server writer keeps pending totals outside its bounded FIFO. Before it
persists a later normal observation, it first persists the pending gap totals.
If a gap write fails, the total remains pending and later observations remain
behind it. Browser pre-ready eviction is aggregated and emitted on the next
accepted `ready`. Queues remain bounded.

Session-log summaries expose totals by reason. Any gap fails the smoke gate.
This makes observed completeness testable, but not absolute: a browser
connection that never reaches another `ready`, or a failed/fallback transport
phase that never recovers, can lose final browser observations without a
durable gap row. Such a run cannot prove telemetry completeness.

### Session-scoped pseudonymous identifiers

Trust checks operate on the raw runtime envelope because generation and
provider-response authority must be established before transformation. Once
accepted, every telemetry turn, generation, provider response, visual cue,
semantic object, section, and object identifier is deterministically converted
to a field-specific, session-scoped opaque token before persistence.

Projection repeats this transformation for malformed direct writes and
historical typed rows, while recognizing the versioned opaque-token format to
avoid double hashing. A given field and raw value therefore correlate
consistently within one session, but not across sessions. Raw identifiers,
names used as identifiers, transcript sentinels, and credential sentinels must
not appear in stored metric payloads, parent API logs, or smoke reports.

### Exact response trust and idempotency

`board_reveal_to_narration` is rejected unless its envelope
`providerResponseId` exists and maps to the exact accepted session,
connection, turn, and generation. Uncorrelated metric kinds retain their
existing allowlist.

Provider terminal telemetry is deduplicated per connection by provider
response ID before recording usage, tutor-audio duration, or barge-in
cancellation outcome. Both that terminal set and the pending voice-cancel
correlation set are bounded; eviction changes telemetry accounting only and
does not change provider cancellation behavior.

### Exact smoke projection

`NOURA_BASE_URL` is an HTTP(S) origin only: no userinfo, non-root path, query,
or fragment. Reports retain the normalized origin only.

The offline/live reporter validates `/api/version` and
`/api/sessions/:id/log` with exact hand-written allowlists. It constructs a new
report object field by field and never spreads endpoint, fixture, runtime
model, summary, usage, or timeline objects. It requires the navigated origin,
requested session ID, and schema version to match. Every duration aggregate
and provider-usage row is checked as safe integer data; provider totals must be
positive, row totals must be internally consistent, and summary usage must
equal the sum of validated timeline rows. Truncation, gaps, malformed data,
redirects, and mismatches fail closed.

### API and projection boundaries

The session-log route sets `Cache-Control: no-store` before authentication or
ownership work so success, denial, absence, and handled failures are all
non-cacheable.

One exported session-log event limit couples the API query and projection
truncation rule mechanically. Projection input is repository order: ascending
event ID/server chronology, limited to released rows. The projection does not
sort or infer missing history.

## Consequences

Telemetry is ordered when successfully persisted, cannot hold lesson behavior
behind repository latency, and reports known loss honestly. Identifier
correlation remains useful within a session without retaining raw runtime
identifiers. Smoke output becomes a narrow evidence artifact rather than a
copy of remotely supplied JSON.

The design does not promise delivery after an unrecovered browser disconnect,
add retries or timers, change the voice gate, broaden no-store behavior to
other parent routes, or implement Phase 1 transport/provider/model/visual work.
