# Noura runtime architecture and decision record

Date: 2026-08-23; updated 2026-08-26 for the Phase 1 voice-transport overhaul. Status: active, with a full-product public-v0 boundary and explicit real-user Production blockers.

This ADR supersedes the historical live-tutor ADR in `docs/legacy/`. It preserves the semantic BoardOp DSL, exact compiler, safe expression parser, released-only replay, owner metadata, dry-erase identity, server-side provider key, and provider replaceability. Phase 1 replaced the browser PCM clock with provider playback boundaries; see “Voice transport: WebRTC media plane plus server sideband”.

## Implementation-agent and runtime-model decision

GPT-5.6 Sol was used by Codex to implement this repository change. That fact is independent of Noura’s runtime. The reviewed runtime remains:

| Path | Before | After | Decision |
| --- | --- | --- | --- |
| Live speech | Realtime, `gpt-realtime-2.1` | model unchanged; transport moved to browser↔provider WebRTC with a server sideband (Phase 1, 2026-08-26) | The approved overhaul fixes structural voice latency and false interruptions; the model identifier did not change. |
| Input transcription | `gpt-4o-mini-transcribe` | unchanged | Existing Realtime configuration retained. |
| Fallback and summary | Chat Completions, `gpt-5.6-terra` | unchanged | Structured validation was added locally without endpoint migration. |
| Reasoning effort | Realtime default, fallback `none`, summary `low` | Realtime `low`; fallback `none`; summary `low` | Low Realtime reasoning improves visual/tool decisions while preserving voice latency; model/provider/endpoint remain unchanged. |

Rollback: the runtime identifiers remain environment-configurable. No new OpenAI endpoint or provider dependency was introduced.

## Protocol and generation ownership

`shared/runtimeProtocol.ts` defines schema `1.0.0`. Every browser/server event carries event ID, session, connection epoch, turn, generation, monotonic sequence, type and payload; provider IDs, visual/semantic IDs and idempotency keys are optional typed fields. (Phase 1 removed the sample-offset field with the PCM clock.)

The browser rejects malformed, duplicated, non-monotonic or stale identity. The server maps each provider response ID to the generation active when the response was created, so late provider deltas retain their old identity and are rejected after interruption.

`GenerationScope` owns its `AbortController`, provider response IDs, caption/visual/character identifiers, timers, animation frames and cleanups. Interrupt, transport replacement, reconnect, navigation and end cancel the whole scope.

## Phase 0 telemetry path

Phase 0 adds an observer-only path without changing lesson, board, response, cancellation, model, or transport ownership:

`browser lifecycle/paint observers → versioned runtime metric envelope → server
schema/identity trust check → session-scoped identifier pseudonymization →
bounded ordered writer → released metric event → parent-scoped session-log
projection`.

Browser observations carry only a closed metric payload. The existing runtime
envelope supplies session, connection epoch, turn, generation, sequence, and
optional provider-response identity. The server rejects malformed or stale
envelopes, requires exact accepted-response correlation for board/narration
timing, then transforms every turn/generation/provider/visual/semantic/section/
object identifier into a deterministic field-specific token scoped to that
session. A per-connection `SessionTelemetryWriter` enqueues without awaiting
repository work and drains one bounded FIFO in order, so metrics cannot delay
response creation, cancellation, cue/response completion, or later messages.
Production SQLite telemetry append and prior-start paging run in a worker
thread; managed Postgres uses its native async boundary. Accepted normal
observations remain FIFO. Fixed per-reason gap counters preserve completeness
totals without claiming chronological position under saturation.
Provider terminal observations are deduplicated by a bounded response-ID set.
Provider-side observers read token categories from
`response.done.response.usage`; tutor-audio duration is the browser-reported
heard duration from the relayed `playback_boundary` envelope event (Phase 1),
recorded once per response through the same released metric event boundary. No
observer owns response creation, lesson transitions, board mutation,
interruption thresholds, retry behavior, or durable release decisions.

`GET /api/sessions/:id/log` sets `Cache-Control: no-store` before authorization,
resolves the session through existing parent ownership, and uses one shared
5,000-row limit for the repository query and truncation projection. Projection
consumes released rows in repository order (ascending event/server chronology),
excludes malformed/unreleased/non-metric rows, pseudonymizes any raw identifier
in a malformed direct or historical typed row, and returns duration aggregates,
per-transition interruption counts, section/reconnect/disappearance counts,
provider usage, telemetry gaps, and a metric-only timeline. It returns `401`
without parent authentication and `404` across parent scope; transcript and
evidence text are not projected.

`telemetry_gap` aggregates `server_queue_overflow`,
`server_persistence_failure`, and `client_queue_overflow`. Pending server gaps
are written before later observations; browser pre-ready eviction is reported
on the next accepted `ready`. A connection that never recovers, and a final
fallback/failed transport phase, can still lose browser observations before a
gap reaches the server, so those runs cannot prove complete telemetry delivery.

The first-audio duration ends when the browser handles the provider’s `output_audio_buffer.started` playback boundary for the accepted response (Phase 1; formerly the first tutor audio delta). It is browser-received timing, not acoustic onset. The signed board metric is `playback-start boundary − first committed board paint`: positive means board first and negative means narration first. It is not animation-completion time. These deterministic boundaries make no live latency or target-hardware claim.

Phase 0 was built on WebSocket plus browser-owned PCM; Phase 1 (below) moved the audio plane to WebRTC while preserving every Phase 0 metric name, envelope trust check, pseudonymization step, and gap-accounting behavior.

## Voice transport: WebRTC media plane plus server sideband (Phase 1, 2026-08-26)

The server-proxied audio path was replaced at its structural root:

- **Bootstrap.** `POST /api/webrtc-call?session=…` (same-origin guard, lesson capability, per-parent/IP rate limit) accepts the browser’s SDP offer, calls the provider’s `/v1/realtime/calls` with the server-held API key, persists the returned `call_id` as a released `voice_call` event in the session log, opens the control sideband `wss://…/v1/realtime?call_id=…`, applies the full session configuration (semantic VAD `medium`, `create_response:false`/`interrupt_response:false`, near-field noise reduction, `gpt-4o-mini-transcribe`, voice `marin`, reasoning `low`, tools) before answering, and returns only the SDP answer. The API key never reaches the browser.
- **Media plane.** The browser’s `WebRtcVoiceTransport` owns the microphone track (echo cancellation, noise suppression, auto gain), plays the tutor’s remote audio track natively, and reads mic/voice energy from WebAudio analysers. The provider’s data channel delivers `output_audio_buffer.started/stopped/cleared` — the real playback boundaries. No PCM transits the server or the envelope.
- **Control plane.** The existing `/ws/lesson` envelope carries board, lesson, caption, task, telemetry, and typed-turn events only. The server sideband owns everything the proxy owned: sole `response.create` ownership, tool handling, board staging/preflight/visibility, orchestrator integration, evidence, blueprint restore, and telemetry. A sideband (re)connection reattaches by the persisted `call_id`; a bootstrap-moment socket is adopted from an in-process registry with buffered-frame replay, and reattachment reapplies the session configuration idempotently.
- **Cue binding.** Captions release on transcript-delta arrival with phrase smoothing and final-transcript correction. Board reveals, semantic lesson state, task delivery, and truncation bind to playback boundaries: cues for the audibly playing response wait for its `stopped`/`cleared`; cues for a response that is not playing (tool-first plans, no-audio responses) release immediately, which keeps the fail-closed visibility barrier live. Storyboard step cues (`await_narration`) additionally bind to the END of their tagged response — they hold until it has finished playing, with fail-safe release for responses that will never play (retired, done with no audio, or no voice plane). The client relays stop boundaries (with heard milliseconds) over the envelope for the server’s audio-duration telemetry and truthful `conversation.item.truncate`.
- **Interruption.** Dual confirmation is unchanged in meaning: sustained local energy above the adaptive noise floor (WebAudio analyser) plus an independent provider `speech_started`. Confirmed barge-in mutes the remote track, sends `output_audio_buffer.clear` on the data channel, cancels the response on the sideband, truncates the spoken item at the heard duration, and raises semantic eagerness to `high` for that turn only. A delivered task expecting a short voice answer also raises eagerness to `high`; drawing tasks and ordinary turns keep `medium`.
- **Reconnect.** An envelope/sideband reconnect never stops WebRTC playback; the call, floor state, blueprint, and board ledger are restored from persistence against the same `call_id`. Only the terminal captions-only fallback transition silences residual audio. A failed peer connection degrades to captions (sideband transcripts keep flowing) — never a silent hang; ICE restart/renegotiation is deliberately deferred.
- **Testing.** The offline provider harness still feeds raw upstream permutations through the coordinator; the client has a deterministic `FakeVoiceTransport` for vitest and a page-injected fake for Playwright. All suites run fully offline. Real latency/AEC improvements require an authorized live run; see the [Phase 1 handoff](2026-08-26-phase-1-webrtc-sideband-handoff.md).

## Lesson compilation before the call (Phase 2, 2026-08-26)

Lesson authorship no longer happens inside the realtime voice session. At session creation, `server/lesson/compiler.ts` uses the existing Chat Completions path (default `gpt-5.6-terra`, `NOURA_COMPILER_MODEL` / `NOURA_COMPILER_REASONING_EFFORT` env-configurable) to produce one validated `CompiledLesson` (`shared/compiledLesson.ts`):

- **Normalization.** The parent's free-text goal becomes one concrete teachable objective; a vague goal yields 2–3 candidate objectives that `POST /api/sessions` returns for the parent to pick, and only the confirming call creates the session.
- **Authorship.** The full `LessonBlueprint` — stages with success criteria, exact check-question wording (`questionOrTask`, `responseMode`, target object IDs), learner opportunities and per-check misconception branches — plus, for board-led lessons, an anchor scene of validated BoardOps and an ordered storyboard whose steps each carry a 1–2 sentence narration beat and the object IDs it reveals.
- **Headless validation.** Every compiled scene runs through the real client pipeline — `compileScene`, inspection, annotation layout, quality budget, with DOM-measured KaTeX bounds — inside headless Chromium driving the same `BoardHarness` page the visual tests use. Rejection reasons feed a bounded self-correction loop (2 retries); persistent failure falls back to a simpler validated template and finally to conversation-led mode. An invalid lesson is never stored as ready.
- **Persistence.** Compiled lessons live in the additive `compiled_lessons` table (SQLite and Postgres, portable export/import parity) as a `pending|ready|failed` record keyed by session. The lesson page polls this status and shows an honest preparing (or failed) state; the WebRTC bootstrap and sideband proxy refuse to start a lesson whose record is not ready. `NOURA_LESSON_COMPILER=fixture` selects a deterministic fixture compiler for offline dev and hermetic tests only; production startup refuses it.
- **Consumption.** The realtime session seeds its lesson state from the stored blueprint (restored on reconnect exactly like before) and injects the current stage's objective and checks into instructions per stage. The `establish` request resolves to the pre-validated anchor scene, played step by step by the storyboard runner — the voice model never invents geometry and never pre-narrates the scene (beats are prompted per reveal). `create_lesson_blueprint` no longer exists as a live tool; legacy event parsing remains for replaying old sessions.
- **Bounded replanning.** When evidence classification shows a missing prerequisite outside pre-authored branches, the server (not the model) schedules a compiler-authored detour mini-plan (1–2 stages) carried on the existing `detourStack`; a timeout falls back to the plain recorded detour, and the lesson returns to the recorded stage either way.

## Deterministic lesson orchestration

`server/lesson/orchestrator.ts` owns legal phase transitions, owed action, turn owner, delivered task, interruption recovery and completion boundaries. `AWAIT_LEARNER` throws unless a non-empty question/task ID and text were delivered.

The model executes the pre-compiled blueprint stage by stage and proposes a validated `TeachingMove` within the current stage. It owns classification rationale, strategy, visual intent, semantic object and child-facing wording. It does not own the lesson plan, legal waiting, cancellation, immutability or evidence projection. A response that ends without a question receives one bounded continuation; a repeated unresolved handoff becomes a deterministic safe question.

## Audio, captions and cancellation

The audio plane is the Phase 1 WebRTC call above; the server never decodes or counts audio. Transcript deltas stream to the browser immediately, tagged with their provider response, and captions release on arrival with phrase smoothing. `ResponseCueTimeline` holds visual, semantic-state, task, and final-transcript cues for the audibly playing response and releases them at its playback boundary; cues for a response that is not playing release immediately. The compositional offline harness feeds raw upstream order permutations through the sideband coordinator and delivers its real runtime envelopes into `RealtimeSession` under a fake playback-boundary transport, including interruption and identity replacement. This contract is invariant to transcript/tool network interleaving and makes no claim of provider word timestamps. Final transcript correction is applied when the response finishes playing.

Interruption records detector-to-stop-scheduled and provider-confirmation intervals separately. The browser also records provider speech-end-to-response-start and speech-end-to-first-audio, and moves the visible phase to `thinking` as soon as an accepted speech turn stops. Acoustic silence is not inferred from function return. Target-hardware onset-to-silence remains UNVERIFIED.

Incidental-sound hardening keeps provider VAD from cancelling responses autonomously. A browser `VoiceInterruptionGate` requires roughly 280 ms of sustained energy above an adaptive room-noise floor and a recent independent provider `speech_started` event before local audio, visual and generation cancellation run. Server VAD alone, local energy alone and short acoustic spikes are insufficient. Confirmed voice barge-in temporarily changes semantic VAD eagerness from `medium` to `high` for that learner turn only; the next provider response restores `medium`, preserving more thinking room for ordinary turns. Typed questions and deliberate board interaction retain explicit interruption paths.

`BoardSceneCoordinator` is the single owner of the already-visible board. Visual groups are section-scoped pages, so unrelated diagrams may reuse the full logical canvas without colliding. Learner marks inherit the active section; section clear/replace removes tutor items only. Once an accepted visual cue crosses its heard-audio boundary, it is promoted before draw-on animation begins, so audio-energy, phase, pen and learner updates cannot restore an older scene. `BoardCanvas` animator lifetime follows canvas mount/unmount only; render-time callback identity cannot cancel it. Animation completion remains the durable replay acknowledgement, and a checkpoint finished by mid-animation interruption is acknowledged with the new client identity.

After batched learner activity, the browser derives bounded vector features and sends Realtime one size-bounded JPEG containing both the full visible section and an enlarged detail crop as an `input_image` conversation item. Vector features are persisted as spatial hints; the composite image is provider context only and is not stored by Noura. A board-only learner turn advances generation identity and requests exactly one response; concurrent speech leaves response creation to VAD.

`BoardContextTracker` is the server-side logical mirror of that visible truth. It reconstructs only released tutor checkpoints and committed learner BoardOps, then advances tutor state only after `ops_shown`. Its compact scene description and reusable object IDs are appended to Realtime instructions, included in fallback system context, and returned from teaching-move/visual tool calls. Learner questions therefore arrive against the latest visible diagram. Exact raw additions under new IDs are dropped; a semantic plan with at least 60% equivalent additions is returned to the model as an existing visual to update or highlight rather than being rendered again. Unheard checkpoints never enter this context.

Reconnect has an eight-second connect timeout and at most two retries. Only the newest queued text ask is retained with an idempotency key. Captions-only fallback uses the same versioned event envelope, deterministic wait guard, semantic visual adapter/checkpoints and evidence schema as Realtime. `FallbackTurnCoordinator` keeps one process-local provider controller per session while a durable `fallback_turns` claim enforces one active generation and idempotency across requests. Provider calls receive a composed request/supersession/timeout signal. Every fallback mutation revalidates active session, connection epoch, turn, generation and idempotency and is staged unreleased. Completing the turn atomically promotes committed events and evidence; semantic checkpoints additionally require the browser's animation acknowledgement. Failed, cancelled and superseded staging rows remain permanently excluded. Application APIs, replay, context, summaries and Parent surfaces expose released/committed rows only; explicitly named internal-audit reads are the sole diagnostic exception. Completed duplicate keys replay stored envelopes without new rows.

## Semantic visuals and committed reveal

The drawing brain is two-tier (Phase 3a). The fast tier is unchanged: the voice model emits direct `board_ops` increments — highlight, small extensions on visible objects — validated and confirmed sub-second. The slow tier is intent-only: `request_visual` carries purpose, the one idea to show, and constraints, never geometry or template parameters. `establish` resolves to the pre-compiled anchor scene; `compare` and anchor-less scenes go to the Board Director (`server/board/director.ts`), a multimodal reasoning model over the existing Chat Completions path that receives the board ledger, the stage brief, and a rendered screenshot of the visible board (the harness's `nouraRenderScene` raster), proposes add-only BoardOps plus an anchor-shaped storyboard, passes deterministic policy (permanence stripping, density budgets, id-collision checks), is validated through the REAL client pipeline in headless Chromium, vision-checks its own rendered candidate, and fails closed after at most two correction rounds. While the Director works, the tool result has already returned as `preparing` with a continuation, so the tutor keeps teaching about visible objects; failure injects an honest bridge and never a silent stall.

Every storyboard-bearing scene plays through one sequencing engine (`server/realtime/storyboardRunner.ts`): reveal step k at the previous response's real playback boundary → a beat response (`response.create` with per-response `instructions` scoped to that step and a `max_output_tokens` cap) narrates exactly what appeared → step k+1 rides tagged to that beat and applies at its playback stop. Beats are tutor-floor continuations: they never deliver tasks, never turn a trailing question mark into a handoff, and never spawn bounded continuations; after the last beat one ordinary handoff response delivers the stage's check through the existing delivered-task contract. Barge-in pauses the run through the ordinary cancellation machinery — revealed objects stay visible — and it resumes at the first unrevealed step with resume framing; progress persists as `storyboard_progress` events (Director scenes additionally as `directed_scene`) and restores across reconnects. Step timeouts and client rejections abandon the run fail-closed, recorded as `storyboard_outcome` telemetry beside the per-step reveal→narration gap.

The preferred fast-tier path is unchanged:

`Learner need → current-board ledger → intent decision → incremental BoardOps → section-scoped exact compiler → geometry-aware annotation layout → inspection + quality budget → accept/reject feedback → heard visible checkpoint → draw-on animation → replay acknowledgement`.

Adapters cover exact Pythagorean area rearrangement, triangle angle-sum/straight-line proof, unit-circle projection, shared-scale fraction comparison, colour-distinguished slopes, causal cycles, claim/evidence/reasoning, history cause/effect, grammar structure, tables, timelines and explicit NoBoard. General grammars cover relationship maps (flow/hierarchy/cycle), worked steps, aligned comparisons and proportional part–whole strips. These templates now serve the compiler (and remain replay vocabulary); the live voice model is never offered them.

Scene inspection checks finite geometry, safe bounds, the toolbar region, exact text-node collisions and annotation intersections with line, polygon, path, angle, circle, ellipse, axes, number-line, connector and solid-container geometry. Standalone tutor text/equations treat model coordinates as preferences: the closest collision-free annotation lane wins. A section quality report additionally caps tutor items, printed characters and avoidable connector crossings. Long unbroken words are split by measured width. KaTeX layout bounds exactly match its rendered `foreignObject`, so compact focus cannot approve a clipped equation. Rejection preserves the last visible scene and sends `ops_rejected` back into model context so the agent simplifies rather than describing invisible marks.

`revealOrder` is compiled into ordered, individually persisted checkpoints; only a completed animation is acknowledged and replayable, while an already-heard accepted checkpoint remains visible during that animation. Visual cue and semantic section IDs stay on runtime/replay envelopes. Mobile and short-landscape focus prioritizes newly highlighted items and key equations, comparison marks, points/projections, plots or labelled boxes. It creates enough labelled previous/next views to fully contain every required text/equation node, suppresses partially clipped neighbouring text, keeps active educational text at least 16 px at the tested sizes, and preserves named section selection plus full-section overview. A single atomic Board status and item-specific de-emphasis/highlight provide user orientation without moving focus.

## Character attention

`CharacterAttentionController` prioritizes interruption/confirmed learner activity, learner drawing/pointer/touch/focus, tutor pen, semantic object, caption/question, then neutral learner-facing gaze. Every target carries full generation identity, priority, lifetime, smoothing and reduced-motion permission.

The avatar uses real output energy for mouth state, direct CSS-variable eye motion, bounded gaze, subtle blink/brow/head state, pointer hysteresis, and document-visibility pausing. Interruption cancels unreleased future visual work and finishes any already-heard checkpoint currently drawing. Camera behavior is omitted.

## Persistence and evidence

Local SQLite uses numbered migrations, foreign keys, latest-event pagination, immutable ended-session cutoffs and linked continuation. `noura.db` migration checkpoints and verifies the historical database, writes a verified backup, compares row counts, and retains the source. Its general domain adapter remains synchronous, while the Phase 0 telemetry append/prior-start operations alone cross the dedicated bounded worker boundary.

Evidence observations include UUID, child/session, normalized concept, taxonomy, observation, confidence basis, source event IDs, exact normalized excerpt/span, task/opportunity kind, retrieval lineage, independence, domain result, turn/generation, contradiction/supersession and time. `projectConceptHistories` is the single status projection used by summary validation, deterministic summary fallback and Parent concept history. One opportunity is identified by session, task and turn, so duplicate classifications of one answer count once. “Demonstrated” requires distinct independent positive opportunities, explanation/application, and a chronologically later retrieval whose `retrievalOf` names the earlier task. Latest negative or unresolved contradiction/misconception remains uncertain. Explicit correction resolves a misconception but is not confirmation; fresh independent application/explanation plus tied later retrieval is required afterward. Self-correction remains reduced-independence. Summary claims cite evidence IDs and carry a calibrated `progressing|demonstrated` label; invalid IDs, projection overclaims or invented quoted spans cause deterministic fallback.

The repository contract now has two implementations: synchronous SQLite for local work and asynchronous managed Postgres for deployed REST, Realtime, fallback, evidence and summary paths. Postgres uses a private `noura` schema, transactional fallback claims, staged reveal, immutable ending and the same evidence lineage projection. The portable export/import path targets that same schema. Public v0 uses a signed pseudonymous guest-parent scope; full Production still requires an external identity provider and the remaining privacy/safety gates.

## Vercel topology

Vite builds to static output. `api/[...path].ts` exports the Express/REST server (including the `POST /api/webrtc-call` bootstrap) and `api/ws.ts` exports the native Node WebSocket server for the control envelope. The WebSocket Function duration is 300 seconds, matching the inspected Hobby maximum. Envelope/sideband reconnect is mandatory and must not interrupt the WebRTC audio plane; the `call_id` is persisted so any instance can reattach. No in-memory state is considered durable (the sideband adoption registry is a same-instance fast path only).

Native Vercel WebSockets are a 2026 public beta. Preview can run synthetic, ephemeral evaluation only; `/healthz` reports degraded durable storage there. `production-v0` may start only with the provider, managed Postgres adapter and lesson signing configured, and remains synthetic-only with guest identity. Full `production` additionally requires external parent identity, privacy/safety configuration and relevant account evidence.

## Rollback

Code rollback is safe while schema additions remain additive. Keep the previous verified deployment ID and use `vercel rollback <deployment>` or `vercel promote <previous-deployment>`. Do not roll code behind an incompatible migration. The local legacy database and backup remain available; never delete them as part of rollback.
