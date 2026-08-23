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
| AUD-P1-04 | Reconnect/fallback stale/drop/zombie risks — FAIL | 8s timeout, two retries, newest queued ask; durable fallback claim, supersession abort, composed timeout/request signal, scoped writes and replay | fallback concurrency/error/duplicate/stale tests; cue reconnect/navigation tests | Deterministic PASS; deployed provider/network fault test remains UNVERIFIED. |
| AUD-P1-05 | Unauthenticated child data/paid WS — FAIL | parent-scoped rows/routes, signed lesson capability, exact Origin, rate bounds | `api.auth.test.ts`, `security.test.ts` | Real identity provider and distributed limiter absent. BLOCKED for Production |
| AUD-P1-06 | Under-18 controls absent — FAIL | disclosure, synthetic boundary, raw-audio rule, Production/ZDR fail-close, threat model | runtime config tests, axe Home | Legal/account/ZDR/report ownership external. BLOCKED |
| AUD-P1-07 | Tutor silently waits after promises — FAIL | lesson reducer and bounded continuation/safe question | `orchestrator.test.ts` | Paid representative live eval limited/not yet run. PARTIAL |
| AUD-P1-08 | Ended sessions mutable — FAIL | immutable cutoff at end; store write rejection; linked continuation UI/API | `repo.test.ts`, Playwright ended route | Concurrent provider race needs deployed fault test. PASS locally |
| AUD-P1-09 | Parent scroll owner wrong — FAIL | body/document scroll; fixed viewport scoped to Lesson | Playwright body overflow and Parent journey | Manual trackpad/touch/Space/Page Down still required. PARTIAL |
| AUD-P1-10 | Captions arrival-stamped/raw-token UI — FAIL | proxy-derived PCM sample offsets; one cue timeline; `audio_done` + heard-sample final gate | jitter/done-before-playback/interruption/reconnect tests; measured offline AV report | Deterministic PASS; target-hardware alignment remains UNVERIFIED. |
| AUD-P2-01 | Direct timeline stuck — FAIL | shared `loadTimeline` called for query session | Playwright direct Parent Area | PASS |
| AUD-P2-02 | Selected learner resets — FAIL | URL + same-origin state; invalid requested ID is not substituted | Playwright reload/back flow | PASS |
| AUD-P2-03 | Mobile board unreadable/tiny controls — FAIL | semantic-bound viewBox; labelled group select; keyboard/touch pan; overview; 44px primary controls | 320/390/844×390, 200% zoom/reflow, text-size/overflow browser assertions and reviewed baselines | Browser PASS; physical-device touch remains UNVERIFIED. |
| AUD-P2-04 | Summary lacks lineage — FAIL | UUID evidence/source span; cited schema; deterministic rejection/fallback | `summary.test.ts`, `repo.test.ts` | Existing historical evidence remains legacy-shaped. PASS for new evidence |
| AUD-P2-05 | Scripts only log failures — FAIL | Vitest/Playwright/axe scripts assert and exit nonzero | command results | Live paid scripts remain excluded by default. PASS |
| AUD-P2-06 | Tutor clear deletes learner work — FAIL | owner-aware add/update/erase/clear | `scene.test.ts` | PASS |
| AUD-P2-07 | Muted UI still says listening — FAIL | explicit muted status branch | browser source/build; dedicated live-mic browser test pending | PARTIAL |
| AUD-P3-01 | Chunk/fonts/lint cleanup — PARTIAL | self-hosted Outfit/Caveat; font-ready compilation | build | JS chunk still above 500k; router lint warnings remain. PARTIAL |
| OWN-01 | Starting dashboard incomplete/confusing | explicit Parent setup, role disclosure, progressive first/returning states | Home Playwright + screenshots + axe | PASS |
| OWN-02 | Parent dashboard inaccessible/unclear | authoritative concept projection, calibrated summary columns, contradiction/resolution history, evidence IDs | Parent browser fixture covers single correct, retrieval, self-correction, contradiction, resolution and improvement | PASS deterministic/browser. |
| OWN-03 | Tutor loses momentum | deterministic owed action/handoff | orchestrator tests | Representative live matrix pending. PARTIAL |
| OWN-04 | Purposeful adaptive loop | complete taxonomy, policy, concept projection, TeachingMove seam | pedagogy/orchestrator tests | Deterministic domain checkers limited. PARTIAL |
| OWN-05 | Drawing needs semantic redesign/performance | semantic templates, ordered checkpoint compilation, inspection, committed animation, semantic mobile navigation | exact-domain, bounds/collision/crossing, reveal, viewport and visual tests | PASS deterministic; broad live-topic/provider review remains UNVERIFIED. |
| OWN-06 | Captions/voice/drawing/avatar feel separate | derived PCM offsets; shared cue scheduler; semantic/highlight/question/interruption attention integration | fake-clock tests, actual browser integration capture, measured offline AV report | PASS deterministic/browser; target-hardware/provider recording UNVERIFIED. |

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
| ARC-07 | Reconnect/fallback bounded/single-generation | RealtimeSession + durable fallback claim/coordinator | PASS deterministic; deployed network UNVERIFIED |
| ARC-08 | PCM authoritative captions/visual/character | proxy sample annotation, ResponseCueTimeline, Board transaction, controller | PASS deterministic/browser; target hardware UNVERIFIED |
| ARC-09 | Semantic plan above BoardOp | semantic checkpoints consume revealOrder and carry group/object/cue identity | PASS exact fixtures/runtime browser |
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
| CHAR-03 | Tutor pen gaze | Board animator pen → bbox-aware attention target | controller/animator and deterministic AV frame trace | PASS deterministic; live provider recording UNVERIFIED |
| CHAR-04 | Semantic highlight/revision gaze ≤200ms | cue identity → real compiled bbox → focused target | browser observed adoption under 200ms; controller integration test | PASS deterministic/browser |
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
| VCL-07 | Preview exact SHA/version/health | protected stable alias; `/version` exact SHA; `/healthz` explicit 503 degraded | PASS identity; health correctly BLOCKED |
| VCL-08 | Preview synthetic/no Production child data | synthetic-only env, Standard Protection, lesson creation disabled without shared storage | PASS safe boundary |
| VCL-09 | Production durable store/auth/privacy | startup fail-closed | BLOCKED |
| VCL-10 | Apex/www/SSL/DNS assignment | domain exists with Vercel nameservers; not attached before gate | Production BLOCKED |
| VCL-11 | HTTPS/WSS/persistence/restart | HTTPS/REST/deep routes pass; real Function test proved `/tmp` is not shared, then UI failed closed | WSS journey/persistence BLOCKED without managed store |
| VCL-12 | Rollback target/procedure | operations runbook | Procedure PASS; target only after deployment |

## Runtime-model preservation

| ID | Requirement | Evidence | Status |
| --- | --- | --- | --- |
| MODEL-01 | Codex uses GPT-5.6 Sol as implementation agent only; Noura runtime model/API configuration is unchanged except for independently justified, documented changes | runtime ADR; config tests; model scan; Realtime and Chat Completions call sites unchanged | PASS |

## Deployment evidence

| Environment | URL / deployment ID | SHA | Health/version/REST/WSS/log/persistence result |
| --- | --- | --- | --- |
| Preview | `https://noura-preview-mtk2982007.vercel.app` (final deployment ID in handoff) | `/version` must match final HEAD | Standard-protected; Home/deep routes/config/version pass; health 503 degraded; lessons disabled; logs clean |
| Production | Static maintenance boundary only: `dpl_DPdMDbq9D69cSZyJX3VS4C7MbdeU` | Maintenance artifact | No tutor backend; purchased domain intentionally unattached; application Production blocked |

## Manual/recorded evidence still required

- Target-hardware headphones and speakers: UNVERIFIED.
- Real microphone permission denial, noise, single/repeated barge-in and acoustic silence: UNVERIFIED.
- Screen reader and physical touch: manual pass UNVERIFIED. Keyboard order/focus visibility and 200% zoom/reflow have automated browser evidence.
- Recorded live character normal speech/drawing/interruption/reconnect performance: UNVERIFIED.
- Camera: not implemented; no camera permission or privacy recording required.

## Audit-cycle ledger

### Cycle 1 — local remediation, 2026-08-23

Starting revision: `1b6797030141519dff0b5114d17c506f9e6ea5d4` on `devin/demo-day-interactive-tutor`. No push, PR mutation, Preview deployment, Production promotion, domain change, paid provider call, paid resource or destructive action was performed.

| Packet item | Remediation evidence | Cycle status |
| --- | --- | --- |
| P1-1 fallback scope/idempotency | Durable one-active-generation claim; composed abort/timeout; identity-gated event/evidence/checkpoint writes; completed replay; semantic/orchestrator path; concurrent, abort, duplicate, ended, provider-error and stale-write tests | PASS deterministic |
| P1-2 evidence overclaim | One authoritative full-history projection in summary validation/fallback and Parent; explicit opportunity/retrieval fields; calibrated summary status; store/summary/unit/browser cases | PASS deterministic/browser |
| P1-3 response timing | Proxy-derived PCM sample offsets, one cue scheduler, `audio_done` final gate, synchronous cancellation; normal/jitter/repeat/gap/done-before-end/interruption/stale/reconnect/navigation tests | PASS deterministic; target hardware UNVERIFIED |
| P1-4 semantic reveal/character | `revealOrder` checkpoints; typed cue/object identity; bbox gaze; question/interruption integration; commit acknowledgement after animation; controller + actual-browser interruption/highlight evidence | PASS deterministic/browser; live provider recording UNVERIFIED |
| P2-5 mobile semantic layout | Semantic-bounds viewBox, group selection, keyboard/touch pan, overview; 320/390/844×390, 200% zoom, 44px, text-size and overflow assertions; reviewed baselines | PASS browser; physical-device touch UNVERIFIED |
| P1-6 AV evidence integrity | Metrics derived from runtime scheduler/controller, PCM samples and captured events/frames; ten negative fixtures prove every gate fails | PASS deterministic; target acoustics explicitly UNVERIFIED |
| P2-7 acceptance depth | Exact canonical semantics plus bounds/collision/crossing; real Lesson axe major states; reduced motion/focus/reflow/touch geometry; evidence projection browser case | PASS for fixed deterministic/browser gates |

Artifacts: `artifacts/evaluation/synthetic-av-character-report.json`, `.wav`, `.mp4`, and `artifacts/browser/lesson-semantic-mobile.png`. The AV artifacts are synthetic/offline; the browser PNG uses deterministic fake Realtime/PCM input. Neither substitutes for target-hardware or paid-provider evidence.

### Cycle 2 — local remediation, 2026-08-23

Starting revision: `bc876c3f8faaa1d0a67200286b13e495917aa438` on `devin/demo-day-interactive-tutor`; clean and nine commits ahead of upstream. Cycle 2 reopened the Cycle-1 claims below after independent adversarial reproduction. No push, PR mutation, Preview/Production deployment, domain/DNS/SSL/WSS change, paid provider call, paid resource or destructive/billing action was performed.

| Packet item | Remediation and direct evidence | Cycle status |
| --- | --- | --- |
| P1-1 evidence projection | `projectConceptHistories` now identifies one opportunity by session/task/turn, requires a later `retrievalOf` relationship, blocks latest/unresolved negative evidence, and treats explicit correction as resolution rather than confirmation. Summary validation/fallback and Parent call this same function. Negative-first unit cases cover duplicate same opportunity, reversed retrieval, later incorrect, single correction, post-resolution confirmation and cross-session retrieval; Parent fixture no longer labels contradicted/resolved-with-one-confirmation evidence Demonstrated. | 12-file focused Vitest run includes exact projection/summary cases; Parent Playwright passes. Deterministic/browser PASS. |
| P1-2 fallback atomicity | All fallback events/evidence are staged unreleased. One transaction completes the durable turn and promotes committed events/evidence; semantic scenes still require animation acknowledgement. Failed/cancelled/superseded rows remain hidden. Generic event/evidence reads filter released rows; only explicitly named internal-audit methods expose staging. Tests fail seeded mid-turn faults after assistant content, semantic checkpoint, lesson state and evidence, plus abort, supersession and end; completed replay remains write-idempotent. | Focused fallback/store Vitest: provider fault and lifecycle cases pass with zero generic events/evidence and unreleased internal staging. Deterministic PASS; deployed provider/network faults UNVERIFIED. |
| P1-3 response cue annotation | `ResponseSegmentAnnotator` gives audio exact cumulative PCM offsets, buffers transcript and semantic cues until segment seal, distributes transcript deltas by character weight across complete PCM, and places visual/pen/character semantic state at the boundary. RealtimeSession queues lesson state on the same heard-sample scheduler. Proxy tests drive raw transcript-before-audio/audio-before-tool/cancelled sequences; session tests prove no future caption/visual/state/final release at 480 of 24,000 samples and reject stale interruption/navigation identities. | Focused proxy/annotator/RealtimeSession/ResponseCueTimeline tests pass. This is conservative sample timing, not provider word timestamps. Target hardware/live provider remain UNVERIFIED. |
| P1-4 AV evidence integrity | Evaluator now derives every retained metric from production `ResponseCueTimeline`, `CharacterAttentionController`, observed scheduler/controller frames, and PCM windows. It counts post-silence audio resumptions and rejected post-cancel cue writes from trace data. Assigned mobile/desktop frames, co-emitted detector/stop, and locally claimed rendered pen/mouth/character phase gates were removed. All eight retained gates have independent failing negative mutations. Generic drawbox MP4 was removed and is no longer generated. | `npm run test:av -- artifacts/evaluation` exits 0; JSON records `browserFramePerformance=NOT_CLAIMED`, `renderedCharacterPenMouthPhase=NOT_CLAIMED`, target acoustics/live provider `UNVERIFIED`; JSON and WAV only. Deterministic module/PCM PASS. |
| P2-5 mobile focus/reachability | Focus begins at newly highlighted/key equation, comparison marks, point/projection, plot or labelled box. Required text/equation nodes each receive a reachable focus view; partially clipped neighbouring text is hidden. Labelled group/previous/next/overview controls remain. Harness removed the frozen 720 px mobile minimum. | Canonical unit tests prove every required node reachable and key text in view 0. Browser geometry iterates every view and requires full DOM containment, ≥16 px visible educational text, ≥44 px controls and no document overflow. Actual Lesson passes at 320×700, 390×844, 844×390 and 200% zoom. Eight reviewed mobile baselines updated; nine mobile-focus tests pass. Physical touch/screen-reader review UNVERIFIED. |
| P2-6 acceptance depth | Added direct proxy tests, RealtimeSession release tests, projection regression cases, generic-read visibility tests, and per-node browser geometry. Existing exact canonical semantic assertions and core onboarding/timeline/brand behavior remain in the full offline gate. | Full Vitest: 27 files / 137 tests pass; full visual 31/31, accessibility 3/3 and E2E 4/4 pass. Full commands recorded in final handoff. |

Cycle-2 generated evidence: `artifacts/evaluation/synthetic-av-character-report.json`, `artifacts/evaluation/synthetic-interruption.wav`, `artifacts/browser/lesson-semantic-mobile.png`, and the eight tracked `scene-*-mobile-focus` baselines. These do not substitute for target-device acoustics, physical touch, screen-reader or live-provider evidence.
