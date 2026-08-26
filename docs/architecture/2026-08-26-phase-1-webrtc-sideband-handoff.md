# Phase 1 handoff — WebRTC voice transport plus server sideband

Date: 2026-08-26. Scope: the approved Phase 1 of the Noura overhaul
(`2026-08-25-noura-overhaul-implementation-prompt.md`), implemented offline on
branch `devin/demo-day-interactive-tutor` from HEAD `aa2ab72`.

## What changed

The server-proxied WebSocket audio path is gone. Voice now runs as a direct
browser ↔ OpenAI WebRTC call (media plane) bootstrapped by the server, with a
server-owned sideband WebSocket to the same call carrying all control. The
Vercel function no longer carries audio. The browser ↔ server runtime envelope
(`/ws/lesson`, `shared/runtimeProtocol.ts` schema `1.0.0`) remains for board,
lesson, caption, task, telemetry, and typed-turn events only.

### Transport and bootstrap design

- `POST /api/webrtc-call?session=…` accepts the browser SDP offer
  (`application/sdp`). Auth mirrors the WS upgrade: the global same-origin
  guard, the short-lived lesson capability (`Authorization: Lesson …`, child
  bound), and a per-parent/session/IP rate limit (10/min). The server calls
  `POST https://api.openai.com/v1/realtime/calls` with the API key, reads
  `call_id` from the `Location` header, opens
  `wss://api.openai.com/v1/realtime?call_id=…`, applies the full session
  configuration **before** returning the SDP answer (so provider defaults never
  own a turn), and persists `voice_call { callId }` as a released event in the
  session log. The API key never reaches the browser.
- The configured sideband socket is stashed in an in-process
  `SidebandRegistry`. The envelope connection that follows adopts it (with
  buffered provider frames replayed in order) instead of opening a second
  socket. Any later connection — another process, a Vercel recycle — reattaches
  by the persisted `call_id` and reapplies the session configuration
  idempotently. `call_id` persistence reuses the existing event log; no schema
  migration was needed (additive event type only), so SQLite/Postgres/portable
  export parity is automatic.
- The client's `WebRtcVoiceTransport` (`src/lesson/voiceTransport.ts`) owns
  `RTCPeerConnection`, the mic track (`echoCancellation`, `noiseSuppression`,
  `autoGainControl` all true), native remote-track playback, WebAudio analysers
  for mic and voice energy, and the `oai-events` data channel for
  `output_audio_buffer.started/stopped/cleared`. A typed `VoiceTransport`
  interface has a deterministic `FakeVoiceTransport` for vitest and a
  page-injected fake for Playwright (`window.__nouraVoiceTransport`, consumed
  only when a test installs it).

### Cue binding decision

Playback boundaries were chosen over sideband response-lifecycle events for
board/task binding because they mark what the child has actually heard on the
real audio path; `response.done` on the sideband arrives when generation
finishes, typically well before playback does. Concretely:

- Captions release on transcript-delta arrival with phrase smoothing; the final
  transcript correction applies when the response finishes playing.
- Visual checkpoints, semantic lesson state, and `learner_task` delivery are
  tagged with their provider response id and held by the client's
  `ResponseCueTimeline` only while that response is audibly playing; the
  provider's `stopped`/`cleared` boundary releases them. A response that is not
  playing (tool-first plans before speech, no-audio responses, retired
  playback) releases immediately — this keeps the server's fail-closed
  visibility barrier (`ops_shown`) live, because plan tools resolve before the
  narration starts.
- The client relays stop boundaries (`playback_boundary`, with heard
  milliseconds) over the envelope; the server records
  `tutor_audio_output_duration` once per response from that trusted-identity
  event and uses the heard duration for `conversation.item.truncate` on
  barge-in. Start boundaries are a local clock signal and are not relayed.
- The PCM sample clock is deleted: `src/lesson/audioIn.ts`,
  `src/lesson/audioOut.ts`, `server/realtime/segmentAnnotator.ts`, and the
  `audioSampleOffsets` envelope field no longer exist.

### Interruption and endpointing

- Dual confirmation is unchanged in meaning: ~280 ms of sustained mic energy
  above the adaptive noise floor (now read from a WebAudio analyser on the live
  mic stream) plus an independent provider `speech_started`. Phase 0's
  `barge_in_gate_outcome` telemetry (including the no-subsequent-transcript
  probable-false-positive annotation) is preserved.
- Confirmed barge-in: mute the remote track, send `output_audio_buffer.clear`
  on the data channel, cancel the response and truncate the spoken item at the
  heard duration on the sideband, raise `semantic_vad` eagerness to `high` for
  that turn only.
- Adaptive eagerness: a delivered task whose `responseMode` expects a short
  voice answer sets `high`; drawing tasks and ordinary turns keep `medium`.
  Near-field `noise_reduction` is part of the session configuration.

### Reconnect and fallback

- An envelope/sideband reconnect never stops WebRTC playback (proven by a
  client test); the server reattaches the same call by persisted `call_id` and
  restores floor, blueprint, board ledger, and the delivered task (proven by
  `sidebandAttach.test.ts`). Only the terminal captions-only fallback
  transition silences residual audio.
- A failed peer connection or denied microphone degrades to captions — the
  envelope still carries transcripts and typed turns; a session with no
  bootstrapped call at all lands on the REST captions-only fallback
  (`server/fallbackTutor.ts`), which is unchanged, as is the board submission
  fallback.

## Provider-fact verification and deviations

Checked offline against the installed `openai` npm package types
(`realtime/calls` resource: `create(params: CallCreateParams & { sdp: string })`
returning an SDP body, `accept/refer/hangup`; `OpenAIRealtimeWebSocket` URL
shape `wss://api.openai.com/v1/realtime?call_id=…` with
`Authorization: Bearer` header):

- The SDP offer is posted as `Content-Type: application/sdp` with
  `model` as a query parameter, matching the unified-interface documentation,
  rather than multipart form data. The SDK types show `sdp: string` plus call
  params; the raw-SDP body form is the documented browser flow. If a live run
  rejects it, the multipart form (`sdp` field) is the one-line fallback in
  `server/realtime/callBootstrap.ts`.
- `call_id` is read strictly from the `Location` header
  (`/v1/realtime/calls/{id}`); a response without it fails the bootstrap
  closed rather than guessing.
- `output_audio_buffer.*` events are consumed permissively (only `type` and
  `response_id` are read), so payload additions cannot break the client.

No deviation required a behavior change; no decision note beyond this section
was necessary.

## Module map (server/realtime after decomposition)

| Module | Lines | Responsibility |
| --- | --- | --- |
| `proxy.ts` | 404 | Transport sockets, ordered work queues, lifecycle/teardown |
| `coordinatorContext.ts` | 121 | Shared state + wiring contract for all modules |
| `callBootstrap.ts` | 216 | `/v1/realtime/calls` bootstrap, `call_id` persistence, `SidebandRegistry` |
| `sessionConfig.ts` | 53 | Session configuration payloads, sideband URL |
| `sessionRestore.ts` | 151 | Connect/reconnect state restoration |
| `turnFloor.ts` | 80 | Sole `response.create` ownership, eagerness updates |
| `toolHandling.ts` | 458 | All realtime tool calls (see below) |
| `boardStaging.ts` | 191 | Plan staging, preflight, visibility barrier |
| `upstreamEvents.ts` | 219 | Provider event dispatch |
| `clientEvents.ts` | 311 | Envelope event dispatch |
| `telemetryGlue.ts` | 117 | Telemetry recording incl. client playback stops |
| `responseRegistry.ts` | 22 | Response→generation identity mapping |
| `lifecycle.ts` | 152 | Proxy lifecycle tracking for shutdown |

`toolHandling.ts` exceeds the ~400-line guideline deliberately: it is one
exhaustive switch over the seven realtime tools whose arms are self-contained
(validate → persist → reply); splitting per-tool files would scatter the shared
`finishTool`/identity helpers without reducing any single unit of complexity.

Client: `voiceTransport.ts` (271), `fakeVoiceTransport.ts` (82),
`responseTimeline.ts` (77), `voiceInterruption.ts` (95, unchanged gate
semantics), `realtimeSession.ts` (1,049 — the pre-existing session owner; its
size predates this phase and shrank with the audio deletion).

## Proven offline

- All completion gates green at final HEAD (build, server typecheck, lint,
  unit, integration, e2e, visual, a11y, security, storage, brand,
  runtime-models, smoke-report, audit).
- Sideband semantics: sole `response.create` ownership, immediate
  response-tagged cues without sample offsets, truthful truncation from client
  heard duration, once-only audio-duration telemetry, eagerness raising for
  voice tasks and restoration afterwards, late-event rejection for cancelled
  responses.
- Bootstrap: SDP round-trip against a stubbed provider, capability/origin/rate
  rejection paths, `call_id` persistence, registry adoption with buffered-frame
  replay, no-duplicate session configuration on adoption, reattach-by-call-id
  on reconnect with floor/blueprint/board/task restoration.
- Client: playback-bound cue release (captions live, visuals/state/task held),
  immediate release for non-playing responses, barge-in dual confirmation with
  heard-duration interrupt, sideband reconnect without stopping playback,
  stale-identity rejection, captions-only degradation.
- Full loop: raw provider event permutations → sideband coordinator → real
  envelopes → real `RealtimeSession` under the fake transport
  (`proxySession.integration.test.ts`).

## Requires authorized live verification

Stated plainly: **the product claims that motivated Phase 1 — lower voice
latency and fewer false interruptions — are not proven by this offline work.**
A live, explicitly authorized run must verify:

- The `/v1/realtime/calls` request/response shape (SDP body vs multipart) and
  the `Location` header `call_id`.
- Real WebRTC negotiation, remote-track playback, and hardware echo
  cancellation / AEC behavior with a child-distance microphone.
- `output_audio_buffer.*` timing fidelity against audible playback.
- End-to-end latency distribution (`ask_to_first_audio`,
  `speech_end_to_first_audio`) versus the Phase 0 baseline.
- Sideband behavior across a real Vercel 300 s function recycle.

## Deferred

- ICE restart/renegotiation: a failed peer connection currently degrades to
  captions with a visible notice (never a silent hang) instead of
  renegotiating. Documented degradation per the phase prompt.
- TURN configuration: no ICE servers are configured; restrictive-NAT learners
  fall back to captions. Needs a live decision on infrastructure.
- Sideband keepalive/ping tuning and multi-region adoption (the registry is a
  same-instance fast path; cross-instance reattach already works via
  `call_id`).
- Mic-denied lessons currently reach captions via the envelope; a denied mic
  no longer blocks the envelope connection, but no dedicated "voiceless
  envelope" mode was added beyond the existing fallback ladder.
