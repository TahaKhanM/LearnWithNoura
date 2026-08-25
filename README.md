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

- `gpt-realtime-2.1` over the existing server-proxied Realtime WebSocket for speech-to-speech;
- `gpt-4o-mini-transcribe` for input transcription;
- `gpt-5.6-terra` through the existing Chat Completions path for captions-only fallback and parent summaries.

GPT-5.6 Sol was the Codex implementation agent used for this repository work. It is not an application dependency and did not trigger a model, endpoint, reasoning-effort, provider or topology migration.

## Architecture

The active path is:

1. Parent setup creates or explicitly selects a learner and a goal.
2. The child taps **Begin**, which owns AudioContext unlock and microphone permission.
3. A versioned event envelope carries session, connection epoch, turn, generation, sequence, provider, audio, visual and idempotency identity.
4. A deterministic lesson reducer owns legal transitions and forbids waiting without a delivered question or task.
5. One `GenerationScope` owns audio, provisional captions, transient visuals, character tasks, timers, reconnect work and fallback cancellation.
6. The PCM sample clock releases phrase captions, semantic visual cues, the pen and character attention.
7. Visual Plan 2.0 decides whether a visual is essential/supportive/unnecessary and whether to create, reuse, replace or skip a named board section.
8. Semantic intent is adapted into exact BoardOps; sections isolate topics, annotations are placed against real geometry and a deterministic quality budget accepts or rejects the checkpoint.
9. Heard, accepted visual checkpoints become the in-memory board immediately; completed draw-on animation acknowledges them for durable replay and agent state.
10. Learner vectors produce calibrated spatial features plus a transient full-board/detail image for Realtime vision.
11. Evidence observations carry source event IDs, normalized source spans, taxonomy, confidence basis, opportunity, independence and turn/generation lineage.
12. Ending creates an immutable event cutoff; continuing creates a new linked session.

See [the active architecture ADR](docs/architecture/2026-08-23-noura-runtime-architecture.md), [Board Intelligence v2](docs/architecture/2026-08-23-board-intelligence-v2.md), [threat model](docs/privacy/threat-model.md) and [traceability matrix](docs/traceability/2026-08-23-noura-traceability.md).

## Phase 0 telemetry and prepared smoke

Privacy-safe observations are validated, pseudonymized with deterministic
session-scoped opaque identifiers and submitted to a bounded ordered
non-blocking writer before storage as released `metric` events in the existing
event log. Local SQLite metric append and reconnect-history lookup execute in a
worker thread; managed Postgres remains natively asynchronous. Identifier
tokens carry server-owned encoding metadata and a session-derived prefix and
ordered `telemetry_gap` barriers preserve the position, reason and value of
known server queue, persistence and browser pre-ready queue loss.
`GET /api/sessions/:id/log` is the
parent-authenticated, parent-owned projection of those released events; it
returns bounded duration aggregates, interruption outcomes,
section/reconnect/disappearance counts, provider token-usage totals, gap totals and a metric-only timeline. The smoke reporter reconstructs the complete
summary from ascending timeline rows before accepting it. The log does not copy
transcripts, evidence text or raw turn/generation/provider/visual/section/
object identifiers.

The Phase 0 timing boundaries are deliberately narrow:

- “First audio” ends when the browser handles the first accepted tutor audio delta for the current response. It is a browser-received boundary, not speaker onset or acoustic evidence.
- `board_reveal_to_narration` is `first scheduled audible sample − first committed board paint` on one browser monotonic clock. Positive means the board appeared first; negative means scheduled narration came first. It is not animation-completion time.

These offline and browser-observer definitions prevent lifecycle regressions, but no live-provider latency or target-hardware acoustic claim has been made.

The live journey is prepared, not authorized or executed by the default gates:

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

The browser suites use synthetic learner fixtures. Paid live-provider runs are not part of the default test commands.

## Interaction and privacy notes

- Pointer, touch, focus, learner-stroke, tutor-pen, caption, semantic-object and interruption signals drive Noura’s gaze.
- Character attention is generation-scoped, bounded, damped, reduced-motion aware and subordinate to the board.
- Camera-responsive behavior is **not implemented**. No lesson needs camera permission. Noura performs no face recognition, biometric processing, emotion inference, attention scoring, engagement scoring or facial comprehension inference.
- Raw audio, pointer trails and camera data are not persisted.
- Realtime audio and transient character/visual work are cancelled locally before provider confirmation; target-hardware acoustic silence remains **UNVERIFIED**.
- Voice interruption requires sustained adaptive microphone energy plus independent server speech-start confirmation. Short noises and server VAD alone do not cancel Noura.
- Confirmed voice interruption temporarily raises semantic endpointing eagerness for that one turn, then restores the normal child-friendly setting. Speech-end-to-response and speech-end-to-audio intervals are recorded separately.
- Released tutor checkpoints finish and remain visible across re-renders and turn changes, then acknowledge durable replay even if interruption happened mid-animation. Learner strokes are committed as learner-owned BoardOps, replay after refresh and send a compressed transient board image to Realtime so Noura can inspect and respond to a board-only turn.
- The server mirrors only released tutor checkpoints and committed learner marks into the agent’s current-board instructions. Teaching-move and drawing tool results return reusable object IDs; exact raw redraws and mostly equivalent semantic scenes are suppressed so questions adapt the visible diagram in place.
- Distinct visual groups are named board sections rather than overlapping layers. Section-scoped clear/replace preserves learner work and the learner can switch earlier sections from the board controls.
- Learner marks send deterministic vector features (shape, closure, direction, bounds, nearest/touched objects) plus one transient composite showing the full section and an enlarged detail. These features are spatial hints, never unverified semantic claims.
- Exact subject templates and general relationship, worked-step, comparison and proportional part–whole grammars all pass through the same geometry solver, crossing checks and section quality budget.
- A single atomic Board status and synchronized item-level signaling orient the learner without moving focus or duplicating the spoken explanation.
- Captions use PCM-timed phrase cues and final transcript correction. The app does not claim provider word timestamps or exact word synchronization.

## Known blockers

- The complete domain repository has synchronous SQLite and asynchronous managed-Postgres implementations. The deployed private Supabase schema and least-privilege app role pass parent/session/event/evidence, immutable-end and fallback-staging contracts.
- Public v0 can issue a long-lived signed pseudonymous guest-parent cookie, while sessions remain parent-scoped and lessons use short-lived signed capabilities. A real external identity provider is still required for full Production.
- In-memory rate limits are a local/Preview layer, not the final multi-instance Production control.
- ZDR/account evidence, legal decisions, retention policy approval, target-hardware audio and real-minor safety evaluation are external gates.
- Native Vercel WebSockets are currently a public beta and connections terminate at Function duration; reconnect is expected.
- Public v0 uses encrypted Supavisor transport with certificate verification disabled because Node does not trust the shared-pooler chain by default. Pinning the Supabase CA remains a full-Production gate.

The historical repository name and local directory are retained intentionally. Immutable historical audit evidence lives under `docs/legacy/`.
