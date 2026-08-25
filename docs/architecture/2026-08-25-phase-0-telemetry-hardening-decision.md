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

The server writer represents loss as ordered gap barriers in the same logical
stream as normal observations. A gap may use a small bounded reserve and may
merge only with an adjacent compatible gap; it never jumps ahead of an older
observation. A failed normal observation is replaced at that exact position by
a `server_persistence_failure` barrier. A failed gap retains its original
reason and value and blocks later telemetry until a later retry succeeds.
Browser pre-ready eviction is aggregated and emitted on the next accepted
`ready`. Queues remain bounded.

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

Prepared observations always transform input identifiers, including strings
that imitate the token shape. Stored observations carry server-owned encoding
metadata and tokens include a prefix derived from the owning session.
Projection avoids re-encoding only when both the metadata and session prefix
are valid; malformed metadata, historical rows, and tokens copied from another
session are transformed again. Input schemas strip attempted encoding
metadata. A given field and raw value therefore correlate consistently within
one session, but not across sessions. Raw identifiers, names used as
identifiers, transcript sentinels, and credential sentinels must not appear in
stored metric payloads, parent API logs, or smoke reports.

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

The reporter reconstructs every duration aggregate and lifecycle summary from
strictly ascending validated timeline rows, including unresolved barge-in
correlation, navigation, reconnect, disappearance, usage, and gap totals. It
compares count, minimum, maximum, rounded mean, and latest exactly. Required
durations must exist in the timeline itself, and all totals use checked safe
integer addition.

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

## Second-review clarification

The asynchronous contract is a real repository boundary, not only a deferred
callback. Production SQLite telemetry append and prior-start lookup execute in
a worker thread because `node:sqlite` is synchronous; Postgres keeps its native
asynchronous query boundary. Test/in-memory adapters yield before invoking a
synchronous repository. Writer scheduling also yields before storage work, but
that scheduling alone is not considered sufficient for production SQLite.

Terminal telemetry uses only the exact provider-response identity map. An
unknown `response.done` may still use the existing fallback identity for cue
flush and client finalization, but it cannot emit provider usage, tutor-output
duration, or cancellation outcome.

## Lifecycle and saturation clarification

Exact chronology for an unbounded run of loss markers is incompatible with
bounded memory. Accepted normal observations therefore remain FIFO, while
telemetry gaps are fixed-size per-reason completeness counters rather than
event-order evidence. Counters may aggregate across later observations, but
their totals remain exact. After the first loss, pending gaps are attempted
before any newly accepted normal observation. Impossible safe-integer
accounting overflow records an explicit non-complete reason that the smoke gate
rejects.

The SQLite session-end cutoff and status transition execute in one
`BEGIN IMMEDIATE` transaction. A worker append is therefore either committed
before and included in `ended_event_id`, or rejected after the end transition.
Postgres already provides the equivalent transaction plus row lock.

Reconnect-history lookup failure is itself a completeness gap and is never
silently caught. Shared telemetry lifecycle management stops new submissions,
waits a finite shutdown interval for registered writers to flush, then closes
the worker with handled errors. The bound is shutdown safety, not a lesson
timer.

## Distributed shutdown and cutoff clarification

`flush()` is a truth boundary: it succeeds only when both the normal FIFO and
all fixed gap counters are empty. A persistence attempt that cannot progress
raises typed `TELEMETRY_INCOMPLETE_FLUSH`; failed `close()` retains
registration so repository shutdown can retry. Closing stops new submissions,
and a counter added after its enum position was visited restarts the drain
until the global empty condition is true.

Server shutdown is quiescent and ordered: reject new upgrades, close active
WebSockets, await each proxy's client/upstream work and prior-start telemetry,
close its writer, then stop repository writer registration and flush registered
writers before worker closure. The two five-second bounds apply only to process
shutdown and never to lesson behavior.

Postgres event append and session end now acquire conflicting `FOR UPDATE`
locks on the same session row inside transactions. If append wins, its commit
precedes the end transaction's cutoff query; if end wins, append observes
`ended` and rejects. `pg-mem` does not model real PostgreSQL concurrent row-lock
blocking, so the deterministic test asserts transaction and query order
(`BEGIN` → session `FOR UPDATE` → insert → `COMMIT`); the immutable-end contract
test separately verifies rejection after end.
