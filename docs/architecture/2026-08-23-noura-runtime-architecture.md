# Noura runtime architecture and decision record

Date: 2026-08-23. Status: active, with a full-product public-v0 boundary and explicit real-user Production blockers.

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

WebSocket plus browser-owned PCM remains the selected transport. The proxy counts decoded PCM16 samples per provider response. Audio chunks receive exact cumulative offsets immediately. Transcript deltas and semantic visual/lesson-state cues are buffered until the response segment is sealed; ordered transcript deltas are distributed by Unicode-character weight across the complete PCM segment, while visual, pen and character semantic cues use the segment boundary. `ResponseCueTimeline` releases them from the browser's heard-sample playhead. A compositional offline harness now feeds raw upstream order permutations through the proxy and then delivers its real runtime envelopes into `RealtimeSession` under a fake heard-sample clock, including interruption and identity replacement. This conservative contract is invariant to audio/transcript/tool network interleaving, never squeezes multiple early deltas into the first tiny audio chunk, and makes no claim of provider word timestamps. Final transcript correction remains held until the complete segment is heard.

Interruption records detector-to-stop-scheduled and provider-confirmation intervals separately. Acoustic silence is not inferred from function return. Target-hardware onset-to-silence remains UNVERIFIED.

Incidental-sound hardening keeps provider VAD from cancelling responses autonomously. A browser `VoiceInterruptionGate` requires roughly 280 ms of sustained energy above an adaptive room-noise floor and a recent independent provider `speech_started` event before local audio, visual and generation cancellation run. Server VAD alone, local energy alone and short acoustic spikes are insufficient; typed questions and deliberate board interaction retain their explicit interruption paths.

Reconnect has an eight-second connect timeout and at most two retries. Only the newest queued text ask is retained with an idempotency key. Captions-only fallback uses the same versioned event envelope, deterministic wait guard, semantic visual adapter/checkpoints and evidence schema as Realtime. `FallbackTurnCoordinator` keeps one process-local provider controller per session while a durable `fallback_turns` claim enforces one active generation and idempotency across requests. Provider calls receive a composed request/supersession/timeout signal. Every fallback mutation revalidates active session, connection epoch, turn, generation and idempotency and is staged unreleased. Completing the turn atomically promotes committed events and evidence; semantic checkpoints additionally require the browser's animation acknowledgement. Failed, cancelled and superseded staging rows remain permanently excluded. Application APIs, replay, context, summaries and Parent surfaces expose released/committed rows only; explicitly named internal-audit reads are the sole diagnostic exception. Completed duplicate keys replay stored envelopes without new rows.

## Semantic visuals and committed reveal

The preferred path is:

`Educational intent → SemanticScenePlan 1.0.0 → domain template → BoardOps → exact compiler → inspection → one repair → accept/reject → transient reveal → committed checkpoint`.

Adapters cover exact Pythagorean area rearrangement, unit-circle projection, shared-scale fraction comparison, colour-distinguished slopes, causal cycles, claim/evidence/reasoning, history cause/effect, grammar structure, tables, timelines and explicit NoBoard.

Scene inspection checks finite geometry, safe bounds, the toolbar region and destructive text-bearing collisions. Long unbroken words are split by measured width. Rejection preserves the last committed scene. Tutor clear/erase/update cannot mutate learner-owned marks. `revealOrder` is compiled into ordered, individually persisted checkpoints; only a completed animation is acknowledged and replayable. Visual cue and semantic object IDs stay on the runtime envelope. Mobile and short-landscape focus prioritizes newly highlighted items and key equations, comparison marks, points/projections, plots or labelled boxes. It creates enough labelled previous/next views to fully contain every required text/equation node, suppresses partially clipped neighbouring text, keeps active educational text at least 16 px at the tested sizes, and preserves group selection plus full-board overview. The earlier fixed 720 px scroll canvas is removed.

## Character attention

`CharacterAttentionController` prioritizes interruption/confirmed learner activity, learner drawing/pointer/touch/focus, tutor pen, semantic object, caption/question, then neutral learner-facing gaze. Every target carries full generation identity, priority, lifetime, smoothing and reduced-motion permission.

The avatar uses real output energy for mouth state, direct CSS-variable eye motion, bounded gaze, subtle blink/brow/head state, pointer hysteresis, and document-visibility pausing. Interruption cancels the animation scope and rolls back transient visual work. Camera behavior is omitted.

## Persistence and evidence

Local SQLite uses numbered migrations, foreign keys, latest-event pagination, immutable ended-session cutoffs and linked continuation. `noura.db` migration checkpoints and verifies the historical database, writes a verified backup, compares row counts, and retains the source.

Evidence observations include UUID, child/session, normalized concept, taxonomy, observation, confidence basis, source event IDs, exact normalized excerpt/span, task/opportunity kind, retrieval lineage, independence, domain result, turn/generation, contradiction/supersession and time. `projectConceptHistories` is the single status projection used by summary validation, deterministic summary fallback and Parent concept history. One opportunity is identified by session, task and turn, so duplicate classifications of one answer count once. “Demonstrated” requires distinct independent positive opportunities, explanation/application, and a chronologically later retrieval whose `retrievalOf` names the earlier task. Latest negative or unresolved contradiction/misconception remains uncertain. Explicit correction resolves a misconception but is not confirmation; fresh independent application/explanation plus tied later retrieval is required afterward. Self-correction remains reduced-independence. Summary claims cite evidence IDs and carry a calibrated `progressing|demonstrated` label; invalid IDs, projection overclaims or invented quoted spans cause deterministic fallback.

The repository contract now has two implementations: synchronous SQLite for local work and asynchronous managed Postgres for deployed REST, Realtime, fallback, evidence and summary paths. Postgres uses a private `noura` schema, transactional fallback claims, staged reveal, immutable ending and the same evidence lineage projection. The portable export/import path targets that same schema. Public v0 uses a signed pseudonymous guest-parent scope; full Production still requires an external identity provider and the remaining privacy/safety gates.

## Vercel topology

Vite builds to static output. `api/[...path].ts` exports the Express/REST server and `api/ws.ts` exports the native Node WebSocket server. The WebSocket Function duration is 300 seconds, matching the inspected Hobby maximum. Reconnect is mandatory. No in-memory state is considered durable.

Native Vercel WebSockets are a 2026 public beta. Preview can run synthetic, ephemeral evaluation only; `/healthz` reports degraded durable storage there. `production-v0` may start only with the provider, managed Postgres adapter and lesson signing configured, and remains synthetic-only with guest identity. Full `production` additionally requires external parent identity, privacy/safety configuration and relevant account evidence.

## Rollback

Code rollback is safe while schema additions remain additive. Keep the previous verified deployment ID and use `vercel rollback <deployment>` or `vercel promote <previous-deployment>`. Do not roll code behind an incompatible migration. The local legacy database and backup remain available; never delete them as part of rollback.
