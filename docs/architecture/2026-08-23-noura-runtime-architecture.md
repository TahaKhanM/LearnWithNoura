# Noura runtime architecture and decision record

Date: 2026-08-23. Status: active, with explicit Production blockers.

This ADR supersedes the historical live-tutor ADR in `docs/legacy/`. It preserves the semantic BoardOp DSL, exact compiler, safe expression parser, browser PCM clock, released-only replay, owner metadata, dry-erase identity, server-side provider key, and provider replaceability.

## Implementation-agent and runtime-model decision

GPT-5.6 Sol was used by Codex to implement this repository change. That fact is independent of Noura’s runtime. The reviewed runtime remains:

| Path | Before | After | Decision |
| --- | --- | --- | --- |
| Live speech | Realtime WebSocket, `gpt-realtime-2.1` | unchanged | No independent defect justified a provider/model/transport migration. |
| Input transcription | `gpt-4o-mini-transcribe` | unchanged | Existing Realtime configuration retained. |
| Fallback and summary | Chat Completions, `gpt-5.6-terra` | unchanged | Structured validation was added locally without endpoint migration. |
| Reasoning effort | fallback `none`, summary `low` | unchanged | No implementation-agent reinterpretation. |

Rollback: the runtime identifiers remain environment-configurable. No new OpenAI endpoint or provider dependency was introduced.

## Protocol and generation ownership

`shared/runtimeProtocol.ts` defines schema `1.0.0`. Every browser/server event carries event ID, session, connection epoch, turn, generation, monotonic sequence, type and payload; provider IDs, sample offsets, visual/semantic IDs and idempotency keys are optional typed fields.

The browser rejects malformed, duplicated, non-monotonic or stale identity. The server maps each provider response ID to the generation active when the response was created, so late provider deltas retain their old identity and are rejected after interruption.

`GenerationScope` owns its `AbortController`, provider response IDs, PCM/caption/visual/character identifiers, timers, animation frames and cleanups. Interrupt, transport replacement, reconnect, navigation and end cancel the whole scope.

## Deterministic lesson orchestration

`server/lesson/orchestrator.ts` owns legal phase transitions, owed action, turn owner, delivered task, interruption recovery and completion boundaries. `AWAIT_LEARNER` throws unless a non-empty question/task ID and text were delivered.

The model proposes a validated `TeachingMove`. It owns classification rationale, strategy, visual intent, semantic object and child-facing wording. It does not own legal waiting, cancellation, immutability or evidence projection. A response that ends without a question receives one bounded continuation; a repeated unresolved handoff becomes a deterministic safe question.

## Audio, captions and cancellation

WebSocket plus browser-owned PCM remains the selected transport. PCM sample progress is the release clock for phrase captions and visual checkpoints. Final output-transcript events replace provisional response phrases. There is no claim of provider word timestamps.

Interruption records detector-to-stop-scheduled and provider-confirmation intervals separately. Acoustic silence is not inferred from function return. Target-hardware onset-to-silence remains UNVERIFIED.

Reconnect has an eight-second connect timeout and at most two retries. Only the newest queued text ask is retained with an idempotency key. Fallback uses the same session/evidence/board concepts, is single-generation, abortable and captions-only.

## Semantic visuals and committed reveal

The preferred path is:

`Educational intent → SemanticScenePlan 1.0.0 → domain template → BoardOps → exact compiler → inspection → one repair → accept/reject → transient reveal → committed checkpoint`.

Adapters cover exact Pythagorean area rearrangement, unit-circle projection, shared-scale fraction comparison, colour-distinguished slopes, causal cycles, claim/evidence/reasoning, history cause/effect, grammar structure, tables, timelines and explicit NoBoard.

Scene inspection checks finite geometry, safe bounds, the toolbar region and destructive text-bearing collisions. Long unbroken words are split by measured width. Rejection preserves the last committed scene. Tutor clear/erase/update cannot mutate learner-owned marks. Mobile focus mode presents a readable pannable board with a full-overview toggle.

## Character attention

`CharacterAttentionController` prioritizes interruption/confirmed learner activity, learner drawing/pointer/touch/focus, tutor pen, semantic object, caption/question, then neutral learner-facing gaze. Every target carries full generation identity, priority, lifetime, smoothing and reduced-motion permission.

The avatar uses real output energy for mouth state, direct CSS-variable eye motion, bounded gaze, subtle blink/brow/head state, pointer hysteresis, and document-visibility pausing. Interruption cancels the animation scope and rolls back transient visual work. Camera behavior is omitted.

## Persistence and evidence

Local SQLite uses numbered migrations, foreign keys, latest-event pagination, immutable ended-session cutoffs and linked continuation. `noura.db` migration checkpoints and verifies the historical database, writes a verified backup, compares row counts, and retains the source.

Evidence observations include UUID, child/session, normalized concept, taxonomy, observation, confidence basis, source event IDs, exact normalized excerpt/span, task/opportunity, independence, domain result, turn/generation, contradiction/supersession and time. Summary claims cite evidence IDs; invalid IDs or invented quoted spans cause deterministic fallback.

`PostgresStore` provides a pooled, transactional, versioned export/import contract and passes an offline Postgres-compatible test. It is not yet wired into all domain services, so Production startup always fails closed.

## Vercel topology

Vite builds to static output. `api/[...path].ts` exports the Express/REST server and `api/ws.ts` exports the native Node WebSocket server. The WebSocket Function duration is 300 seconds, matching the inspected Hobby maximum. Reconnect is mandatory. No in-memory state is considered durable.

Native Vercel WebSockets are a 2026 public beta. Preview can run synthetic, ephemeral evaluation only; `/healthz` reports degraded durable storage there. Production cannot start until Postgres domain wiring, external parent identity, privacy/safety configuration and relevant account evidence pass.

## Rollback

Code rollback is safe while schema additions remain additive. Keep the previous verified deployment ID and use `vercel rollback <deployment>` or `vercel promote <previous-deployment>`. Do not roll code behind an incompatible migration. The local legacy database and backup remain available; never delete them as part of rollback.
