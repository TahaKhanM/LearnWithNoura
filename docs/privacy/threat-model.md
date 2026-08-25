# Noura threat model and privacy data flow

Status: engineering controls implemented for local, access-gated and public-v0 synthetic use; real-user Production owner/legal/account gates remain open.

## Data flow

- Parent enters learner name, age and lesson goal into the same-origin application.
- Server creates parent-scoped child/session objects and a short-lived signed lesson capability.
- Browser sends live PCM to Noura’s same-origin WebSocket; the server proxies it to the configured Realtime provider. The key never enters the client.
- Provider transcript/audio/tool events return through the proxy with generation identity.
- Noura stores provider-independent transcript events, committed semantic scenes and evidence. Raw audio is not stored.
- Parent summaries receive the immutable event cutoff and evidence IDs. Unsupported claims fall back deterministically.
- Pointer/touch/focus events stay in the active browser interaction path. Committed learner board marks are stored as bounded learner-owned path BoardOps so they can replay; transient pointer movement is not stored. Noura also stores bounded deterministic stroke features (gesture class, bounds, closure, direction, nearest/touched board object IDs and section) as calibrated spatial hints. A compressed composite of the visible section plus an enlarged learner-mark detail may be sent to the configured AI provider after a committed learner change, but Noura does not persist that image. Coarse camera input is not implemented.
- Browser and provider lifecycle observers send closed-schema metrics through
  the existing runtime envelope. The server validates identity and exact
  response correlation before pseudonymizing all telemetry identifiers and
  submitting observations to a bounded ordered writer. The parent-scoped
  `GET /api/sessions/:id/log` endpoint projects only released metric rows and
  aggregate counts; it does not expose the session’s transcript, evidence,
  board, profile records, or raw telemetry identifiers.

## Telemetry allowlist and prohibited content

The released telemetry payload and session-log projection allow only these field classes:

- event metadata: session ID in the parent-scoped response, event ID, server timestamp, telemetry schema version, and the bounded/truncated marker;
- closed metric identity: the enumerated metric name, `ms` or `count` unit, and a finite integer value;
- server-authoritative correlation: non-negative connection epoch plus
  deterministic field-specific session-scoped opaque tokens for turn,
  generation, and optional provider response IDs;
- historical compatibility: the literal bounded `legacy: true` boolean only on normalized historical duration timeline rows;
- bounded visual correlation: optional opaque visual-cue and semantic-object
  tokens;
- closed lifecycle dimensions: enumerated barge-in gate/cancellation outcomes,
  opaque previous/next section tokens with enumerated navigation cause, and an
  opaque tutor-object token with enumerated disappearance cause;
- gap accounting: a positive aggregate count with only
  `server_queue_overflow`, `server_persistence_failure`, or
  `client_queue_overflow`;
- provider usage integers: total; input text/audio/image; cached input text/audio/image; and output text/audio token counts from `response.done.response.usage`;
- derived numeric projections: duration count/minimum/maximum/mean/latest,
  per-transition barge-in outcome counts, section-switch count, reconnect count,
  tutor-object-disappearance count, provider-usage totals, and gap totals by
  reason.

No free-form telemetry dimension or content field is allowed. Telemetry events and the session-log endpoint explicitly prohibit:

- transcript, caption, typed-message, lesson-goal, evidence observation/excerpt, or summary text;
- learner, parent, or other person names and profile content;
- image content, screenshots, board composites, image data URLs, or raw board descriptions;
- raw or encoded audio, recordings, PCM samples, microphone samples, or acoustic content;
- raw pointer, touch, focus, gaze, mouse, or learner-stroke coordinates, trails, and event content;
- authentication/session/capability token content, cookies, API/provider/Vercel/database tokens, or other bearer secrets (integer token-usage counts are allowed; token strings are not);
- credentials, keys, database URLs, billing-account identifiers, or other authorization content.

Pseudonymization occurs only after runtime trust checks. The same identifier
field correlates within one session but not across sessions. Projection repeats
the transform for historical or direct typed rows. Preparation always
transforms input, even if it imitates a token. Projection preserves a token
only when server-owned encoding metadata is valid and the token's
session-derived prefix belongs to the projected session; forged metadata and
cross-session copied tokens are transformed again.

Gap rows expose known bounded-queue and persistence loss, but they do not prove
delivery after an unrecovered browser disconnect. Final observations in a
browser connection that never reaches another `ready`, or in an unrecovered
fallback/failed transport phase, can be lost without a durable gap row. Such a
session is incomplete by construction.

## Threats and controls

| Threat | Current control | Residual |
| --- | --- | --- |
| Cross-parent object access | Parent ID column, object-scoped repository/API queries, 401/404 tests | Real external identity provider not selected. |
| Lesson ID reuse | Two-hour HMAC capability scoped to child/session, delivered via WebSocket subprotocol or fallback authorization header | Preview/Production require shared capability secret. |
| Cross-site mutation/socket | Exact Origin allowlist; no suffix matching; SameSite/HttpOnly/Secure parent-cookie adapter | Preview origin must be explicitly configured after URL creation. |
| Replay/duplicate cost | Turn/generation event identity and text idempotency keys; bounded per-key limits | Multi-instance rate store not wired. |
| Stale output after interruption | Provider-response generation map and browser event gate; GenerationScope cancellation | Target-hardware acoustic result unverified. |
| Transcript/evidence fabrication | Source event IDs, normalized span verification, cited summaries | Model classification remains probabilistic; deterministic domain checks cover selected subjects only. |
| Log disclosure | No message bodies, board images, tokens, child names, keys or database URLs in application logs | Provider/platform logs require owner review. |
| Telemetry identifier disclosure | Raw runtime/board identifiers are transformed into field-specific session-scoped opaque tokens before metric persistence; projection defends historical/direct rows | Session IDs remain parent-scoped API identifiers; pseudonymization is not anonymization. |
| Silent telemetry loss | Bounded server/client queues emit typed aggregate gap rows and the smoke gate rejects every observed gap | An unrecovered browser/fallback/failed phase can lose final observations before reporting a gap. |
| Ephemeral deployed data | Preview health remains degraded; public v0 requires the managed Postgres domain adapter and fails closed without it | Deployed persistence and instance-replacement smoke evidence remain required before the custom domain is attached. |
| Database transport interception | Public v0 uses encrypted Supavisor transport and a least-privilege private-schema role | Node does not trust the pooler's chain by default; CA/hostname verification remains a full-Production gate. |
| Under-13 processing without ZDR | Under-13 Production mode requires an external evidence reference and other gates | ZDR status is unverified; no compliance claim. |

Never log full child messages, transcripts, names, auth/capability tokens, raw pointer trails, camera data, provider keys, Vercel tokens or database URLs.

## Retention and deletion

No approved Production retention period exists. Real personal data remains blocked. Before Production, the owner must approve retention durations, deletion/export response procedure, provider retention settings, report/escalation ownership and legal disclosures. Deletion services must be exercised against the selected durable adapter.

## Camera boundary

Camera-responsive behavior was intentionally omitted. Noura performs no camera upload/storage, face recognition, identity matching, landmarks, gaze estimation, emotion detection, attention/engagement scoring, behavioural diagnosis or comprehension inference.
