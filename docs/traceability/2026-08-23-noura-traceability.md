# Noura implementation traceability

Statuses: PASS = automated/direct evidence; PARTIAL = meaningful implementation with an open gate; BLOCKED = fail-closed external or dependency gate; UNVERIFIED = required evidence not performed.

Line references are to this working revision and are refreshed at handoff.

## Independent audit and owner feedback

| ID | Requirement / original status | Implementation | Automated/browser evidence | Residual / final status |
| --- | --- | --- | --- | --- |
| AUD-P0-01 | No deployment/version signal — FAIL | `server/app.ts` health/version; `api/`; `vercel.json`; project runbook | Vercel local build; Preview smoke row below | Preview pending; Production blocked. PARTIAL |
| AUD-P1-01 | Global visual bounds/collision unsafe — FAIL | `src/board/inspection.ts`; long-word splitting; semantic adapters | `inspection.test.ts`; canonical visual baselines | Actual DOM/KaTeX repair is bounded to one pass. PARTIAL |
| AUD-P1-02 | Misleading interruption metric — FAIL | Detector-to-stop-scheduled and provider confirmation are separate; README removes acoustic claim | runtime/property tests | Acoustic onset-to-silence hardware run missing. UNVERIFIED |
| AUD-P1-03 | Interruption finished stale drawing — FAIL | `BoardAnimator.cancelAll`; transient scene rollback; ack after idle | `animator.test.ts`; generation cancellation | Browser recorded interruption evidence not yet captured. PASS (deterministic), UNVERIFIED (hardware) |
| AUD-P1-04 | Reconnect/fallback stale/drop/zombie risks — FAIL | 8s timeout, two retries, newest queued ask, idempotency, scope cleanup, abortable fallback | GenerationScope and event-gate tests | Full fake-WS integration matrix is incomplete. PARTIAL |
| AUD-P1-05 | Unauthenticated child data/paid WS — FAIL | parent-scoped rows/routes, signed lesson capability, exact Origin, rate bounds | `api.auth.test.ts`, `security.test.ts` | Real identity provider and distributed limiter absent. BLOCKED for Production |
| AUD-P1-06 | Under-18 controls absent — FAIL | disclosure, synthetic boundary, raw-audio rule, Production/ZDR fail-close, threat model | runtime config tests, axe Home | Legal/account/ZDR/report ownership external. BLOCKED |
| AUD-P1-07 | Tutor silently waits after promises — FAIL | lesson reducer and bounded continuation/safe question | `orchestrator.test.ts` | Paid representative live eval limited/not yet run. PARTIAL |
| AUD-P1-08 | Ended sessions mutable — FAIL | immutable cutoff at end; store write rejection; linked continuation UI/API | `repo.test.ts`, Playwright ended route | Concurrent provider race needs deployed fault test. PASS locally |
| AUD-P1-09 | Parent scroll owner wrong — FAIL | body/document scroll; fixed viewport scoped to Lesson | Playwright body overflow and Parent journey | Manual trackpad/touch/Space/Page Down still required. PARTIAL |
| AUD-P1-10 | Captions arrival-stamped/raw-token UI — FAIL | PCM-gated phrase segmentation and final response correction; caret/clamp removed | unit/build checks | Recorded alignment metrics not performed. UNVERIFIED |
| AUD-P2-01 | Direct timeline stuck — FAIL | shared `loadTimeline` called for query session | Playwright direct Parent Area | PASS |
| AUD-P2-02 | Selected learner resets — FAIL | URL + same-origin state; invalid requested ID is not substituted | Playwright reload/back flow | PASS |
| AUD-P2-03 | Mobile board unreadable/tiny controls — FAIL | 44px child tools; mobile focus/pan + overview; contrast tokens | screenshots/axe; mobile target inspection | 200% zoom and physical touch manual pass open. PARTIAL |
| AUD-P2-04 | Summary lacks lineage — FAIL | UUID evidence/source span; cited schema; deterministic rejection/fallback | `summary.test.ts`, `repo.test.ts` | Existing historical evidence remains legacy-shaped. PASS for new evidence |
| AUD-P2-05 | Scripts only log failures — FAIL | Vitest/Playwright/axe scripts assert and exit nonzero | command results | Live paid scripts remain excluded by default. PASS |
| AUD-P2-06 | Tutor clear deletes learner work — FAIL | owner-aware add/update/erase/clear | `scene.test.ts` | PASS |
| AUD-P2-07 | Muted UI still says listening — FAIL | explicit muted status branch | browser source/build; dedicated live-mic browser test pending | PARTIAL |
| AUD-P3-01 | Chunk/fonts/lint cleanup — PARTIAL | self-hosted Outfit/Caveat; font-ready compilation | build | JS chunk still above 500k; router lint warnings remain. PARTIAL |
| OWN-01 | Starting dashboard incomplete/confusing | explicit Parent setup, role disclosure, progressive first/returning states | Home Playwright + screenshots + axe | PASS |
| OWN-02 | Parent dashboard inaccessible/unclear | switcher, next action, hierarchy, history, evidence IDs, session timeline | Parent Playwright | Real cited summary browser fixture pending. PARTIAL |
| OWN-03 | Tutor loses momentum | deterministic owed action/handoff | orchestrator tests | Representative live matrix pending. PARTIAL |
| OWN-04 | Purposeful adaptive loop | complete taxonomy, policy, concept projection, TeachingMove seam | pedagogy/orchestrator tests | Deterministic domain checkers limited. PARTIAL |
| OWN-05 | Drawing needs semantic redesign/performance | semantic templates, inspection, transaction, reveal checkpoints | semantic/inspection/visual tests | General layout repair and mobile semantic group navigation can deepen. PARTIAL |
| OWN-06 | Captions/voice/drawing/avatar feel separate | PCM clock; response IDs; shared visual/attention generation | protocol/generation/character tests | Recorded audiovisual sync evaluation missing. UNVERIFIED |

## Rebrand and data migration

| ID | Requirement | Implementation / evidence | Status |
| --- | --- | --- | --- |
| BRAND-01 | All current UI/copy/aria/prompt says Noura | Home/Lesson/Parent, prompt, manifest, metadata; `test:brand`; Playwright body scan | PASS |
| BRAND-02 | Character introduces itself as Noura | `server/prompts/realtime.md` | Code PASS; live voice UNVERIFIED |
| BRAND-03 | Wordmark and recognizable silhouette | Noura Home mark/Avatar; reviewed screenshots | PASS |
| BRAND-04 | Canonical/social metadata and manifest | `index.html`, `public/manifest.webmanifest` | PASS |
| BRAND-05 | Package and brand identifiers | `package.json`; `NouraCapture` / `noura-capture`; temp paths | PASS |
| BRAND-06 | `NOURA_*` preferred; deprecated alias window | `.env.example`; `server/store/db.ts`; migration test | PASS |
| BRAND-07 | `noura.db` verified recoverable migration; old retained | integrity/row-count/backup logic and test; local run verified 2/17/181/4 counts | PASS |
| BRAND-08 | Historical evidence remains truthful | `docs/legacy/`; repository/path unchanged | PASS |
| BRAND-09 | Remaining legacy-name occurrences justified | brand allowlist + final scan inventory | PASS when final scan is green |

## Runtime, orchestration, visual, evidence and lifecycle architecture

| ID | Requirement | Implementation / tests | Status |
| --- | --- | --- | --- |
| ARC-01 | Versioned envelope everywhere | `shared/runtimeProtocol.ts`; proxy/client envelopes | PASS |
| ARC-02 | One generation cancellation scope | `generationScope.ts`; RealtimeSession/visual rollback | PASS deterministic |
| ARC-03 | Stale session/epoch/turn/generation rejection | client gate + provider-response identity map | 1,000 property runs PASS |
| ARC-04 | Legal teaching state machine | `server/lesson/orchestrator.ts` | reducer tests PASS |
| ARC-05 | Full response taxonomy/policy | `shared/pedagogy.ts` | taxonomy/projection tests PASS |
| ARC-06 | One answer never mastery | projection and evidence mapping | tests PASS |
| ARC-07 | Reconnect/fallback bounded/single-generation | RealtimeSession | PARTIAL integration coverage |
| ARC-08 | PCM authoritative captions/visual/character | RealtimeSession, Board transaction, controller | Code/tests PASS; recorded sync UNVERIFIED |
| ARC-09 | Semantic plan above BoardOp | `shared/semanticScene.ts`, tool schema | PASS fixtures |
| ARC-10 | Canonical domain scenes and NoBoard | Board harness + screenshots | PASS visual/semantic assertions |
| ARC-11 | Render inspect/repair/reject | `inspection.ts`; transaction keeps committed scene | PASS unit; DOM repair PARTIAL |
| ARC-12 | Owner-aware board mutation | `scene.ts` | PASS |
| ARC-13 | Latest pagination and immutable cutoff | `repo.ts` | PASS |
| ARC-14 | Evidence lineage and summary citations | `repo.ts`, `summary.ts` | PASS new evidence |
| ARC-15 | SQLite/Postgres separation | local migration + `PostgresStore` portable contract | Adapter PASS; Production wiring BLOCKED |

## Character embodiment and privacy

| ID | Requirement | Implementation / evidence | Status |
| --- | --- | --- | --- |
| CHAR-01 | Independent pupils, blink/brows/mouth/head states | `Avatar.tsx/.css`; self-hosted visual baselines | PASS visual implementation |
| CHAR-02 | Mouth from actual output energy | `AudioOut.currentEnergy` → snapshot → Avatar | PASS unit/build; recorded AV UNVERIFIED |
| CHAR-03 | Tutor pen gaze | Board animator pen → attention target | controller priority tests; live recording pending | PARTIAL |
| CHAR-04 | Semantic highlight/revision gaze ≤200ms | semantic target seam/controller | timing recording missing | UNVERIFIED |
| CHAR-05 | Learner stroke/pointer/touch/focus gaze | Board callbacks + hysteresis controller | controller tests | PASS deterministic |
| CHAR-06 | Interruption cancels mouth/gesture/pen/stale gaze in frame | generation cancel + animator/controller reset | cancellation tests | PASS deterministic |
| CHAR-07 | Thinking/reconnect/failure/complete poses honest | phase classes and status text | screenshots/code | PASS |
| CHAR-08 | Periodic learner-facing gaze | target expiry falls back to neutral learner | controller tests | PASS deterministic |
| CHAR-09 | Rapid pointer damped/clamped/no uncanny clipping | hysteresis, smoothing, clamp | controller tests | PASS |
| CHAR-10 | Reduced motion preserves state, removes large motion | CSS/controller permission | reduced screenshots/axe | PASS automated |
| CHAR-11 | Character never covers board/captions/controls | reserved dock and board inspection; responsive snapshots | PASS reviewed baselines |
| CHAR-12 | Camera optional/local/non-biometric | camera not implemented; threat model | PASS by omission; no camera evidence applicable |

## Vercel and domain

| ID | Requirement | Evidence | Status |
| --- | --- | --- | --- |
| VCL-01 | Inspect account/project/domain before mutation | one Hobby team; domain present; no prior Noura project | PASS |
| VCL-02 | Reuse/create one `learnwithnoura` project | project `prj_7qBYP4tml6ccqxmwV2qCQEyBn8Nv` | PASS |
| VCL-03 | Correct Vite/static + Express/WS Functions | `vercel.json`; genuine local output has both functions | PASS local build |
| VCL-04 | Git integration/main Production branch | private org repo cannot connect on Hobby | BLOCKED by account/repo plan boundary |
| VCL-05 | Preview/Production env separation | Preview-only variables; sensitive secrets | PASS metadata |
| VCL-06 | Native WS duration based on inspected plan | Hobby; 300s Function | PASS config; deployed WSS pending |
| VCL-07 | Preview exact SHA/version/health | deployment record below | PENDING |
| VCL-08 | Preview synthetic/no Production child data | synthetic env; ephemeral local data | PASS boundary; persistence intentionally degraded |
| VCL-09 | Production durable store/auth/privacy | startup fail-closed | BLOCKED |
| VCL-10 | Apex/www/SSL/DNS assignment | domain exists with Vercel nameservers; not attached before gate | Production BLOCKED |
| VCL-11 | HTTPS/WSS/persistence/restart | Preview/Production smoke rows | PENDING/UNVERIFIED |
| VCL-12 | Rollback target/procedure | operations runbook | Procedure PASS; target only after deployment |

## Runtime-model preservation

| ID | Requirement | Evidence | Status |
| --- | --- | --- | --- |
| MODEL-01 | Codex uses GPT-5.6 Sol as implementation agent only; Noura runtime model/API configuration is unchanged except for independently justified, documented changes | runtime ADR; config tests; model scan; Realtime and Chat Completions call sites unchanged | PASS |

## Deployment evidence

| Environment | URL / deployment ID | SHA | Health/version/REST/WSS/log/persistence result |
| --- | --- | --- | --- |
| Preview | Pending | Pending | Pending |
| Production | Not deployed | N/A | Blocked by Postgres domain wiring, identity, privacy/safety, ZDR and target-hardware gates |

## Manual/recorded evidence still required

- Target-hardware headphones and speakers: UNVERIFIED.
- Real microphone permission denial, noise, single/repeated barge-in and acoustic silence: UNVERIFIED.
- Screen reader, full keyboard order, 200% zoom and physical touch: partially automated, manual pass UNVERIFIED.
- Recorded live character normal speech/drawing/interruption/reconnect performance: UNVERIFIED.
- Camera: not implemented; no camera permission or privacy recording required.
