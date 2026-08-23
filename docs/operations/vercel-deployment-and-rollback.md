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

The first CLI deployment is forcibly classified by Vercel as Production even when Preview was requested. Two accidentally classified tutor deployments were immediately removed. The surviving Production deployment is the static maintenance boundary `dpl_DPdMDbq9D69cSZyJX3VS4C7MbdeU`; it has no tutor API and no purchased-domain assignment. This seed allows subsequent explicit `--target=preview` deployments to remain Preview.

## Production gate

Do not use `--prod`, promote, or attach the domain until:

- Postgres is selected, paid/billing authorization exists if needed, and the domain repository uses it;
- authentication, authorization, retention/deletion, privacy/safety and exact origins pass;
- relevant ZDR evidence exists for under-13 mode;
- Vercel WebSocket/reconnect and persistence survive instance replacement;
- target-hardware permission/audio tests pass;
- `/healthz` is 200 and `/version` matches the tested SHA.

The current application intentionally throws during Production startup because the Postgres domain adapter gate is open.

## Rollback

Record the previous verified deployment ID before promotion. If health, auth, storage, WebSocket or security checks fail:

```bash
npx vercel@latest rollback <previous-deployment-id>
# or
npx vercel@latest promote <previous-deployment-id>
```

Verify the apex, `/version`, `/healthz`, REST and WSS after rollback. Schema changes are additive; never delete legacy data or roll code across an irreversible migration.
