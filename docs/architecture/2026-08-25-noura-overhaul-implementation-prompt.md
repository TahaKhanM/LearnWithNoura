# Noura architecture overhaul — implementation prompt for Cursor Auto

Copy everything below this line into a Cursor agent session started at the repository root.

---

## Role and mission

You are a senior engineer implementing an approved architecture overhaul of Noura, a voice-first child tutor (live at learnwithnoura.com). The overhaul was designed from a full code audit, two prior internal recovery reviews (`docs/architecture/2026-08-23-whiteboard-recovery-review-and-devin-prompt.md`, `docs/architecture/2026-08-23-whiteboard-follow-up-review-and-devin-prompt.md`), and current provider documentation.

Your mandate, in priority order:

1. **Genuine architectural improvement over patches.** If you find yourself adding a flag, a timer, a heuristic, or a special case to work around a structural problem, stop and fix the structure.
2. **No compromise in quality.** Every phase ends with all verification gates green, stale docs/tool descriptions updated, and dead code removed. "Works but messy" is a failing state.
3. **Clean, organised code.** Decompose oversized modules as you touch them. New code is small, typed, single-purpose modules with tests. No `any`, no unused exports, no commented-out code, no drive-by reformatting.
4. **Honest reporting.** Separate what is proven offline from what requires live-provider verification. Never claim a live behavior is fixed from green offline tests.

You work phase by phase, in order. Do not start a phase until the previous phase's acceptance criteria pass. Commit at each coherent milestone with clear messages. Do not push, deploy, or spend money on live-provider calls without explicit user authorization.

## The three structural flaws you are fixing

1. **Every audio byte crosses two hops.** Browser → Vercel WS Function (300s cap, forced reconnects) → OpenAI, and back. OpenAI officially supports browser WebRTC with a server "sideband" WebSocket controlling the same call — the current proxy pays a permanent latency/robustness tax for control it can keep anyway.
2. **The latency-optimized voice model authors everything.** `gpt-realtime-2.1` at `reasoning: low` writes the lesson blueprint live, invents the pedagogy, and emits exact board geometry. Lesson and drawing quality are capped by a model tuned for speech latency.
3. **Visuals are bound to the end of each audio segment.** Board cues release only after a response's audio fully plays (`server/realtime/segmentAnnotator.ts`), so the flow is always talk → draw → talk-about-the-drawing. There is no interleaved reveal-and-narrate.

## Required reading before any edit

Read completely, in this order:

- `README.md`, `docs/architecture/2026-08-23-noura-runtime-architecture.md`
- `docs/architecture/2026-08-23-learner-turn-contract.md`, `docs/architecture/2026-08-23-board-intelligence-v2.md`
- Both whiteboard review docs dated 2026-08-23
- `server/realtime/proxy.ts`, `server/realtime/tools.ts`, `server/realtime/boardContext.ts`, `server/realtime/segmentAnnotator.ts`, `server/realtime/instructions.ts`
- `server/lesson/orchestrator.ts`, `server/prompts/realtime.md`, `shared/pedagogy.ts`, `shared/lessonTurn.ts`
- `shared/boardOps.ts`, `shared/semanticScene.ts`, everything under `src/board/`
- `src/lesson/realtimeSession.ts`, `src/lesson/LessonPage.tsx`, `src/lesson/audioIn.ts`, `src/lesson/audioOut.ts`, `src/lesson/voiceInterruption.ts`, `src/lesson/responseTimeline.ts`
- `server/store/repo.ts` and `server/store/postgresRepo.ts` (schema/migration patterns), `server/api.ts`, `server/app.ts`, `vercel.json`

Record the green baseline first: `npm run build`, `npm run typecheck:server`, `npm run lint`, `npm test`, `npm run test:e2e`, `npm run test:visual`, `npm run test:a11y`, `npm run test:security`, `npm run test:storage`, `npm run test:brand`.

## Non-negotiable invariants (preserve throughout)

- Visible tutor work is permanent: no live `replace`, no raw model `clear`, no same-turn erase, no silent section switching. These v3.1 policies must survive every refactor.
- Learner drawings are explicit drafts until Done; pointer-up and inactivity never submit; one idempotent submission → exactly one model response.
- The server is the sole owner of `response.create` (`create_response: false`, `interrupt_response: false` stay).
- Event-sourced released-only board replay, owner metadata, generation identity, immutable session ending, and evidence lineage stay intact.
- The exact geometry compiler (KaTeX equations, axes/plots, collision/quality gates) is a strength: extend it, never replace it with model-generated SVG blobs or an untyped canvas.
- Provider API keys never reach the browser.
- Do not migrate provider or runtime models except where a phase explicitly says so; runtime identifiers stay environment-configurable.

## Provider facts (verify against current docs before relying on them)

- WebRTC unified interface: browser POSTs its SDP to your server; server forwards to `POST https://api.openai.com/v1/realtime/calls` with the real API key; the response `Location` header carries `call_id`.
- Sideband control: server opens `wss://api.openai.com/v1/realtime?call_id={callId}` and can send/receive all session events (tools, `session.update`, `response.create`) for the life of the call. Reference: OpenAI guide "Webhooks and server-side controls".
- Over WebRTC, model audio arrives as a media track; the data channel carries JSON events including `output_audio_buffer.started` / `.stopped` / `.cleared` for playback-boundary timing.
- `response.create` accepts per-response `instructions` and output token caps — use this for beat-scoped narration.
- `semantic_vad` supports `eagerness: low|medium|high|auto`; input `noise_reduction` supports near/far field modes.
- `gpt-realtime-2.1` accepts `input_image` content parts and configurable reasoning effort. Image generation (`gpt-image-1.5` / `gpt-image-2` family) supports streaming partial images via `stream: true` + `partial_images`.

If any of these do not match the live docs when you check, stop and write a decision note in `docs/architecture/` before proceeding.

---

## Phase 0 — Baseline and telemetry (no behavior changes)

1. Add lightweight, privacy-safe instrumentation (extend existing metrics events, do not add a third-party SDK): speech-end→response-start, speech-end→first-audio, false barge-in count (gate confirmations later cancelled), board-reveal→narration gap, section switches, per-session reconnect count, object-disappearance events (any visible tutor object leaving the rendered scene outside an announced navigation).
2. Surface these in a structured session log retrievable by session ID.
3. Prepare (but do not run) the synthetic live smoke described in `docs/operations/testing-and-evaluation.md`. Deployment of v3.1 and any paid live run require explicit user authorization — request it and stop this phase there if not granted.

Acceptance: all gates green; instrumentation covered by unit tests; zero behavior change (E2E/visual suites unchanged without snapshot edits).

## Phase 1 — Voice transport: WebRTC + sideband

Goal: browser audio flows directly browser↔OpenAI over WebRTC; the server keeps full control via a sideband WebSocket on the same `call_id`. The Vercel function stops carrying audio.

1. **Decompose first.** Split `server/realtime/proxy.ts` (~1570 lines) into focused modules before rewiring: session/config, tool handling, board staging, turn/floor coordination, transport. Keep tests passing after the split (pure refactor commit).
2. New connection flow: client creates `RTCPeerConnection` + mic track; POSTs SDP to a new server endpoint; server calls `/v1/realtime/calls` (key server-side), stores `call_id` against the session, returns the SDP answer; server attaches the sideband WS and applies the existing session config (semantic VAD, transcription, tools, instructions).
3. Move all tool handling, board staging, orchestration, evidence, and `response.create` ownership onto the sideband connection. The browser's data channel is used only for client-originated UI events that must reach the server fast; define an explicit, versioned message contract — do not let the browser talk to the model directly.
4. Rebind the cue timeline: captions release on transcript-delta arrival with smoothing; board reveal checkpoints and `learner_task` delivery bind to `output_audio_buffer` boundaries relayed via the existing runtime envelope. Delete the PCM sample clock (`audioIn.ts`, `audioOut.ts`, sample counting in the segment annotator) only after parity tests pass.
5. Keep the dual-confirmation barge-in gate, now fed by WebRTC stats/analyser energy plus provider `speech_started`. Add adaptive `eagerness`: `high` when a short answer is expected (delivered question with `responseMode: voice`), `medium` otherwise; enable near-field `noise_reduction`.
6. Reconnect story: sideband WS reconnect must not drop audio; WebRTC ICE restart handled on the client; the 300s function cap now affects only the JSON sideband — verify a lesson survives a sideband reconnect with no visible/audible artifact.
7. Update the fallback (captions-only) path so it still works with the new session bootstrap.

Acceptance: all gates green; new integration tests for the sideband contract using the existing offline provider harness pattern; a fake-transport test proving reveal/caption ordering under out-of-order event delivery; instrumentation shows the double hop removed locally (loopback comparison acceptable); no references to the deleted PCM path remain; docs and `README.md` runtime section updated. State plainly that live latency numbers require an authorized deployed run.

## Phase 2 — Lesson Compiler (parallel-safe with Phase 1; coordinate on prompt changes)

Goal: lessons are authored ahead of time by a strong reasoning model; the realtime model becomes a stage executor/adapter.

1. New `server/lesson/compiler.ts` using the existing Chat Completions path (`gpt-5.6-terra`, reasoning effort medium/high; keep model env-configurable):
   - **Goal normalization**: free-text parent goal → one concrete teachable objective; when ambiguous, return 2–3 candidates for the parent to pick at setup (extend the session-creation API/UI minimally).
   - **Blueprint authorship**: the existing `LessonBlueprint` schema — stages, success criteria, per-stage check questions, misconception branches, learner opportunities.
   - **Anchor scene + storyboard**: the board-led anchor as validated BoardOps plus ordered reveal steps, each with a 1–2 sentence narration beat and named object IDs.
2. **Pre-validate scenes server-side in headless Chromium** (Playwright is already a dependency): run the real `compileScene`/inspection/quality pipeline, including DOM-measured KaTeX bounds. A pure-Node approximation is not acceptable — it reintroduces "server approved, browser rejected".
3. Persist compiled lessons additively (SQLite + Postgres migrations, portable export parity). Session start loads the compiled lesson; `create_lesson_blueprint` is removed from live tools; the orchestrator consumes the stored blueprint unchanged.
4. **Bounded mid-lesson replanning**: an orchestrator-invokable Compiler entry point that authors a detour mini-plan when evidence shows a prerequisite gap outside pre-authored branches; it uses the existing detour-stack semantics and returns to the recorded stage. The tutor bridges verbally while it runs.
5. Rewrite `server/prompts/realtime.md` to remove blueprint authorship and align with execution-only duties. Tool schemas, prompt, and validators must agree exactly — no mention of unavailable actions.
6. If the child taps Begin before compilation finishes, show an honest "preparing your lesson" state; never start a lesson on an uncompiled goal.

Acceptance: all gates green; compiler output validated by schema + headless pipeline tests with at least three subject fixtures (one maths board-led, one non-maths board-led, one conversation-led); orchestrator tests cover replan-detour legality; prompt/tool-schema consistency test added; stale docs updated.

## Phase 3 — Board Director + interleaved reveal-narrate

Goal: a two-tier drawing brain and a tutor that appears to draw while explaining.

1. **Two-tier policy (load-bearing, not an optimization).**
   - Fast tier: the voice model keeps direct `board_ops` increments — `highlight`, small `extend` (≤ a handful of ops on existing objects) — sub-second, exactly as today.
   - Slow tier: new scenes/representations go through `request_visual(intent, purpose, targetObjectIds, constraints)`; the voice model no longer emits full-scene geometry.
2. New `server/board/director.ts`: multimodal reasoning model receives the intent, current board ledger, lesson stage, and a rendered screenshot of the visible board; produces validated BoardOps + a storyboard (reveal steps with narration beats and object IDs); **renders its own candidate in headless Chromium and vision-checks it**, self-correcting at most twice before failing closed. Reuse the existing staging/preflight/quality machinery unchanged.
3. **Interleaved sequencing** on the sideband: reveal step k → `response.create` with per-response `instructions` scoped to that beat ("narrate only the dashed line that just appeared, then stop") and an output token cap → next reveal on the `output_audio_buffer` boundary. Storyboard state (revealed/pending) is a persisted event; interruption pauses remaining steps via existing generation-scope cancellation and resumes at the next step afterward.
4. **Renderer vocabulary**: extend `shared/boardOps.ts` + `src/board/compile.ts` with tutor `path`/arc/Bézier (validated like learner paths), handwriting-style stroke synthesis for short annotations, and a curated `asset` spec backed by a vetted local educational icon set (no network fetch at lesson time). Every new spec gets validation, compile, inspection, and quality coverage.
5. **Sections become spatial regions** on one logical canvas with an announced, animated camera pan; the learner can always pan/jump back. Remove visibility filtering as the section mechanism (`sceneGroups.ts`); preserve event-log compatibility by mapping legacy section events to regions in replay. This closes the last "it vanished" class — verify with a test asserting no visible tutor object ever leaves the rendered scene outside an announced navigation.

Acceptance: all gates green; Director covered by offline harness tests with a scripted model double (accepted scene, self-corrected scene, fail-closed); interleaving covered by a fake-transport test proving beat ordering and interruption resume; fast-tier latency path proven unchanged; camera-region E2E replaces the old section-filter E2E (update assertions deliberately, never blindly).

## Phase 3c — Interactive manipulatives

1. New interactive ShapeSpecs: draggable objects with snap targets/drop zones, and tap-to-choose targets; touch/pointer/keyboard operable; 44px minimum targets; reduced-motion safe.
2. Compiler-authored check tasks can target them (`responseMode: 'manipulate'` added to the task contract); answers are **machine-checked locally** (e.g. point within tolerance on a number line) for instant feedback with zero model latency; results emit evidence-grade events with correct source lineage and a compact summary to the model — no per-drag model round-trips.
3. Manipulative state persists and replays like all board state; drafts/interruptions follow the existing learner-turn contract.

Acceptance: all gates green; property tests on check tolerance; E2E covering drag-check-feedback and evidence lineage; accessibility suite extended to the new controls.

## Phase 4 — Illustration layer (only after 0–3c are green)

1. `image` ShapeSpec + a generation service (gpt-image family, streaming partials for perceived speed): child-safety prompt constraints, vision validation before display, object storage + cache keyed by normalized purpose/subject, honest "preparing" board state.
2. Illustrations never carry equations, scales, measured geometry, or assessment targets — those are exact BoardOp overlays on top.
3. The Director decides when an illustration (vs diagram) serves the stage; generation failures degrade gracefully to vector/asset alternatives with honest speech.

Acceptance: all gates green; safety/validation path unit-tested with fixture images; cost per illustration logged; feature can be disabled by env flag without dead code paths elsewhere.

## Phase 5 — Evaluation loop

Stand up scripted synthetic lesson runs (offline harness by default; live only with authorization, ≤2 short sessions per change) scoring: reveal-narration coherence, object permanence, turn-latency percentiles, false barge-ins, blueprint quality rubric (strong model as judge with a fixed rubric checked into the repo). Wire the scores into a report script; document the gate in `docs/operations/testing-and-evaluation.md`.

---

## Engineering standards (all phases)

- Tests define behavior: write the failing test first for every behavior change; when an existing test encodes wrong behavior, change it deliberately and say so in the commit message.
- Keep prompt, tool schemas, validators, and docs in sync in the same commit that changes any of them.
- No module over ~400 lines without a recorded reason; extract pure logic from React components and the proxy successor modules.
- Delete superseded code paths once parity is proven — no accumulating feature flags or "legacy_" shims beyond replay compatibility for stored events.
- Never update visual snapshots blindly; inspect every changed baseline.
- Additive migrations only; both repository implementations and the portable export stay in parity (`npm run test:storage`).
- After each phase: run every gate, update `README.md` and the affected ADRs, and write a short handoff note in `docs/architecture/` separating (a) proven offline, (b) requires authorized live verification, (c) deferred.

## Hard boundaries

- Do not deploy, push to remotes, create paid resources, or run live-provider calls without explicit user authorization in this conversation.
- Do not use real child data anywhere.
- Do not weaken the permanence, draft, floor-ownership, or evidence invariants to make a phase easier.
- If a phase's design conflicts with something you discover in the code, stop and write a decision note rather than silently improvising.

## Definition of done

The overhaul is complete when this story is demonstrably true in automated coverage and one authorized synthetic live trace:

> A parent types a rough goal and picks a concrete objective. When the child taps Begin, a pre-compiled lesson opens with a purposeful anchor diagram. Noura explains while the diagram builds piece by piece, each element appearing as she mentions it. Nothing she has drawn ever vanishes. She asks the child to drag a marker onto the number line; the board confirms instantly and Noura reacts to the substance. The child interrupts mid-sentence; Noura stops within a fraction of a second, answers, and resumes the build where it paused. When the child stops talking, Noura replies without an awkward gap. The parent's summary cites real evidence from the session.
