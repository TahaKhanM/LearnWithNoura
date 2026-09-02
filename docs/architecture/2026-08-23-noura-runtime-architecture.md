# Noura runtime architecture and decision record

Date: 2026-08-23; updated 2026-08-26 for the Phase 1 voice-transport overhaul, Phase 3 Board Director/renderer work, and the drawing/audio/subtitle runtime recoveries. Status: active, with a full-product public-v0 boundary and explicit real-user Production blockers. Recovery details are recorded in [the drawing runtime audit](2026-08-26-drawing-runtime-recovery.md) and [the audio/subtitle runtime audit](2026-08-26-media-caption-runtime-recovery.md).

This ADR supersedes the historical live-tutor ADR in `docs/legacy/`. It preserves the semantic BoardOp DSL, exact compiler, safe expression parser, released-only replay, owner metadata, dry-erase identity, server-side provider key, and provider replaceability. Phase 1 replaced the browser PCM clock with provider playback boundaries; see “Voice transport: WebRTC media plane plus server sideband”.

## Implementation-agent and runtime-model decision

GPT-5.6 Sol was used by Codex to implement this repository change. That fact is independent of Noura’s runtime. The reviewed runtime remains:

| Path | Before | After | Decision |
| --- | --- | --- | --- |
| Live speech | Realtime, `gpt-realtime-2.1` | model unchanged; transport moved to browser↔provider WebRTC with a server sideband (Phase 1, 2026-08-26) | The approved overhaul fixes structural voice latency and false interruptions; the model identifier did not change. |
| Input transcription | `gpt-4o-mini-transcribe` | unchanged | Existing Realtime configuration retained. |
| Fallback and summary | Chat Completions, `gpt-5.6-terra` | unchanged | Structured validation was added locally without endpoint migration. |
| Board composition | Chat Completions, `gpt-5.6-terra` | independent `NOURA_DIRECTOR_MODEL` role, low primary effort | The exact vNext step schema uses strict `json_schema`; Terra-medium is the corrected-gate recovery default. |
| Reveal audit | none in classic; hard-coded Luna-low during M1 streaming | independent `NOURA_VISION_AUDIT_MODEL` role, default `gpt-5.6-luna` at low effort | M0 audit evidence—not composition evidence—measured 100% seeded-defect catch, 8.3% false reject and 2,398 ms p95. |
| Reasoning effort | Realtime default, fallback `none`, summary `low` | Realtime `low`; fallback `none`; summary `low`; drawing roles use independent effort knobs | Low Realtime reasoning improves visual/tool decisions while preserving voice latency; model/provider/endpoint remain unchanged. |

Rollback: the runtime identifiers remain environment-configurable. No new OpenAI endpoint or provider dependency was introduced. During Drawing vNext M1–M6, `NOURA_DIRECTOR_PIPELINE=streaming|classic` selects the step-structured or legacy atomic Director. After corrected M1 acceptance, unset local and Preview environments resolve to `streaming` at low effort; Production remains `classic` at medium effort until the separately authorized M2 smoke. `classic` remains the rollback path and is not a second long-term architecture.

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

Drawing vNext M0 extends this observer path with four closed contracts:
`visual_first_paint` (server acceptance to `ops_presented`),
`visual_scene_complete` (acceptance to the final durable visual step),
`director_stream_first_op`, and latency-bearing `vision_audit_outcome`.
Lane, OpenAI model, reasoning effort, and verdict dimensions are bounded enums;
the browser never supplies elapsed time. The accompanying Director evaluator is
offline by default, keeps a 24/12 representative/holdout split, and cannot
change runtime defaults. Its authorized live path is synthetic-only and
spend-capped; see [the M0 handoff](2026-08-30-drawing-vnext-m0-handoff.md).

Drawing vNext M1 is accepted under the architecture-owner’s corrected layered
gates in
[`2026-09-01-drawing-vnext-m1-acceptance-and-continuation-prompt.md`](2026-09-01-drawing-vnext-m1-acceptance-and-continuation-prompt.md): G1 structured
validity is 360/360; G2 production-authority first pass is 329/360; G3 reaches
350/360 delivered scenes with Terra-medium escalation; and the actual
Lesson-page `ops_presented` p50 is 2,818 ms streaming versus 4,909 ms classic,
a 42.5952% cut. The targeted low-effort placement round remains implemented
and passes the identical policy/browser/audit chain, but recovered only 2/13
study rows; Terra-medium alone is the cheaper qualifying recovery default.
The retained acceptance artifact is
`server/board/eval/results/2026-09-01-drawing-m1-corrected-acceptance.json`
(SHA-256 `72e12e65eed3361e169e29dabedbb87d26f83542022db8f7c21903360409c2e7`).

The capability boundary is the versioned
[Curriculum Visual Coverage Matrix](2026-09-02-curriculum-visual-coverage-matrix.md),
not a fixed template list. It currently records 39 bounded 11+/SAT visual
families: 5 supported, 10 browser-fixture-composable and 24 missing. Routing may
accelerate unambiguous rows with templates, but the generative lane remains the
open-set fallback. M7 implements the matrix’s fixed schema/rendering missing
set; M8 reruns the sealed cross-family acceptance corpus with templates
disabled.

M2 role adoption is hash-bound in
`server/board/eval/results/2026-09-02-drawing-m2-role-adoption.json`
(SHA-256 `0235f1cfde95421ac27f02252b6b12286282134e7fd973ff6edcb216ed4e4db3`).
The offline port/config/schema/PII gates pass. The first authorized one-lesson
smoke passed automated telemetry but failed manual connector-label quality and
is preserved as a negative result. A separately authorized corrected rerun
passed the adopted-role/second-board-change scope with overlap-free live frames,
three provider calls, no recovery and no telemetry/permanence defects. Its third
storyboard reveal was inspected from the terminal scene offline and is not
claimed live; target hardware also remains unverified.

M3 is mechanism-only: the deterministic extractor and template-first stream
short-circuit are proven with number-line, fraction-strip and plotted-graph
exemplars, while ambiguous and open-set requests remain generative. The sealed
unfamiliar/abstract lane is 40/40 delivered through the F9 recovery evidence.
Additional completed extractors are retained but catalogue expansion and the
blended-validity gate are deferred to M8; M7 parts 0–2 now take priority.

Phase 0 was built on WebSocket plus browser-owned PCM; Phase 1 (below) moved the audio plane to WebRTC while preserving every Phase 0 metric name, envelope trust check, pseudonymization step, and gap-accounting behavior.

## Voice transport: WebRTC media plane plus server sideband (Phase 1, 2026-08-26)

The server-proxied audio path was replaced at its structural root:

- **Bootstrap.** `POST /api/webrtc-call?session=…` (same-origin guard, lesson capability, per-parent/IP rate limit) accepts the browser’s SDP offer, calls the provider’s `/v1/realtime/calls` with the server-held API key, persists the returned `call_id` as a released `voice_call` event in the session log, opens the control sideband `wss://…/v1/realtime?call_id=…`, applies the full session configuration (semantic VAD `medium`, `create_response:false`/`interrupt_response:false`, near-field noise reduction, `gpt-4o-mini-transcribe`, voice `marin`, reasoning `low`, tools) before answering, and returns only the SDP answer. The API key never reaches the browser.
- **Media plane.** The browser’s `WebRtcVoiceTransport` owns the microphone track when permission exists (echo cancellation, noise suppression, auto gain), otherwise it negotiates a listen-only transceiver. It plays the tutor’s remote audio track natively and treats WebAudio analysers as optional observers that cannot abort the call. Provider `output_audio_buffer.started/stopped/cleared` events are correlated with actual local media playback; autoplay rejection becomes an explicit recoverable state rather than a swallowed promise. No PCM transits the server or the envelope.
- **Control plane.** The existing `/ws/lesson` envelope carries board, lesson, caption, task, telemetry, and typed-turn events only. The server sideband owns everything the proxy owned: sole `response.create` ownership, tool handling, board staging/preflight/visibility, orchestrator integration, evidence, blueprint restore, and telemetry. A sideband (re)connection reattaches by the persisted `call_id`; a bootstrap-moment socket is adopted from an in-process registry with buffered-frame replay, and reattachment reapplies the session configuration idempotently.
- **Cue binding.** `ResponseCaptionTimeline` owns ordered child/tutor caption groups separately from generic response cues. Generated transcript text stays pending until local playback starts, releases one fluent phrase at a time, and final-corrects the same group in place; interruption freezes presented phrases and drops the unheard tail. Audio-unavailable responses release captions immediately. Semantic lesson state and task delivery wait through the generation-to-audio gap and release only when playback finishes or is proven unavailable. Ordinary board ink can still first-paint immediately; storyboard steps (`await_narration`) bind to the END of their tagged response. The client relays stop boundaries (with heard milliseconds) for server audio-duration telemetry and truthful `conversation.item.truncate`.
- **Interruption.** Dual confirmation is unchanged in meaning: sustained local energy above the adaptive noise floor (WebAudio analyser) plus an independent provider `speech_started`. Confirmed barge-in mutes the remote track, sends `output_audio_buffer.clear` on the data channel, cancels the response on the sideband, truncates the spoken item at the heard duration, and raises semantic eagerness to `high` for that turn only. A delivered task expecting a short voice answer also raises eagerness to `high`; drawing tasks and ordinary turns keep `medium`.
- **Reconnect.** An envelope/sideband reconnect never stops WebRTC playback; the call, floor state, blueprint, board ledger, and already-presented caption groups survive against the same `call_id`. Only the terminal REST captions-only fallback silences residual audio. A failed peer connection marks pending responses audio-unavailable so sideband transcripts and task delivery continue without a silent hang; ICE restart/renegotiation remains deferred.
- **Testing.** The offline provider harness still feeds raw upstream permutations through the coordinator; the client has a deterministic `FakeVoiceTransport` for vitest and a page-injected fake for Playwright. All suites run fully offline. Real latency/AEC improvements require an authorized live run; see the [Phase 1 handoff](2026-08-26-phase-1-webrtc-sideband-handoff.md).

## Lesson compilation before the call (Phase 2, 2026-08-26)

Lesson authorship no longer happens inside the realtime voice session. At session creation, `server/lesson/compiler.ts` uses the existing Chat Completions path (default `gpt-5.6-terra`, `NOURA_COMPILER_MODEL` / `NOURA_COMPILER_REASONING_EFFORT` env-configurable) to produce one validated `CompiledLesson` (`shared/compiledLesson.ts`):

- **Normalization.** The parent's free-text goal becomes one concrete teachable objective; a vague goal yields 2–3 candidate objectives that `POST /api/sessions` returns for the parent to pick, and only the confirming call creates the session.
- **Authorship.** The full `LessonBlueprint` — stages with success criteria, exact check-question wording (`questionOrTask`, `responseMode`, target object IDs), learner opportunities and per-check misconception branches — plus, for board-led lessons, an anchor scene of validated BoardOps and an ordered storyboard whose steps each carry a 1–2 sentence narration beat and the object IDs it reveals.
- **Validation authority.** When a reachable headless harness is configured, compiled scenes receive the early `BoardHarness` quality gate before being stored. Production availability no longer depends on launching Chromium inside a serverless function: authored BoardOps remain schema-validated during compilation, and the connected learner browser must preflight an anchor through the real client pipeline before its first storyboard step can appear. A pending artifact is never teachable; Begin stays disabled until the strong compile is ready.
- **Persistence.** Compiled lessons live in the additive `compiled_lessons` table (SQLite and Postgres, portable export/import parity) as a `pending|ready|failed` record keyed by session. The lesson page polls this status and shows an honest preparing (or failed) state; the WebRTC bootstrap and sideband proxy refuse to start a lesson whose record is not ready. `NOURA_LESSON_COMPILER=fixture` selects a deterministic fixture compiler for offline dev and hermetic tests only; production startup refuses it.
- **Consumption.** The realtime session seeds its lesson state from the stored blueprint (restored on reconnect exactly like before) and injects the current stage's objective and checks into instructions per stage. The `establish` request resolves to the pre-validated anchor scene, played step by step by the storyboard runner — the voice model never invents geometry and never pre-narrates the scene (beats are prompted per reveal). `create_lesson_blueprint` no longer exists as a live tool; legacy event parsing remains for replaying old sessions.
- **Bounded replanning.** When evidence classification shows a missing prerequisite outside pre-authored branches, the server (not the model) schedules a compiler-authored detour mini-plan (1–2 stages) carried on the existing `detourStack`; a timeout falls back to the plain recorded detour, and the lesson returns to the recorded stage either way.

## Deterministic lesson orchestration

`server/lesson/orchestrator.ts` owns legal phase transitions, owed action, turn owner, delivered task, interruption recovery and completion boundaries. `AWAIT_LEARNER` throws unless a non-empty question/task ID and text were delivered.

The model executes the pre-compiled blueprint stage by stage and proposes a validated `TeachingMove` within the current stage. It owns classification rationale, strategy, visual intent, semantic object and child-facing wording. It does not own the lesson plan, legal waiting, cancellation, immutability or evidence projection. A response that ends without a question receives one bounded continuation; a repeated unresolved handoff becomes a deterministic safe question.

## Audio, captions and cancellation

The audio plane is the Phase 1 WebRTC call above; the server never decodes or counts audio. Transcript deltas stream to the browser tagged with their provider response, but generation arrival is not treated as proof of playback. `ResponseCaptionTimeline` preserves response/learner ordering and advances subtitles from confirmed local playback. `ResponseCueTimeline` now carries visual, semantic-state, and task cues only. Its nonvisual cues hold while audio is pending or playing, preventing a task banner from appearing before its question. The compositional offline harness covers generation-done-before-audio, consecutive responses, interruption, identity replacement, autoplay blocking, and captions-only failure. The provider supplies no word timestamps, so the contract is phrase-level alignment and final in-place correction.

Interruption records detector-to-stop-scheduled and provider-confirmation intervals separately. The browser also records provider speech-end-to-response-start and speech-end-to-first-audio, and moves the visible phase to `thinking` as soon as an accepted speech turn stops. Acoustic silence is not inferred from function return. Target-hardware onset-to-silence remains UNVERIFIED.

Incidental-sound hardening keeps provider VAD from cancelling responses autonomously. A browser `VoiceInterruptionGate` requires roughly 280 ms of sustained energy above an adaptive room-noise floor and a recent independent provider `speech_started` event before local audio, visual and generation cancellation run. Server VAD alone, local energy alone and short acoustic spikes are insufficient. Confirmed voice barge-in temporarily changes semantic VAD eagerness from `medium` to `high` for that learner turn only; the next provider response restores `medium`, preserving more thinking room for ordinary turns. Typed questions and deliberate board interaction retain explicit interruption paths.

`BoardSceneCoordinator` is the single owner of the already-visible board. Visual groups are spatial camera regions on one logical canvas: each keeps a local 1000×600 tile, laid out in a horizontal strip with a gutter, and the camera pans only on announced navigation. Learner marks inherit the region they were drawn in; section clear/replace removes tutor items only. `sceneForGroup` is a snapshot/preflight slice, not a render filter. Once an accepted visual cue crosses its heard-audio boundary, it is promoted before draw-on animation begins, so audio-energy, phase, pen and learner updates cannot restore an older scene. `BoardCanvas` animator lifetime follows canvas mount/unmount only; render-time callback identity cannot cancel it. Animation completion remains the durable replay acknowledgement, and a checkpoint finished by mid-animation interruption is acknowledged with the new client identity.

After batched learner activity, the browser derives bounded vector features and sends Realtime one size-bounded JPEG containing both the full visible section and an enlarged detail crop as an `input_image` conversation item. Vector features are persisted as spatial hints; the composite image is provider context only and is not stored by Noura. A board-only learner turn advances generation identity and requests exactly one response; concurrent speech leaves response creation to VAD.

`BoardContextTracker` is the server-side logical mirror of visible truth. It reconstructs released tutor checkpoints and committed learner BoardOps. During a live transaction it advances at the browser's `ops_presented` first-paint acknowledgement, while `ops_shown` remains the later animation-complete boundary that releases the stored event for replay. Tool results therefore never call a merely sent cue visible, and they do not wait for the entire draw-on animation. A late rejection reloads the released ledger rather than leaving optimistic state behind. Board instructions refresh at learner-turn boundaries, not in the middle of continuation speech.

Reconnect has an eight-second connect timeout and at most two retries. Only the newest queued text ask is retained with an idempotency key. Captions-only fallback uses the same versioned event envelope, deterministic wait guard, semantic visual adapter/checkpoints and evidence schema as Realtime. `FallbackTurnCoordinator` keeps one process-local provider controller per session while a durable `fallback_turns` claim enforces one active generation and idempotency across requests. Provider calls receive a composed request/supersession/timeout signal. Every fallback mutation revalidates active session, connection epoch, turn, generation and idempotency and is staged unreleased. Completing the turn atomically promotes committed events and evidence; semantic checkpoints additionally require the browser's animation acknowledgement. Failed, cancelled and superseded staging rows remain permanently excluded. Application APIs, replay, context, summaries and Parent surfaces expose released/committed rows only; explicitly named internal-audit reads are the sole diagnostic exception. Completed duplicate keys replay stored envelopes without new rows.

## Semantic visuals and committed reveal

The drawing brain is two-tier (Phase 3a, corrected by the August 26 runtime recovery). The fast tier accepts only atomic increments on visible work; a rejected batch applies nothing. The slow tier is intent-only: `request_visual` owns every new representation, including the first figure in a conversation-led lesson. `establish` resolves to the pre-compiled anchor when present; otherwise it and `compare` go to the Board Director (`server/board/director.ts`). For live lessons the Director's validation and render ports are bound per session to the connected learner browser. The browser renders the current board, preflights the proposal, and renders the candidate; the Director then vision-checks that exact raster and fails closed after at most two correction rounds. A server-side harness is optional. While the Director works, the tool result has already returned as `preparing`, so the tutor keeps teaching about visible objects.

Every storyboard-bearing scene plays through one sequencing engine (`server/realtime/storyboardRunner.ts`): reveal step k at the previous response's real playback boundary → a beat response (`response.create` with per-response `instructions` scoped to that step and a `max_output_tokens` cap) narrates exactly what appeared → step k+1 rides tagged to that beat and applies at its playback stop. Beats are tutor-floor continuations: they never deliver tasks, never turn a trailing question mark into a handoff, and never spawn bounded continuations; after the last beat one ordinary handoff response delivers the stage's check through the existing delivered-task contract. Barge-in pauses the run through the ordinary cancellation machinery — revealed objects stay visible — and it resumes at the first unrevealed step with resume framing; progress persists as `storyboard_progress` events (Director scenes additionally as `directed_scene`) and restores across reconnects. Step timeouts and client rejections abandon the run fail-closed, recorded as `storyboard_outcome` telemetry beside the per-step reveal→narration gap.

The preferred fast-tier path is unchanged:

`Learner need → current-board ledger → intent request → Director proposal → learner-browser preflight/render → vision check → storyboard cue → first paint (`ops_presented`) → truthful tool/agent state → draw-on completion (`ops_shown`) → durable replay`.

Adapters cover exact Pythagorean area rearrangement, triangle angle-sum/straight-line proof, unit-circle projection, shared-scale fraction comparison, colour-distinguished slopes, causal cycles, claim/evidence/reasoning, history cause/effect, grammar structure, tables, timelines and explicit NoBoard. General grammars cover relationship maps (flow/hierarchy/cycle), worked steps, aligned comparisons and proportional part–whole strips. These templates now serve the compiler (and remain replay vocabulary); the live voice model is never offered them.

The Director and Lesson Compiler may emit tutor arcs (center/radius/angles or three-point), bounded cubic Bézier curves, handwritten Caveat margin notes, and curated local educational icons (`shared/boardAssets.ts`, original geometry, no network fetch). The voice model's fast-tier `board_ops` path rejects those kinds; `promptConsistency` pins that the realtime prompt never teaches them.

Scene inspection checks finite geometry, safe bounds, the toolbar region, exact text-node collisions and annotation intersections with line, polygon, path, arc, curve, angle, circle, ellipse, axes, number-line, connector, asset and solid-container geometry. Standalone tutor text/equations treat model coordinates as preferences: the closest collision-free annotation lane wins. A section quality report additionally caps tutor items, printed characters, curated assets (8) and avoidable connector crossings. Long unbroken words are split by measured width. KaTeX layout bounds exactly match its rendered `foreignObject`, so compact focus cannot approve a clipped equation. Rejection preserves the last visible scene and sends `ops_rejected` back into model context so the agent simplifies rather than describing invisible marks.

`revealOrder` is compiled into ordered, individually persisted checkpoints; only a completed animation is acknowledged and replayable, while an already-heard accepted checkpoint remains visible during that animation. Visual cue and semantic section IDs stay on runtime/replay envelopes. Mobile and short-landscape focus prioritizes newly highlighted items and key equations, comparison marks, points/projections, plots or labelled boxes. It creates enough labelled previous/next views to fully contain every required text/equation node, suppresses partially clipped neighbouring text, keeps active educational text at least 16 px at the tested sizes, and preserves named section selection plus full-section overview. A single atomic Board status and item-specific de-emphasis/highlight provide user orientation without moving focus.

## Character attention

`CharacterAttentionController` prioritizes interruption/confirmed learner activity, learner drawing/pointer/touch/focus, tutor pen, semantic object, caption/question, then neutral learner-facing gaze. Every target carries full generation identity, priority, lifetime, smoothing and reduced-motion permission.

The avatar uses real output energy for mouth state, direct CSS-variable eye motion, bounded gaze, subtle blink/brow/head state, pointer hysteresis, and document-visibility pausing. Interruption cancels unreleased future visual work and finishes any already-heard checkpoint currently drawing. Camera behavior is omitted.

## Persistence and evidence

Local SQLite uses numbered migrations, foreign keys, latest-event pagination, immutable ended-session cutoffs and linked continuation. `noura.db` migration checkpoints and verifies the historical database, writes a verified backup, compares row counts, and retains the source. Its general domain adapter remains synchronous, while the Phase 0 telemetry append/prior-start operations alone cross the dedicated bounded worker boundary.

Evidence observations include UUID, child/session, normalized concept, taxonomy, observation, confidence basis, source event IDs, exact normalized excerpt/span, task/opportunity kind, retrieval lineage, independence, domain result, turn/generation, contradiction/supersession and time. `projectConceptHistories` is the single status projection used by summary validation, deterministic summary fallback and Parent concept history. One opportunity is identified by session, task and turn, so duplicate classifications of one answer count once. “Demonstrated” requires distinct independent positive opportunities, explanation/application, and a chronologically later retrieval whose `retrievalOf` names the earlier task. Latest negative or unresolved contradiction/misconception remains uncertain. Explicit correction resolves a misconception but is not confirmation; fresh independent application/explanation plus tied later retrieval is required afterward. Self-correction remains reduced-independence. Summary claims cite evidence IDs and carry a calibrated `progressing|demonstrated` label; invalid IDs, projection overclaims or invented quoted spans cause deterministic fallback.

The repository contract now has two implementations: synchronous SQLite for local work and asynchronous managed Postgres for deployed REST, Realtime, fallback, evidence and summary paths. Postgres uses a private `noura` schema, transactional fallback claims, staged reveal, immutable ending and the same evidence lineage projection. The portable export/import path targets that same schema. Public v0 uses one server-configured demo identity with a signed parent-session cookie; local synthetic mode may retain a pseudonymous guest scope. Full Production still requires an external identity provider and the remaining privacy/safety gates.

## Vercel topology

Vite builds to static output. `api/[...path].ts` exports the Express/REST server (including the `POST /api/webrtc-call` bootstrap) and `api/ws.ts` exports the native Node WebSocket server for the control envelope. The WebSocket Function duration is 300 seconds, matching the inspected Hobby maximum. Envelope/sideband reconnect is mandatory and must not interrupt the WebRTC audio plane; the `call_id` is persisted so any instance can reattach. No in-memory state is considered durable (the sideband adoption registry is a same-instance fast path only).

Native Vercel WebSockets are a 2026 public beta. Preview can run synthetic, ephemeral evaluation only; `/healthz` reports degraded durable storage there. `production-v0` may start only with the provider, managed Postgres adapter and lesson signing configured; when `NOURA_REQUIRE_LOGIN=true`, it also fails closed unless both demo-account secrets are configured. It remains synthetic-only. Full `production` additionally requires external parent identity, privacy/safety configuration and relevant account evidence.

## Rollback

Code rollback is safe while schema additions remain additive. Keep the previous verified deployment ID and use `vercel rollback <deployment>` or `vercel promote <previous-deployment>`. Do not roll code behind an incompatible migration. The local legacy database and backup remain available; never delete them as part of rollback.
