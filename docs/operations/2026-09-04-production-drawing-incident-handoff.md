# Production drawing incident handoff

**Date:** 2026-09-04

**Branch:** `codex/noura-next-development`

**Fix revision:** `509564cd8866bda436beeb38aff2be624ba9b369`

**Incident deployment:** `dpl_Gn7As8XjzZv7vcZoRKowGp1UAofh` (`08a8ace27b5db10cc104c6d484b4f3be70e25eef`)

**Production deployment:** `dpl_XAErTxXTjmqAwbuhH5AioDQ9nj4f`

**Rollback target:** `dpl_AbnroCy4guyi7Q4vZbh7mJxg8ZXZ` (`2ce3e0bf4a7c7ac85adfaf6f89e0b41bcf2e878d`)

## Owner decisions

- Phase 0: leave the broken, login-gated deployment available during the
  investigation rather than roll back immediately.
- Post-fix provider smoke: declined; the owner will test personally.
- Required consequence: Production was deployed with
  `NOURA_DIRECTOR_PIPELINE=classic`. Streaming must not be restored until a
  freshly itemized provider smoke is explicitly authorized and passes.

## Decisive production evidence

The production Postgres query used `noura_app` through the pooled URL with
`default_transaction_read_only=on`, `BEGIN READ ONLY`/SELECT-only semantics,
short statement/lock timeouts, and exact session scope
`350f7a79-857d-4d81-920b-b29d3d49ee0b`. No transcript or BoardOps payload was
written to the repository.

Canonical transcript-free evidence summary SHA-256:
`c11b6c8f9b45245f54d81d40e237d33b4f96458227a73c6b5cebd3f3300ae405`.

| Evidence | Result |
| --- | --- |
| Event range | IDs `1172–1200`, 29 events |
| Persisted types | `voice_call` 1; `learner_said` 4; `tutor_said` 4; `lesson_state` 1; `learner_task` 2; `session_started` 1; `metric` 15; `interrupted` 1 |
| Visual ingress/outcome types | 0 across `learner_visual_request`, `visual_request_outcome`, `board_tool_outcome`, `directed_scene`, `storyboard_progress`, `semantic_scene`, `board_rejected`, and `board_ops` |
| Visual/audit metrics | 0; the 15 metrics were speech latency, provider usage, barge-in, audio duration, and media playback only |
| Compiled lesson | ready, `board_led`, anchor and anchor scene present; first stage `orient` / `establish_anchor` / mutation `establish` |

**Classification: B1 — no visual tool call reached the visual pipeline.**
Persistence was working, so this was not B4. No run, step, render, visibility,
or audit marker existed, so there was no evidence for B3. Ordinary lesson
tool outcomes were persisted while the required `request_visual` was absent.

## Root cause and fix

The Realtime tool surface still advertised `request_visual`, and the
adoption-miss reattach path still reapplied the full session configuration.
The prompt contained relevant rules in several sections, but the opening
anchor obligation was not expressed as one mandatory same-response gate. In
the incident, the voice model proceeded into lesson-state/question tools
without requesting the ready compiled anchor.

Revision `509564c`:

- adds a mandatory opening sequence for an unshown `establish_anchor`: one
  short greeting, then same-response `request_visual(establish)`, before a
  substantive explanation, `propose_teaching_move`, or learner question;
- pins that rule in `promptConsistency.test.ts` and verifies the real
  cross-lambda adoption-miss reattach sends both the prompt gate and tool;
- adds bounded, one-line, credential-scrubbed structured logging for proxy
  setup/upstream errors, storyboard abandonment/timeout/rejection, the three
  structural tool rejections, audit-gate rejection, and null client rasters;
- verifies a null audit raster releases the storyboard and never turns the
  advisory vision audit into hard authority.

No permanence, draft-until-Done, deterministic validation, replay,
server-key, PII, migration, tool-schema, or pipeline-selection invariant was
weakened. The M5 live-coordinator candidate-raster defect was not changed
because the production evidence was B1, not B3-audit.

## Test and build evidence

- Failing-first observability run: 8 new assertions failed; 94 existing tests
  passed. Failing-first opening-gate run: 1 new assertion failed; 13 existing
  prompt/schema tests passed.
- Targeted final: 123/123 pass.
- `npm run gate:quick`: typecheck and lint pass; 888/888 tests pass.
- Full README matrix: build, server typecheck, lint, smoke report 74/74,
  lesson eval 15/15, unit 888/888, integration 886/886, E2E 31/31, visual
  60/60, accessibility 5/5, security 23/23, storage 10/10, brand and runtime
  model checks all pass. All offline eval verifiers pass.
- `npm audit --omit=dev`: one pre-existing moderate `qs` advisory, unchanged.
- `audit:m7-acceptance`: result SHA-256
  `e54d4aa964996b162f2ce6d6dd8579a114bf5689b4cd663f2c49c11336702e35`;
  `accepted:false` remains unchanged.
- `vercel build` exited 0 and produced both `api/ws.func` and
  `api/[...path].func`. Vercel's TypeScript-6 function scan still printed
  pre-existing narrowing/lib diagnostics; the repository's authoritative
  `npm run build` and `npm run typecheck:server` passed.

No visual baseline was changed.

## Preview

| Item | Result |
| --- | --- |
| Initial exact-origin deployment | `dpl_2bj8bFFDM3BE8kcWnnYXWMFPtvdd` |
| Final Preview deployment | `dpl_RLkww2nTohabnwmUmkpTH2ccgHmf` |
| Stable alias | `https://noura-preview-mtk2982007.vercel.app` → final Preview |
| Build SHA | `509564cd8866bda436beeb38aff2be624ba9b369` |
| Safety env | `NOURA_LESSON_COMPILER=fixture` |
| Routes | `/`, `/parent`, `/dev/board` 200 |
| Version/auth | exact SHA; `{required:false, authenticated:true}`; empty children list |
| Health | 503 degraded durable storage, expected for this Preview boundary |

The deployed Preview does not claim a stateful WSS/reconnect or captions-only
fallback result: its separate lambdas cannot share ephemeral SQLite while
durable storage is unavailable. Those paths are proven offline by the passing
fake-transport browser/unit suites only.

## Production

| Item | Result |
| --- | --- |
| Deployment | `dpl_XAErTxXTjmqAwbuhH5AioDQ9nj4f` |
| Deployment URL | `https://learnwithnoura-264jcax3n-mtk2982007-9928s-projects.vercel.app` |
| Apex | `https://learnwithnoura.com` |
| `/version` | 200; exact `509564cd8866bda436beeb38aff2be624ba9b369` |
| `/healthz` | 200; provider configured, durable storage available, schema ready |
| Login boundary | unauthenticated auth state required/false; `/api/children` 401 |
| `www` | 308 to apex |
| Director env | `NOURA_DIRECTOR_PIPELINE=classic` |
| Illustrations | unchanged default-on configuration |

The Supabase tenant resolution failure observed during the prior deploy was
not present at verification time, but the earlier flapping remains an
operational watch item.

## Live-evidence boundary and deferred work

No OpenAI/provider call was made during this incident response. The owner
declined the itemized post-deploy smoke, so neither streaming nor the new
opening prompt is claimed production-provider-verified. Personal testing is
owner-run evidence unless its observations and telemetry are later captured
in a reviewed handoff.

Deferred:

- fresh itemized authorization and the mandatory provider smoke before any
  return to `NOURA_DIRECTOR_PIPELINE=streaming`;
- continued watch for Supabase tenant/DNS flapping;
- the documented M5 live-coordinator candidate-raster correction;
- the pre-existing Vercel TypeScript-6 diagnostics and moderate `qs` advisory.

Any personal-test failure other than the known second-board-change-within-40s
limitation should trigger rollback to
`dpl_AbnroCy4guyi7Q4vZbh7mJxg8ZXZ` and an honest incident update.
