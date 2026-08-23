# Live Interactive Tutor — Architecture Decisions

Date: 2026-08-22. Branch: `devin/demo-day-interactive-tutor`.

## Baseline (before this work)

- React + Vite frontend, Express backend. Turn model: typed/push-to-talk STT
  (ElevenLabs Scribe) → `POST /api/tutor` → chat-completions tool loop
  (`gpt-5.6-terra`) → NDJSON steps → client plays steps, speaking each chat
  line via ElevenLabs TTS.
- Board: fixed 1000×600 SVG, raw model-authored coordinates, three primitives
  (line, ellipse, text). Learner pen/text/erase with object ownership.
- Baseline verification: 64 unit tests, lint, both typechecks, build — all
  green.
- Strengths worth keeping: visual identity (dry-erase palette, Outfit/Caveat,
  ruled board), draw-on stroke animation, learner ownership model, NDJSON
  streaming pattern, server-side key handling.
- Structural weaknesses: no live voice loop (record → wait → reply), no
  barge-in while the tutor speaks (input disabled during playback), stale
  streams never aborted server-side, three primitives can't express graphs /
  angles / equations / processes, raw coordinates produce overlap, no learner
  memory, no parent surface.

## Decision A — Voice: native speech-to-speech (OpenAI Realtime), proxied

Measured on 2026-08-22 with the project's real keys:

| Candidate | Evidence |
| --- | --- |
| ElevenLabs half-cascade (existing) | Free tier: 10,000 chars/month, TTS TTFB ~2.4s. Cannot carry a live demo. **Rejected.** |
| `gpt-realtime-2.1-mini` | First audio ~3.2s; explanation quality noticeably worse (narrates its own drawing, muddled reasoning). **Rejected.** |
| `gpt-realtime-2.1` (WS) | First audio ~0.9–1.4s from connect; natural speak→draw→speak rhythm with interleaved `board_ops` tool calls on the first try; `response.cancel` acknowledged in ~150–170ms; `semantic_vad` + input transcription (`gpt-4o-mini-transcribe`) accepted. **Selected.** |

Topology: browser ↔ **our Express WS proxy** ↔ OpenAI Realtime.

- API key never leaves the server (stronger than ephemeral browser tokens).
- The proxy sees every event, so session events / evidence are recorded
  server-side from the same stream the child hears — one source of truth for
  the child UI and the parent dashboard.
- Client plays PCM via Web Audio with a sample-accurate playback clock:
  - local interruption = stop the source node (immediate, no network wait),
  - board ops and captions are released when the playback clock reaches the
    moment in speech where the model emitted them (generation runs ahead of
    playback), giving tight speech↔drawing sync without provider word
    timestamps.
- On barge-in the client also truncates the assistant item
  (`conversation.item.truncate`) so the model knows what the child actually
  heard.

Fallback ladder (each degrades honestly):
1. Realtime + mic → full voice loop.
2. Realtime + mic denied → text input, spoken replies still stream.
3. No realtime (bad/missing key, disconnect) → text pipeline via chat
   completions emitting the same board DSL; captions only, no fake audio.

## Decision B — Visuals: semantic ops → deterministic compiler → SVG

Candidates considered:

- **Excalidraw**: hand-drawn aesthetic for free, but a full editor bundle,
  no native incremental draw-on animation (elements pop in), and a heavy
  migration away from working learner-stroke/ownership code. Rejected on
  migration risk vs. benefit.
- **Mermaid/Graphviz adapters**: good for one diagram family each, not for a
  general teaching board, no incremental animation. Rejected as the core.
- **Text-to-image**: unusable for precise, editable, synchronized teaching
  visuals. Rejected outright (per product constraints).
- **Semantic scene DSL + deterministic geometry/layout + existing SVG
  renderer, extended**: keeps the proven draw-on animation and ownership
  model, gives exact arcs/axes/plots/equations computed by code rather than
  by the model, supports stable IDs for highlight/update/erase. **Selected.**
  Validated across four domains (geometry, process, quantitative graph,
  non-STEM concept) in the renderer harness — see verification notes in the
  PR.

DSL (validated server-side before reaching the board): `add` (line, polygon,
circle, ellipse, point, angle, text, equation/KaTeX, label-anchored-to-target,
axes, plot(expr|points), bars, numberline, box, connector, table), `update`,
`highlight`, `erase`, `clear`. The model supplies semantic intent and rough
placement; code computes arcs, arrows, ticks, function sampling (safe
expression parser — no eval), label anchoring, wrapping, bounds clamping and
overlap nudging (render-inspect-repair on the client).

## Persistence

`node:sqlite` (built into Node 24 — verified working) in `data/seneca.db`,
gitignored. Children, sessions, session events, evidence. Local demo:
durable across restarts. A deployed serverless preview would need a managed
DB; documented as a limitation.

## Turn discipline (what makes interruption feel instant)

- The client runs an energy gate on the echo-cancelled mic stream: clear
  speech over the tutor's voice stops playback locally (measured ≤1ms)
  before the server's semantic VAD confirms (~150–170ms).
- Every audio delta, caption delta, and board-op batch carries its
  response id; a killed response's late events are dropped on arrival.
- Board ops are stamped with "how much audio existed when the model said
  this" and released when the playback clock reaches that point, so marks
  land with the words about them — and unreleased marks die with the
  interruption.
- Board-op events persist as *unreleased* until the client confirms the
  child saw them; a refresh replays exactly what was on screen (verified:
  a stormy session replayed 4/4 items where the naive log held 10).
- Truncation reports the exact heard milliseconds per spoken item, so the
  model's memory matches the child's ears.

## Fallback ladder (all paths exercised in a real browser)

1. Realtime + mic → full voice loop.
2. Mic denied → typing in, voice out. UI says the mic is blocked.
3. Upstream failing → 4 reconnect attempts → labelled captions-only text
   mode over HTTP, same board language, same session store.
4. No API key → home screen refuses to start lessons, with instructions.

## Measured results (local, 2026-08-23)

- Typed ask → first audible audio: **750ms** (session metric).
- Start pressed → first caption: **2.4–3.5s** across e2e runs.
- Spoken barge-in (synthesized-speech fake mic) → local silence:
  **≤1ms**; item truncated at the exact heard offset (e.g. 6477ms).
- Realtime probe: first audio ~0.9–1.4s from connect; `response.cancel`
  acknowledged in ~150–170ms.

## Unseen-topic matrix (run through the real pipeline, screenshots kept)

| Topic | Result |
| --- | --- |
| Triangle angle sum (spoken barge-in run) | Triangle + angle arcs + straight-line reference; adapted after interruption; evidence recorded |
| Reading a line graph | Real axes, ticks, plotted data with dots, labels |
| Water cycle | Box/label process build-up (connectors arrive as the flow is narrated) |
| Metaphor vs simile | Colour-coded side-by-side comparison boxes |
| Three quarters | Chocolate-bar fraction model, shaded 3 of 4 |
| "Why is it brave to admit a mistake?" (no natural diagram) | Chose a small box-flow structure instead of forcing a picture |

## Out of scope (clean seams left)

WhatsApp/notifications (event boundary = session summary row), billing,
real auth, curriculum graph, 3D avatar.
