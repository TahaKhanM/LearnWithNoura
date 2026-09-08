# Verification and evidence

Run with Node 24 and dependencies from `npm ci`. Keep `NOURA_LESSON_COMPILER=fixture` and an empty `OPENAI_API_KEY` for offline work. Playwright starts its own fixture servers on ports 5180 and 8790 and uses synthetic learners. Live evaluation and deployment are separate operations.

## Current code checks

```bash
npm run gate:quick
npm run build
npm run test:smoke-report
npm run test:lesson-eval
npm audit --omit=dev
npx playwright install chromium
npm run test:e2e
npm run test:visual
npm run test:a11y
npm run test:brand
npm run test:runtime-models
```

`gate:quick` includes the server typecheck, lint and all Vitest tests. `npm test` runs that same test suite alone. `test:integration`, `test:security` and `test:storage` select subsets for diagnosis rather than additional independent coverage. The `test:storage` contracts use SQLite and an in-memory Postgres implementation; they do not establish connectivity, migrations or performance against a deployed database.

Visual baselines were captured with Chromium on macOS. They are platform-specific because font rasterization differs. The CI job runs contracts, build, browser journeys and accessibility on Linux; visual comparison is a separate macOS check. Do not generate missing platform baselines and call that a passing comparison. Inspect an intentional visual change before updating its existing baseline.

## Retained drawing studies

These commands verify checked-in results with zero new provider calls:

```bash
npm run test:director-eval
npm run test:director-m1-eval
npm run test:director-recovery
npm run test:first-paint
npm run test:m1-acceptance
npm run test:curriculum-matrix
npm run test:role-adoption
npm run test:m2-live-smoke
npm run test:m3-acceptance
npm run test:image-grounding
npm run audit:m7-acceptance
```

The last command succeeds when the retained M7 decision is reproduced, including `accepted: false`; command success is not program acceptance. Likewise, reproducing a historical latency calculation does not measure the current application's latency.

The 53 original screenshots required by these tests live in `artifacts/evaluation/`. Only the exact inspected synthetic evidence was added for public release. Large recordings, generated directories, credentials, local databases and unrelated media are excluded. See [the artifact note](../artifacts/README.md). The architecture index and historical reports retain experiment dates, failure decisions, spending observations and narrower scopes of acceptance.

## September 2026 public-release review

The initial source at `4e41b89` built successfully, but a clean checkout failed five test files because their evidence images were ignored. Adding those original images restored 123 passing test files and 891 passing tests before the later TLS and lifecycle regressions were added.

New regression cases exercise malformed cookie input, invalid signed claims, distinct-key rate-limit saturation and expiry, TLS options after real node-postgres URL parsing, and work registered after cancellation/completion/failure. TLS tests check effective client configuration without making a network connection. None of these checks replaces a live database certificate test, provider-backed lesson, acoustic timing measurement, or educational evaluation.

The contributor's existing working directory and recordings are not dependencies of the published checkout. All commands above operate on tracked source and fixtures after dependency installation. The public-release review used a fresh npm installation on Node 24.14.0. Final results: 124 Vitest files / 905 tests passed; client build, server typecheck, lint, smoke-report tests, lesson fixtures and runtime-model check passed; production dependency audit reported zero known vulnerabilities. Every retained drawing verifier listed above passed, including the deliberately non-accepted M7 report.

The first complete browser run passed 33 of 36 checks. The remaining preparation tests had depended on a configured provider key; after explicitly mocking only the preparation-availability response and forcing empty provider credentials, all seven tests in the two affected files passed. The real server still uses its fixture compiler, and live lesson availability remains disabled without a provider. This verifies preparation and synthetic control flows, not a live voice session.

All 56 unchanged scene/lesson visual comparisons passed. The four home-page snapshots were inspected at desktop, tablet, mobile and landscape sizes and updated for the product name and explicit no-provider state. They retain the same macOS/Chromium platform boundary.
