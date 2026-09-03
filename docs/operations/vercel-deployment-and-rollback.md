# Noura Vercel deployment and rollback runbook

## Account baseline

- Scope: `mtk2982007-9928s-projects`
- Project: `learnwithnoura`
- Project ID: `prj_7qBYP4tml6ccqxmwV2qCQEyBn8Nv`
- Plan observed: Hobby
- Canonical domain: `learnwithnoura.com`
- Preferred alias: `www.learnwithnoura.com` → permanent apex redirect
- GitHub integration: blocked because the repository is private and organization-owned while the inspected Hobby account cannot attach that repository class. Use reviewed manual CLI deployments until account/project ownership changes.
- Deployment Protection: Standard Vercel Authentication (`all_except_custom_domains`).
- Stable protected Preview alias: `https://noura-preview-mtk2982007.vercel.app`
- Public v0: `https://learnwithnoura.com`; `www` permanently redirects to the apex.
- Rollback target (prior login-gated v0): `dpl_AbnroCy4guyi7Q4vZbh7mJxg8ZXZ`, revision `2ce3e0bf4a7c7ac85adfaf6f89e0b41bcf2e878d`.
- Current login-gated public-v0 deployment: `dpl_Gn7As8XjzZv7vcZoRKowGp1UAofh`, revision `08a8ace27b5db10cc104c6d484b4f3be70e25eef` (Drawing vNext through M7 + auth overlay; `NOURA_DIRECTOR_PIPELINE=streaming`; illustrations on). Post-deploy `/healthz` reports degraded durable storage (`noura_app` tenant ENOTFOUND — pre-existing); provider smoke authorized but not executed pending DB fix and local demo credentials. Evidence: `docs/operations/2026-09-03-drawing-vnext-production-v0-deploy-handoff.md`.

Do not print or download Production secrets into tracked files. `.vercel/`, `.env*` and databases are ignored.

## Preview

1. Run all local gates.
2. Set `NOURA_BUILD_SHA` to the exact committed HEAD for Preview.
3. `npx vercel@latest pull --yes --environment=preview`
4. `npx vercel@latest build`
5. Confirm `.vercel/output/functions/api/ws.func` and `api/[...path].func` exist.
6. `npx vercel@latest deploy --prebuilt`
7. Add the exact Preview origin to `NOURA_ALLOWED_ORIGINS`; redeploy.
8. Verify `/`, deep routes, `/healthz`, `/version`, REST authorization/capabilities, WebSocket upgrade/reconnect and captions-only fallback.
9. Inspect error logs without transcript or secret content.

Preview is synthetic-only and storage-ephemeral. A 503 degraded `/healthz` for durable storage is an intentional blocker, not a successful persistence claim.

The first CLI deployment was forcibly classified by Vercel as Production even when Preview was requested. Two accidentally classified tutor deployments were immediately removed. The former maintenance boundary `dpl_DPdMDbq9D69cSZyJX3VS4C7MbdeU` remains the historical rollback artifact; subsequent explicit Preview deployments remain Preview.

## Public v0 gate

Public v0 is the real Noura product, not a scripted fixture. It uses managed Postgres, live provider calls, the Realtime WebSocket, captions-only fallback, semantic visuals, learner drawing, evidence, immutable ending and the Parent view. Its temporary identity boundary is one server-configured demo account backed by a signed parent-session cookie, and the UI remains explicit that only pretend learner details may be used.

Before setting `NOURA_DEPLOYMENT_MODE=production-v0`, require:

- `DATABASE_URL` using a serverless-suitable pooled connection, `NOURA_STORAGE_ADAPTER=postgres`, and migration 1 in the private `noura` schema;
- `OPENAI_API_KEY`, reviewed runtime model identifiers and a strong `NOURA_LESSON_CAPABILITY_SECRET`;
- exact apex/www origins, London Function placement beside the database, `/healthz` 200 and `/version` matching the tested revision;
- a deployed REST → WSS → reconnect → fallback → end → Parent smoke using pretend learner details only;
- a recorded rollback target before the custom domain is attached.

The v0 boundary does not claim real-user readiness, legal compliance, ZDR, durable distributed rate limiting or external parent identity.

The Supabase shared pooler encrypts the v0 database connection, but its certificate chain is not in Node's default CA store. Public v0 therefore sets `NOURA_DATABASE_SSL_REJECT_UNAUTHORIZED=false`. Before full Production, download and pin the project Server root certificate and restore certificate/hostname verification.

Launch evidence through revision `563f4c3`:

- public apex health 200, exact `/version`, production-v0 config and permanent `www` redirect;
- signed guest cookie, parent scoping, learner/session creation, nested session reload and Parent overview persisted through managed Postgres;
- public WSS reached `ready`, started a Realtime response, delivered live PCM and accepted local interruption;
- a deployed short loud tone did not cancel the active response and live PCM continued; deterministic tests require sustained local speech plus server confirmation;
- the actual Chromium Lesson kept a released tutor object and learner stroke visible across interruption, emitted a replayable learner path plus bounded JPEG, and passed accessibility/reflow checks;
- deployed Realtime correctly identified both fractions using board image context alone, and a fresh WSS connection replayed the stored learner stroke;
- captions-only fallback completed with model tools, semantic board output, evidence, atomic release, immutable ending and Parent summary;
- all named synthetic smoke records were deleted after verification; the launch database was handed over empty.

Recovery deployment evidence on 2026-08-26:

- Supabase migrations 2–4 are present; `noura.compiled_lessons` and
  `noura.board_assets` are live rather than sidecar/unavailable fallbacks;
- the server-only `noura_app` role has SELECT/INSERT/UPDATE on the two new
  tables, while `anon` and `authenticated` have neither schema usage nor
  table access; Supabase security advisors report no active findings;
- `https://learnwithnoura.com/healthz` reports provider configured, durable
  storage available, schema ready, and overall healthy;
- the authorized text-only production smoke completed in 59.295 seconds with
  live provider usage, first audio at 1.003 seconds after the ask boundary,
  cumulative captions, two board changes (including the requested 0–10 number
  line with five marked), interruption, Parent Area, and a complete
  parent-scoped telemetry log;
- the smoke gate passed with no missing observations, telemetry gaps, browser
  console errors, duplicate captions, reconnects, or tutor-object loss.

Login-gate deployment evidence on 2026-08-26:

- Vercel stores the configured email and password verifier as secrets; the
  password is represented only by a salted scrypt verifier, never shipped to
  the browser or committed to the repository;
- unauthenticated `GET /api/auth/session` returns the public login state while
  `GET /api/children` fails with 401; `/healthz` remains 200 with provider,
  managed storage, and schema healthy;
- the supplied demo account receives a 12-hour signed `HttpOnly`, `Secure`,
  `SameSite=Lax` parent cookie, can access its parent-scoped APIs, and logout
  clears the session; pre-login guest cookies are rejected and the lesson
  capability signing secret was rotated;
- the post-deployment provider-backed smoke authenticated, connected to the
  live provider, observed audio, captions, and one board drawing, and recovered
  a complete telemetry log with no gaps or browser console errors. Its strict
  reporter gate failed because the follow-up interruption did not cause the
  required second board change within 40 seconds. Drawing reliability therefore
  remains an explicit product limitation rather than a passing claim.

## Full Production gate

Do not use `--prod`, promote, or attach the domain until:

- Postgres is selected, paid/billing authorization exists if needed, and the domain repository uses it;
- authentication, authorization, retention/deletion, privacy/safety and exact origins pass;
- relevant ZDR evidence exists for under-13 mode;
- Vercel WebSocket/reconnect and persistence survive instance replacement;
- target-hardware permission/audio tests pass;
- `/healthz` is 200 and `/version` matches the tested SHA.

The application still intentionally throws in full `production` while these real-user gates are open. The narrower `production-v0` mode is separately fail-closed on provider, managed storage, storage-adapter and signing configuration.

## Rollback

Record the previous verified deployment ID before promotion. If health, auth, storage, WebSocket or security checks fail:

```bash
npx vercel@latest rollback <previous-deployment-id>
# or
npx vercel@latest promote <previous-deployment-id>
```

Verify the apex, `/version`, `/healthz`, REST and WSS after rollback. Schema changes are additive; never delete legacy data or roll code across an irreversible migration.
