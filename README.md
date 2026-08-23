# Noura

Noura is a voice-first interactive tutor that leads a child through one small teaching objective at a time, speaks naturally, builds exact educational visuals, listens for interruption and gives a parent an evidence-linked account of what happened.

Canonical production origin: [https://learnwithnoura.com](https://learnwithnoura.com)

## Readiness boundary

| Environment | Intended use | Current status |
| --- | --- | --- |
| Local | Synthetic development and private single-host demonstrations | Supported with SQLite; microphone/acoustic targets remain hardware-unverified. |
| Vercel Preview | Access-gated synthetic evaluation | Project linked and configuration present; Preview verification is recorded in the deployment runbook. Storage is ephemeral and `/healthz` reports degraded. |
| Production | Real parent/child use | Blocked fail-closed until managed Postgres is wired into the domain repository, real parent authentication is selected, privacy/safety operations are configured and ZDR evidence exists for any under-13 mode. |

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
7. Semantic visual intent is adapted into exact BoardOps, inspected, repaired once and otherwise rejected as one transaction.
8. Only completed visual checkpoints become committed and replayable.
9. Evidence observations carry source event IDs, normalized source spans, taxonomy, confidence basis, opportunity, independence and turn/generation lineage.
10. Ending creates an immutable event cutoff; continuing creates a new linked session.

See [the active architecture ADR](docs/architecture/2026-08-23-noura-runtime-architecture.md), [threat model](docs/privacy/threat-model.md) and [traceability matrix](docs/traceability/2026-08-23-noura-traceability.md).

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
- Captions use PCM-timed phrase cues and final transcript correction. The app does not claim provider word timestamps or exact word synchronization.

## Known blockers

- The Postgres adapter passes an offline contract, but Production domain services still use the synchronous local repository. Production therefore fails closed.
- Parent identity has a signed-cookie adapter boundary, session objects are parent-scoped and lessons use short-lived signed capabilities; a real external identity provider is not configured.
- In-memory rate limits are a local/Preview layer, not the final multi-instance Production control.
- ZDR/account evidence, legal decisions, retention policy approval, target-hardware audio, deployed persistence and real-minor safety evaluation are external gates.
- Native Vercel WebSockets are currently a public beta and connections terminate at Function duration; reconnect is expected.

The historical repository name and local directory are retained intentionally. Immutable historical audit evidence lives under `docs/legacy/`.
