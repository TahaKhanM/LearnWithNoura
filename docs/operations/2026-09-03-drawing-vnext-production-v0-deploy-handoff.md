# Drawing vNext + auth overlay production-v0 deploy handoff

**Date:** 2026-09-03  
**Branch:** `codex/noura-next-development`  
**Deploy HEAD:** `08a8ace27b5db10cc104c6d484b4f3be70e25eef`  
**Rollback target (prior login-gated v0):** `dpl_AbnroCy4guyi7Q4vZbh7mJxg8ZXZ` (revision `2ce3e0bf…`)  
**New production deployment:** `dpl_Gn7As8XjzZv7vcZoRKowGp1UAofh`  
**Preview deployment (Phase 3):** `dpl_ECGtvqLzZkYZH23Apm9SmwZ5bdYp`

## Commits on this track

| SHA | Purpose |
| --- | --- |
| `d870531` | Auth-only overlay (demo login gate, scrypt verifier, AuthBoundary, e2e-live login path) |
| `08a8ace` | Visual baseline refresh (48 harness scenes; M7 toolbar chrome only) |

Drawing vNext work through M4/M5/M7 remainder remains on `d83b1ae` ancestry below the auth commit.

## Auth overlay review (report only — design unchanged)

**Strengths**

- Fail-closed when `NOURA_REQUIRE_LOGIN=true`: guest auto-cookie issuance disabled; `parentId` accepts only the HMAC-derived demo parent id; stale guest cookies rejected (`server/auth.test.ts`).
- Password never leaves the server: scrypt-v1 verifier in env; timing-safe compare; login rate-limited (5 / 5 min / IP).
- Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, 12 h; logout clears with `Max-Age=0`.
- Client `AuthBoundary` blocks all routes until `/api/auth/session` succeeds; sign-out clears `noura.*` local/session storage keys.
- Production readiness fails closed if login is required but demo credentials are incomplete (`runtimeConfig.ts`).
- Live harness accepts optional `NOURA_SMOKE_LOGIN_*` without echoing credentials into reports.

**Design choices retained (not rewritten)**

- Single shared demo parent id (not multi-user identity) — appropriate for controlled v0 only.
- Case-insensitive email match; generic 401 copy (no account enumeration).
- Preview/local modes keep `required:false` guest path when login is off.
- `api/auth/*` Vercel entrypoints re-export the Express app (same as existing API pattern).

**No login-gate weakening observed** in review or offline tests.

## Owner decisions (in-session)

| Decision | Owner choice | Applied |
| --- | --- | --- |
| `NOURA_DIRECTOR_PIPELINE` | **streaming** | Added Production secret `NOURA_DIRECTOR_PIPELINE=streaming` |
| `NOURA_ILLUSTRATIONS` | **on** (personal testing) | Unchanged (default on; model resolves to `gpt-image-2` via `runtimeConfig`) |
| Post-deploy provider smoke | **authorized** | **Not executed** — see blockers below |

Quoted authorization: owner selected streaming pipeline, illustrations on, and authorized smoke via in-session form (2026-09-03).

## Verification matrix (@ `08a8ace`)

| Gate | Result |
| --- | --- |
| `npm run build` | pass |
| `npm run typecheck:server` | pass |
| `npm run lint` | pass (demo/ warnings only, untouched) |
| `npm run test:smoke-report` | 74/74 pass |
| `npm run test:lesson-eval` | 15/15 gates pass |
| `npm test` | 881/881 pass |
| `npm audit --omit=dev` | 1 moderate `qs` (pre-existing) |
| `npm run test:integration` | 879/879 pass |
| `npm run test:e2e` | 31/31 pass |
| `npm run test:visual` | 60/60 pass (after baseline refresh) |
| `npm run test:a11y` | 5/5 pass |
| `npm run test:security` | 23/23 pass |
| `npm run test:storage` | 10/10 pass |
| `npm run test:brand` | pass |
| `npm run test:runtime-models` | pass |
| Eval verifiers (`test:director-*`, `test:first-paint`, `test:m1-acceptance`, `test:curriculum-matrix`, `test:role-adoption`, `test:m3-acceptance`, `test:image-grounding`) | all pass |
| `npm run audit:m7-acceptance` | `resultSha256=e54d4aa964996b162f2ce6d6dd8579a114bf5689b4cd663f2c49c11336702e35`, `accepted:false` |

## Visual baseline inspection (48 scenes refreshed)

Diff review on representative failures (`scene-pythagorean`, `scene-annotations`, and the full failure set) showed **only harness toolbar chrome** changed: six new `m7-*` fixture buttons (~4% pixels desktop, ~1% tablet). **No board-content regression** observed. All 48 updated snapshots:

- Canonical 14 scenes × 3 viewports (desktop, tablet, mobile-focus): pythagorean, triangle-angles, unit-circle, slopes, fractions, water-cycle, argument, history, grammar, relationship-map, worked-steps, comparison, part-whole, no-board
- Standalone harness scenes: handwritten, annotations, assets, arc-curve, illustration-overlays, two-regions-gutter

Six dedicated `m7-*` curriculum primitive baselines were already current (no change).

## Preview deploy (Phase 3)

- Prebuilt build confirmed `api/ws.func` and `api/[...path].func`.
- `/`, `/parent`, `/dev/board`: 200 HTML
- `/healthz`: 503 degraded storage (expected on Preview)
- `/api/auth/session`: `{required:false, authenticated:true}` (preview-synthetic)
- Note: Preview `/version` reported pulled env SHA `5b3bee5` (stale Preview `NOURA_BUILD_SHA` in remote env); Production build/deploy used `08a8ace`.

## Production post-deploy (offline)

| Check | Result |
| --- | --- |
| `/version` gitSha | `08a8ace27b5db10cc104c6d484b4f3be70e25eef` ✓ |
| `/api/auth/session` (unauthenticated) | `{required:true, authenticated:false}` ✓ |
| `/api/children` (unauthenticated) | 401 ✓ |
| `www` → apex | 308 → `https://learnwithnoura.com/` ✓ |
| `/healthz` | **503 degraded** — `durableStorage: unavailable` ✗ |

**Storage blocker (pre-existing, not introduced by this deploy):** Vercel error logs show  
`[storage] health failed: (ENOTFOUND) tenant/user noura_app.ldzlopqhwvyxkyhfldni not found`  
on every `/healthz` probe. The prior live deployment showed the same degraded `/healthz` before promotion.

Login cookie flow (demo POST → Set-Cookie → children 200 → logout) was **not curl-verified** — plaintext demo password is not available locally (Vercel stores scrypt verifier only).

## Provider smoke (authorized, not run)

**Itemization (M2/M7 evidence basis):**

- 1× lesson compilation (gpt-5.6-terra, streaming pipeline)
- 1× Realtime voice session (gpt-realtime-2.1)
- 1–2× streaming Director compositions + optional luna-low audit / recovery
- 0–2× gpt-image-2 illustration generations if the lesson triggers illustration (owner chose illustrations **on**; cache hits free)
- **Conservative accounted upper bound:** ~$0.68–$1.25 USD (M2 corrected rerun envelope); illustrations add ≤2× image call budget per lesson when cache misses
- **Decision it informs:** whether the new deployment teaches end-to-end on the owner-chosen streaming + illustrations configuration

**Blockers to execution:**

1. `NOURA_SMOKE_LOGIN_EMAIL` / `NOURA_SMOKE_LOGIN_PASSWORD` not present in local `.env` / `.env.local` (Vercel Production secrets are not pullable as plaintext).
2. Durable Postgres health failing — smoke would likely fail at learner/session persistence even with credentials.

**Command (owner-run when DB + credentials are available):**

```bash
NOURA_BASE_URL=https://learnwithnoura.com \
NOURA_SMOKE_LOGIN_EMAIL=… \
NOURA_SMOKE_LOGIN_PASSWORD=… \
npm run e2e:live -- --authorized-live-run --text-only
```

Gate: audio, captions, ≥1 board change, interruption recovery, complete telemetry, no console errors. Second-board-change failure within 40s = known product limitation, not rollback trigger.

## Deferred / follow-up

- Fix Supabase `DATABASE_URL` / `noura_app` role (tenant ENOTFOUND) and re-verify `/healthz` 200.
- Complete authorized provider smoke after DB + login credentials are available.
- Push `codex/noura-next-development` to origin only after owner confirms (no remote branch yet).
- M7 `accepted` remains **false** (unchanged).
- Full Production gates (real parent auth, ZDR) remain closed.
