# Noura

Noura is a voice-first interactive tutor that leads a child through one small teaching objective at a time, speaks naturally, builds exact educational visuals, listens for interruption and gives a parent an evidence-linked account of what happened.

Canonical production origin: [https://learnwithnoura.com](https://learnwithnoura.com)

## Readiness boundary

| Environment | Intended use | Current status |
| --- | --- | --- |
| Local | Synthetic development and private single-host demonstrations | Supported with SQLite; microphone/acoustic targets remain hardware-unverified. |
| Vercel Preview | Access-gated synthetic UI and visual-fixture evaluation | Protected at `noura-preview-mtk2982007.vercel.app`; interactive lessons are disabled because storage is ephemeral and `/healthz` reports degraded. |
| Public v0 | Full-product synthetic demonstrations | Live at `learnwithnoura.com`. Real voice/WSS, confirmed-speech interruption, persistent tutor/learner board, Realtime image grounding, fallback/tools, evidence, managed Postgres, immutable ending and Parent summary passed deployed synthetic smoke at revision `563f4c3`. |
| Full Production | Real parent/child use | Still blocked fail-closed until real parent authentication is selected, privacy/safety operations are configured and ZDR evidence exists for any under-13 mode. |

Do not use real child details, recordings or transcripts in the current build. Noura does not claim legal compliance or production child readiness.

## Runtime model boundary

The application runtime baseline remains unchanged:

- `gpt-realtime-2.1` for speech-to-speech, carried on a direct browser ↔ provider WebRTC call whose control lives on a server-owned sideband WebSocket to the same call;
- `gpt-4o-mini-transcribe` for input transcription;
- `gpt-5.6-terra` through the existing Chat Completions path for captions-only fallback, parent summaries, the session-creation lesson compiler (`NOURA_COMPILER_MODEL`, reasoning effort `NOURA_COMPILER_REASONING_EFFORT`, default `medium`) and the live Board Director for mid-lesson scene requests (`NOURA_DIRECTOR_MODEL`, reasoning effort `NOURA_DIRECTOR_REASONING_EFFORT`, default `medium`);
- `gpt-image-1.5` (`NOURA_ILLUSTRATION_MODEL`) for Director-chosen educational illustrations. Set `NOURA_ILLUSTRATIONS=off` to disable the path; the Director then authors vector/asset diagrams only.

GPT-5.6 Sol was the Codex implementation agent used for this repository work. It is not an application dependency and did not trigger a model, endpoint, reasoning-effort, provider or topology migration.

## Architecture

The active path is:

1. Parent setup creates or explicitly selects a learner and a goal. Session creation normalizes the goal (a vague goal returns 2–3 candidate objectives for the parent to pick) and compiles the complete lesson ahead of the call: a strong reasoning model authors the blueprint: stages, success criteria, exact check questions, misconception branches: plus, for board-led lessons, an anchor scene and storyboard pre-validated through the real board pipeline in headless Chromium. The lesson page shows an honest preparing state until the compiled lesson is ready; a lesson never starts on an uncompiled goal.
2. The child taps **Begin**, which owns microphone permission and bootstraps the voice call: the browser posts its WebRTC SDP offer to the server, which creates the provider call with the API key, attaches its control sideband, applies the full session configuration and returns only the SDP answer. Tutor audio arrives as a remote media track; no PCM transits the server.
3. A versioned event envelope (browser ↔ server WebSocket, control only: never audio) carries session, connection epoch, turn, generation, sequence, provider, visual and idempotency identity.
4. A deterministic lesson reducer owns legal transitions and forbids waiting without a delivered question or task. The realtime model executes the pre-compiled blueprint stage by stage: it never authors the lesson live.
5. One `GenerationScope` owns playback binding, provisional captions, transient visuals, character tasks, timers, reconnect work and fallback cancellation.
6. Captions release on transcript arrival with phrase smoothing; board reveals, semantic state, task delivery and truncation bind to the provider's real playback boundaries (`output_audio_buffer.started/stopped/cleared` on the WebRTC data channel).
7. The drawing brain is two-tier. Fast tier: the voice model keeps direct `board_ops` increments (highlight, small extensions on visible objects), sub-second. Slow tier: full new scenes are requested by INTENT only (`request_visual`); the `establish` action resolves to the pre-compiled anchor and other new scenes are designed live by the Board Director: a multimodal reasoning model that sees the rendered board, proposes add-only BoardOps plus a storyboard, is validated through the real client pipeline in headless Chromium, vision-checks its own rendered candidate and fails closed after two correction rounds. While the Director works, the tutor keeps teaching with what is visible.
8. Every storyboard-bearing scene plays through one interleaved reveal-narrate engine: each step is revealed at the previous response's real playback boundary, narrated by a beat response with per-response instructions scoped to exactly that step and the stage's check/task is handed over through the existing delivered-task contract after the final step. A barge-in pauses the build (revealed objects stay: permanence) and the run resumes at the first unrevealed step; progress is persisted and restored across reconnects. Board sections are spatial camera regions on one logical canvas (the learner can pan back; nothing is filtered out of the scene). The Director and Lesson Compiler may emit tutor arcs, cubic curves, handwritten Caveat notes, curated local icons, generated illustrations (`image`, server-issued `assetId` only: labels, numbers and equations stay exact BoardOp overlays) and interactive manipulatives (`draggable`, `snapZone`, `tappable`); the voice model's fast-tier `board_ops` path does not. Guided checks may use `responseMode: manipulate`: the child moves or taps board widgets, the browser machine-checks the result locally on Done and one compact summary (plus an optional revision-bound snapshot) reaches the model: no per-drag round trips. Annotations are placed against real geometry and a deterministic quality budget accepts or rejects every checkpoint.
9. Heard, accepted visual checkpoints become the in-memory board immediately; completed draw-on animation acknowledges them for durable replay and agent state.
10. Learner vectors produce calibrated spatial features plus a transient full-board/detail image for Realtime vision.
11. Evidence observations carry source event IDs, normalized source spans, taxonomy, confidence basis, opportunity, independence and turn/generation lineage.
12. Ending creates an immutable event cutoff; continuing creates a new linked session.

See [the active architecture ADR](docs/architecture/2026-08-23-noura-runtime-architecture.md), [Board Intelligence v2](docs/architecture/2026-08-23-board-intelligence-v2.md), [threat model](docs/privacy/threat-model.md) and [traceability matrix](docs/traceability/2026-08-23-noura-traceability.md).

## Phase 0 telemetry and controlled smoke

Privacy-safe observations are validated, pseudonymized with deterministic
session-scoped opaque identifiers and submitted to a bounded ordered
non-blocking writer before storage as released `metric` events in the existing
event log. Local SQLite metric append and reconnect-history lookup execute in a
worker thread; managed Postgres remains natively asynchronous. Identifier
tokens carry server-owned encoding metadata and a session-derived prefix and
fixed per-reason `telemetry_gap` counters preserve exact totals for known server
queue, persistence, history, accounting and browser pre-ready loss. Gap rows
are completeness evidence, not chronology evidence under saturation.
`GET /api/sessions/:id/log` is the
parent-authenticated, parent-owned projection of those released events; it
returns bounded duration aggregates, interruption outcomes,
section/reconnect/disappearance counts, provider token-usage totals, gap totals and a metric-only timeline. The smoke reporter reconstructs the complete
summary from ascending timeline rows before accepting it. The log does not copy
transcripts, evidence text or raw turn/generation/provider/visual/section/
object identifiers.

The Phase 0 timing boundaries are deliberately narrow:

- “First audio” ends when the browser handles the provider’s `output_audio_buffer.started` playback boundary for the current response on the WebRTC data channel. It is a browser-received boundary, not speaker onset or acoustic evidence.
- `board_reveal_to_narration` is `playback-start boundary − first committed board paint` on one browser monotonic clock. Positive means the board appeared first; negative means narration started first. It is not animation-completion time.
- Tutor audio duration is the browser-reported heard duration relayed as a `playback_boundary` envelope event, recorded once per response.

These offline and browser-observer definitions prevent lifecycle regressions.
One authorized synthetic Preview session produced provider usage and duration
observations, but no live-provider latency distribution or target-hardware
acoustic claim has been made.

The live journey is never authorized or executed by the default gates:

```bash
npm run test:smoke-report
# DO NOT RUN without explicit deployment and live-provider authorization:
NOURA_BASE_URL=https://authorized-origin.example npm run e2e:live -- --authorized-live-run --text-only
```

`NOURA_BASE_URL` must be an HTTP(S) origin only: no credentials, non-root path,
query or fragment. The reporter reads `/api/version` and the parent-scoped
session log through the still-authenticated browser context, requires the
navigated origin/session/schema to match and projects exact hand-written
allowlists rather than copying endpoint objects. Provider evidence requires
safe positive, internally consistent usage rows whose sum equals the summary.
It reports runtime model IDs, exact logged tutor-audio duration,
provider-reported token usage projected from `response.done`, exact Phase 0
aggregates, bounded caption/learner/console counts, hardcoded milestones and
unresolved verification items. Retained reports contain no raw caption,
learner, identifier, browser-console, credential or query text. A truncated
session log, missing/malformed provider usage, mismatch or any telemetry gap
fails the gate. `NOURA_PROVIDER_REPORTED_COST_USD` is optional user-supplied USD
copied from the provider billing surface; the provider event does not supply a
currency charge and the script never invents one. `--report-fixture <path>`
and `npm run test:smoke-report` exercise report construction offline and never
establish live-provider evidence. Do not run the normal journey, deploy or
make paid/provider calls without explicit authorization.

For an access-gated `*.vercel.app` deployment, an explicitly authorized
operator may supply Vercel's 32-character automation secret through
`NOURA_VERCEL_PROTECTION_BYPASS`. The harness exchanges it server-side for the
host-bound `_vercel_jwt` cookie before opening a page; the raw secret is not
placed on browser requests or copied into reports. The temporary secret must be
revoked after the run.

The August 26 authorized exercise proved one provider-backed lesson and its
complete, gap-free parent-scoped telemetry log, but did not produce one
uninterrupted passing reporter run because the deployed nested log adapter was
missing during that lesson. The adapter is now present in the codebase and
offline gates are green. Exact evidence and remaining limits are recorded in the
[Phase 0 telemetry handoff](docs/architecture/2026-08-25-phase-0-telemetry-handoff.md).

Gap accounting makes known loss visible but is not an end-to-end delivery
guarantee. If a browser connection never reaches another accepted `ready` or a
fallback/failed transport never recovers, final browser observations can be
lost before their aggregate gap is delivered; that run cannot prove telemetry
completeness.

## Local setup

Requires Node.js 24+.

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:5173`.

The provider key stays server-side. The Vite client proxies `/api` and `/ws` to the local backend. Noura self-hosts Outfit and Caveat font assets through the build.

### Local database migration

The active default is `data/noura.db`. On first use, if that file is absent and the historical database exists, Noura:

1. checkpoints the WAL;
2. runs SQLite integrity checks;
3. records table row counts;
4. creates a verified backup;
5. copies to a migration candidate;
6. compares integrity and row counts;
7. atomically renames the verified candidate.

The old database is retained. `NOURA_DATA_DIR` is preferred; the historical environment alias is supported for one documented migration window only. Database files remain ignored.

## Verification commands

```bash
npm run build
npm run typecheck:server
npm run lint
npm run test:smoke-report
npm test
npm audit --omit=dev
npm run test:integration
npm run test:e2e
npm run test:visual
npm run test:a11y
npm run test:security
npm run test:storage
npm run test:brand
```

`npx vercel@latest build` is the deployment build gate. The installed global CLI predates Vercel’s native WebSocket public beta, so deployment work uses the current CLI without changing the global installation.

The browser suites use synthetic learner fixtures. Paid live-provider runs are not part of the default test commands. The Playwright servers set `NOURA_LESSON_COMPILER=fixture`, so a locally configured provider key never triggers live lesson-compilation calls from a test run; production startup refuses that flag.

## Interaction and privacy notes

- Pointer, touch, focus, learner-stroke, tutor-pen, caption, semantic-object and interruption signals drive Noura’s gaze.
- Character attention is generation-scoped, bounded, damped, reduced-motion aware and subordinate to the board.
- Camera-responsive behavior is **not implemented**. No lesson needs camera permission. Noura performs no face recognition, biometric processing, emotion inference, attention scoring, engagement scoring or facial comprehension inference.
- Raw audio, pointer trails and camera data are not persisted.
- On barge-in the remote tutor track is muted and the provider’s buffered audio is cleared locally before provider confirmation; target-hardware acoustic silence remains **UNVERIFIED**.
- Voice interruption requires sustained adaptive microphone energy (a WebAudio analyser on the live mic stream) plus independent server speech-start confirmation. Short noises and server VAD alone do not cancel Noura.
- Confirmed voice interruption temporarily raises semantic endpointing eagerness for that one turn, then restores the normal child-friendly setting. Speech-end-to-response and speech-end-to-audio intervals are recorded separately.
- Released tutor checkpoints finish and remain visible across re-renders and turn changes, then acknowledge durable replay even if interruption happened mid-animation. Learner strokes are committed as learner-owned BoardOps, replay after refresh and send a compressed transient board image to Realtime so Noura can inspect and respond to a board-only turn.
- The server mirrors only released tutor checkpoints and committed learner marks into the agent’s current-board instructions. Teaching-move and drawing tool results return reusable object IDs; exact raw redraws and mostly equivalent semantic scenes are suppressed so questions adapt the visible diagram in place.
- Distinct visual groups are spatial camera regions on one logical canvas. Each region keeps its local 1000×600 coordinates; the camera pans between them on announced navigation (tabs, arrows, “Open it” or a task that names a region). Section-scoped snapshots and quality stay region-local. Learner marks inherit the region they were drawn in.
- Learner marks send deterministic vector features (shape, closure, direction, bounds, nearest/touched objects) plus one transient composite showing the full section and an enlarged detail. These features are spatial hints, never unverified semantic claims.
- Exact subject templates and general relationship, worked-step, comparison and proportional part–whole grammars all pass through the same geometry solver, crossing checks and section quality budget.
- A single atomic Board status and synchronized item-level signaling orient the learner without moving focus or duplicating the spoken explanation.
- Captions release on transcript arrival with phrase smoothing and final transcript correction. The app does not claim provider word timestamps or exact word synchronization.

## Known blockers

- The complete domain repository has synchronous SQLite and asynchronous managed-Postgres implementations. The deployed private Supabase schema and least-privilege app role pass parent/session/event/evidence, immutable-end and fallback-staging contracts.
- Public v0 can issue a long-lived signed pseudonymous guest-parent cookie, while sessions remain parent-scoped and lessons use short-lived signed capabilities. A real external identity provider is still required for full Production.
- In-memory rate limits are a local/Preview layer, not the final multi-instance Production control.
- ZDR/account evidence, legal decisions, retention policy approval, target-hardware audio and real-minor safety evaluation are external gates.
- Native Vercel WebSockets are currently a public beta and connections terminate at Function duration; reconnect is expected.
- Public v0 uses encrypted Supavisor transport with certificate verification disabled because Node does not trust the shared-pooler chain by default. Pinning the Supabase CA remains a full-Production gate.

The historical repository name and local directory are retained intentionally. Immutable historical audit evidence lives under `docs/legacy/`.
