# Noura threat model and privacy data flow

Status: engineering controls implemented for local, access-gated and public-v0 synthetic use; real-user Production owner/legal/account gates remain open.

## Data flow

- Parent enters learner name, age and lesson goal into the same-origin application.
- Server creates parent-scoped child/session objects and a short-lived signed lesson capability.
- Browser sends live PCM to Noura’s same-origin WebSocket; the server proxies it to the configured Realtime provider. The key never enters the client.
- Provider transcript/audio/tool events return through the proxy with generation identity.
- Noura stores provider-independent transcript events, committed semantic scenes and evidence. Raw audio is not stored.
- Parent summaries receive the immutable event cutoff and evidence IDs. Unsupported claims fall back deterministically.
- Pointer/touch/focus events stay in the active browser interaction path. Committed learner board marks are stored as bounded learner-owned path BoardOps so they can replay; transient pointer movement is not stored. A compressed board image may be sent to the configured AI provider after a committed learner change, but Noura does not persist that image. Coarse camera input is not implemented.

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
| Ephemeral deployed data | Preview health remains degraded; public v0 requires the managed Postgres domain adapter and fails closed without it | Deployed persistence and instance-replacement smoke evidence remain required before the custom domain is attached. |
| Database transport interception | Public v0 uses encrypted Supavisor transport and a least-privilege private-schema role | Node does not trust the pooler's chain by default; CA/hostname verification remains a full-Production gate. |
| Under-13 processing without ZDR | Under-13 Production mode requires an external evidence reference and other gates | ZDR status is unverified; no compliance claim. |

Never log full child messages, transcripts, names, auth/capability tokens, raw pointer trails, camera data, provider keys, Vercel tokens or database URLs.

## Retention and deletion

No approved Production retention period exists. Real personal data remains blocked. Before Production, the owner must approve retention durations, deletion/export response procedure, provider retention settings, report/escalation ownership and legal disclosures. Deletion services must be exercised against the selected durable adapter.

## Camera boundary

Camera-responsive behavior was intentionally omitted. Noura performs no camera upload/storage, face recognition, identity matching, landmarks, gaze estimation, emotion detection, attention/engagement scoring, behavioural diagnosis or comprehension inference.
