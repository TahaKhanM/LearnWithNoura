# Drawing vNext — implementation prompt for GPT-5.6 Sol (Codex)

Copy everything below this line into a Codex session started at the repository root.

---

## Role and mission

You are GPT-5.6 Sol acting as the principal engineer implementing the approved
Drawing vNext architecture for Noura, a voice-first child tutor (live at
learnwithnoura.com). The architecture was decided from a full working-tree
audit, live latency probes against the configured provider, current provider
documentation, and current research on educational diagram generation. The
investigation is complete; do not repeat it. Your job is execution at the
highest quality the repository has ever seen.

Arm a durable goal before your first edit:

```
/goal Implement Drawing vNext (docs/architecture/2026-08-30-drawing-vnext-implementation-prompt.md) milestone by milestone: streaming step-structured Director, adaptive vision audit, role-based model configuration + bake-off adoption, deterministic template lane, decoupled illustrations on gpt-image-2, grounding hardening, precomputation, classic-path removal. Every milestone ends with all README verification gates green, browser-verified behavior on the real lesson page, updated docs, and dead code removed. Completion requires the Definition of Done at the end of the prompt to be evidenced, not asserted.
```

If `/goal` is unavailable in your environment, maintain the same contract
manually: keep the full objective intact across turns, never redefine success
around a smaller task, and audit completion requirement-by-requirement against
current repository state before claiming it.

Your mandate, in priority order:

1. **Quality over everything.** No compromise, no shortcut, no "works but
   messy." If you find yourself adding a flag, timer, heuristic, or special
   case to work around a structural problem, stop and fix the structure.
2. **Tests define behavior.** Write the failing test first for every behavior
   change. When an existing test encodes wrong behavior, change it
   deliberately and say so in the commit message.
3. **Verify in a real browser.** Every milestone that touches rendering,
   staging, reveal timing, or grounding must be verified by driving the actual
   lesson page (offline fake transport) and the dev board harness in a
   browser, inspecting screenshots — not only by unit assertions. Details
   under "Browser verification protocol".
4. **Honest reporting.** Separate what is proven offline from what requires
   authorized live-provider verification. Never claim a live behavior is
   fixed from green offline tests. Never present an assumption as a result.
5. **Adversarial self-review.** Before closing each milestone, re-read your
   diff as a hostile reviewer: hunt stale-async races, epoch/generation
   leaks, permanence violations, silent fallbacks, and prompt/schema/validator
   drift. The Phase 3a rework history (`2026-08-26-phase-3a-board-director-handoff.md`,
   "Rework after the adversarial review") shows the standard: assume your
   first pass has findings of that class and find them yourself.

Work milestone by milestone, in order (parallel-safe milestones are marked).
Do not start a milestone until the previous one's acceptance criteria pass.
Commit at each coherent step with clear messages. Do not push, deploy, or
spend money on live-provider calls without explicit user authorization in the
session.

## Required reading before any edit

Read completely, in this order:

- `README.md`
- `docs/architecture/2026-08-23-noura-runtime-architecture.md`
- `docs/architecture/2026-08-26-drawing-runtime-recovery.md`
- `docs/architecture/2026-08-23-board-intelligence-v2.md`
- `docs/architecture/2026-08-26-phase-3a-board-director-handoff.md` (including the rework section)
- `docs/architecture/2026-08-26-phase-3b-renderer-and-regions-handoff.md`
- `docs/architecture/2026-08-26-phase-4-illustrations-handoff.md`
- `docs/operations/testing-and-evaluation.md`
- `server/realtime/visualRequests.ts`, `server/board/director.ts`,
  `server/board/directorSchema.ts`, `server/board/directorPrompts.ts`,
  `server/board/directorService.ts`, `server/board/illustration.ts`
- `server/realtime/storyboardRunner.ts`, `server/realtime/boardStaging.ts`,
  `server/realtime/toolHandling.ts`, `server/realtime/turnFloor.ts`
- `shared/boardOps.ts`, `shared/authoredSpecs.ts`, `shared/semanticScene.ts`,
  `shared/compiledLesson.ts`, `shared/sessionTelemetry.ts`
- `src/lesson/LessonPage.tsx`, `src/lesson/realtimeSession.ts`,
  `src/lesson/responseTimeline.ts`, `src/board/sceneCoordinator.ts`,
  `src/board/snapshot.ts`
- `server/runtimeConfig.ts`, `server/app.ts`

Record the green baseline first by running every README verification command.

## Investigation findings you build on (do not re-derive)

These are established facts from the architecture investigation (2026-08-28).
Verify any provider claim against live docs before relying on it; if reality
diverged, stop and write a decision note in `docs/architecture/` before
proceeding.

**Baseline latency (measured).** The Director slow path is two sequential
non-streaming Chat Completions rounds (`gpt-5.6-terra`,
`reasoning_effort: medium`, `response_format: json_object`) plus four browser
round-trips. Probes (n=5 intents, warm): proposal round alone 6.8–27.1s
(mean ~13.9s) at medium; 5.4–15.0s (mean ~8.7s) at low, but low effort dropped
the `storyboard` field once in five under plain `json_object` mode. Streaming
probes: after the first content token, the first *valid* BoardOp completes
within ~300–500ms; time-to-first-valid-op ran 4.6–8.4s (terra-low) vs
6.7–21.5s for the full proposal — a 40–50% first-paint cut on the current
provider, with reasoning TTFT the remaining floor. The single recorded live
trace matches: 15.4s Director scene, 59.6s cold compile.

**Model catalogue (verified via live discovery).** The OpenAI key has
`gpt-5.6-terra/sol/luna`, `gpt-realtime-2.1(-mini)`, `gpt-image-2`.
`gpt-image-1.5` (current illustration default) is scheduled for API removal on
2026-12-01 — the migration to `gpt-image-2` is forced. Streaming probes also
covered `gpt-5.6-luna` (cheaper tier): at low effort its time-to-first-valid-op
ran 4.6–8.2s with 3/3 fully valid scenes — a credible cheap candidate for
composition and especially for the vision-audit role.

**Product decision: OpenAI is the sole model provider.** No other provider
credentials exist in the project and none may be added. All model roles
(composition, vision audit, illustration, sketch grounding) are filled from
the OpenAI catalogue on the configured key.

**Repo facts.** The client cue timeline already supports per-step held cues
(`await_narration`) — the streaming server change needs almost no client
protocol change. Sixteen exact templates exist in `shared/semanticScene.ts`
(`adaptSemanticScene`) but only the compiler uses them; the Director's
deterministic gate covers number lines only (`exactTemplateScene` in
`director.ts`). Known grounding defects: candidate rasters are built from an
empty coordinator (vision never sees surrounding sections;
`LessonPage.tsx` ~308–325), snapshot equations degrade to plain text
(`src/board/snapshot.ts`), and the harness `nouraRenderScene` skips the
annotation layout the lesson path applies. The duplicate final preflight in
`startDirectedScene` is redundant once per-step preflight exists.

## Non-negotiable invariants (preserve throughout)

- Visible tutor work is permanent: no live `replace`, no raw model `clear`,
  no same-turn erase, no silent section switching.
- Deterministic validation is the sole correctness authority. Model output —
  including any vision verdict — is advisory. Every op passes
  `validateOps({ tier: 'authored' })` + `applyDirectorBoardPolicy` + the
  connected browser preflight before it can be staged. Never weaken this to
  make streaming easier.
- The exact geometry compiler (KaTeX, axes/plots, collision/quality gates) is
  a strength: extend it, never replace it with model-generated SVG blobs.
- Learner drawings are explicit drafts until Done; the server is the sole
  owner of `response.create`; three-state visibility
  (queued / `ops_presented` / `ops_shown`) and released-only replay stay intact.
- The voice model receives intent-only visual vocabulary; `promptConsistency.test.ts`
  pins this — keep prompt, tool schemas, validators, and docs in sync in the
  same commit that changes any of them.
- Provider API keys never reach the browser. No learner PII in Director or
  audit inputs (intents + board rasters only) — add a test pinning this.
- Additive migrations only; SQLite/Postgres/portable parity (`npm run test:storage`).
- Do not use real child data anywhere. Live provider calls only with explicit
  user authorization, short and synthetic.

## Browser verification protocol (applies to every milestone)

Playwright is installed; the suites run fully offline with a fake transport.
Use the browser as a first-class verification instrument, not a formality:

1. `npm run dev` starts client (5173) + server. The board harness page is
   `http://127.0.0.1:5173/dev/board`; the Playwright servers set
   `NOURA_LESSON_COMPILER=fixture`, so no provider calls occur from test runs.
2. For each milestone touching reveal/staging/rendering: extend or add a
   Playwright spec under `tests/e2e/` that drives the real lesson page through
   the changed behavior (storyboard build, interruption mid-stream, audit
   rejection bridge, illustration late arrival, template-lane scene), and
   capture screenshots at the decisive moments. Inspect the screenshots
   yourself before calling the behavior verified; describe what you saw in
   the milestone report.
3. Run `npm run test:visual` and inspect any changed baseline pixel-by-pixel
   intent before accepting it. Never update snapshots blindly.
4. Run `npm run test:a11y` whenever the lesson surface changes.
5. Where a behavior is timing-sensitive (first paint, hold-until-verdict),
   assert it in the spec via the page's own telemetry/events rather than
   sleeps.

## The architecture you are building

One slow-path pipeline with three lanes, all converging on the existing
storyboard runner and the same `AnchorScene` shape:

1. **Anchor lane** (exists): compiled anchor scenes play unchanged.
2. **Template lane** (new): deterministic exact scenes with zero model rounds.
3. **Streaming Director lane** (rework): the model streams a scene as ordered
   reveal steps; each completed step is validated deterministically and staged
   while later steps still generate; an async vision audit gates semantics
   without sitting on the critical path; illustrations generate in parallel.

Reveal-gate policy (load-bearing, evidence-tuned): the audit is requested as
soon as step 1 is rasterized. Step 1's reveal waits for the verdict up to
`auditBudgetMs` (default 3500ms — reveals bind to the previous response's
playback boundary, so in-flight narration normally hides the wait). If the
budget expires, step 1 reveals on deterministic checks and the verdict gates
step 2 instead (reusing `await_narration` hold semantics). Audit hard-reject ⇒
abandon the un-revealed remainder via the existing fail-closed machinery with
one honest bridge; audit timeout ⇒ proceed and record
`vision_audit_outcome: timeout` (deterministic validation remains the hard
gate; availability must not hinge on the audit). M0 finalizes this policy by
pre-registered rule from measured audit latency and seeded-defect catch rates.

Failure semantics throughout: stream abort on `visualRequestEpoch` change
(AbortController); mid-stream invalid op, per-step preflight rejection, or
provider stream error ⇒ abandon un-revealed remainder fail-closed, one honest
note, revealed work stays (permanence); reconnect mid-stream ⇒ the
un-persisted remainder is abandoned (revealed steps already replay from
released board events; `directed_scene` persists once, terminally, after the
stream completes and whole-scene policy passes — no new replay semantics).

**The ambition bar.** The target experience is a tutor who starts sketching
almost as soon as she decides to draw: anchor, template-lane, and cached
scenes in ≤2s; novel scenes ≤8s p50 at M1, pushed toward ≤6s p50 by M2 if the
bake-off data supports it. With one provider, the reasoning TTFT floor
(~4–8s at low effort) cannot be prompted away, so exploit every legitimate
lever on this catalogue rather than accepting the floor:

- **Hedged racing:** stream the same intent from two configurations
  concurrently (e.g. terra-low ∥ luna-low), commit to whichever yields the
  first *valid* step, abort the loser. First paint becomes the minimum of two
  draws; the marginal cost is pennies next to realtime audio. Measured as an
  M0 condition; adopted in M2 if it wins.
- **Prompt caching:** the Director system prompt, kind list, and schema are
  large and static — structure every request as a static prefix + dynamic
  suffix so OpenAI cached input pricing and latency apply. Verify cache hits
  in usage telemetry.
- **Precomputation:** compiled anchors, pre-authored branch visuals, the
  directed-scene cache, and (M6) speculative stage-entry composition make the
  *likely* visuals instant so the TTFT floor is paid only for the genuinely
  novel.

## Approach limitations you must design around

These are known limits of the underlying techniques. The architecture already
encodes their mitigations — do not relax them, and keep them true in code:

- **AI image generation** (gpt-image-2): current image models cannot be
  trusted to render text, numbers, scales, measured geometry, or assessment
  targets (the research consensus rates diffusion text rendering as
  disqualifying for teaching content, and even the strongest models are
  imperfect). Generated pixels are therefore *background enhancement only*:
  every label, number, equation, arrow, and measured mark stays an exact
  BoardOp overlay. Generation takes tens of seconds — it must never block
  teaching, and the tutor never verbally promises a picture before it is
  ready (the banner is the only promise; partial-image streaming provides
  perceived progress). Regenerating the same subject produces visually
  different results — the normalized-brief cache is also a consistency
  mechanism, so one lesson never shows two different renderings of the same
  subject. Moderation and safety checks can refuse valid briefs — refusal
  fail-closes to a vector/asset diagram with honest speech, never a blank
  board. Enforce a per-lesson generation budget (≤2 generations; cache hits
  free) so cost and latency stay bounded.
- **Model-authored geometry:** language models are unreliable at exact
  coordinates, spacing, and quantitative correctness. That is why the
  deterministic validators and the template lane exist — model geometry is
  always a *proposal*, and exact educational content routes deterministic
  whenever parameters can be extracted without guessing.
- **Vision audit:** an MLLM judge has false-accept and false-reject rates and
  can return junk (junk counts as rejection, fail-closed). It is semantic QA
  layered *above* deterministic checks, never a substitute — its measured
  catch-rate (M0) decides how much gating weight it carries.
- **Learner-sketch understanding:** multimodal models still lag humans at
  grading rough hand-drawn work (SketchJudge). Vector features are spatial
  hints, never semantic claims; interpretation carries explicit confidence
  and asks a clarifying question on conflict rather than guessing.
- **Streaming early commitment:** a streamed scene commits early steps before
  seeing the whole layout, which can reduce whole-scene quality — measured by
  the M1 A/B study with a buffering fallback, never assumed away.
- **Reasoning TTFT:** the ~4–8s floor for novel scenes is a provider
  property. Attack it with hedging, caching, and precomputation — never by
  weakening validation, skipping preflight, or letting unvalidated ops paint.

## Milestones

### M0 — Model bake-off + first-class latency telemetry

Objective: pick composition/audit models on evidence; make drawing latency
measurable.

1. Telemetry (additive, Phase 0 pipeline): `visual_first_paint`
   (intent→`ops_presented`), `visual_scene_complete`, `director_stream_first_op`,
   `vision_audit_outcome` in `shared/sessionTelemetry.ts` + `telemetryGlue.ts`;
   extend `scripts/e2e-live-schema.mjs` allowlists.
2. Harness `scripts/evaluate-director.ts` + `package.json` script
   `test:director-eval` (offline fixtures by default; live behind an explicit
   authorization flag exactly like `e2e:live`). Corpus checked in under
   `server/board/eval/fixtures/`: 24 representative + 12 holdout intents
   (exact math/geometry, graphs/charts, scientific systems, timelines/causal,
   grammar structure, comparisons/part-whole, unfamiliar abstract, mixed
   diagram+illustration, revisions against an existing board raster). Holdout
   is never used for prompt tuning.
3. Conditions (all OpenAI): {terra-low, terra-med, luna-low, luna-med} plus
   one hedged condition {terra-low ∥ luna-low, first valid step wins},
   streaming, N=5 trials per condition per intent, warm+cold, with prompt
   requests structured static-prefix-first so cached-input behavior is
   measured too. Score: TTFT, time-to-first-valid-op, complete-scene time,
   strict-schema validity, real-validator pass rate, storyboard coverage,
   blind rubric-scored rendered rasters (fixed rubric checked in, judge model
   pinned), cost per scene (hedged condition reports combined cost).
   Pre-registered decision rule: composition winner = lowest
   time-to-first-valid-op among conditions with ≥95% first-pass validity and
   quality within one rubric grade of terra-med; ties break on cost; the
   hedged condition is adopted only if it beats the best single condition's
   p50 by ≥15% at acceptable combined cost. Bounds: hard spend cap ~$30;
   stop early if one condition wins every metric by >2×.
4. Vision-audit study: seeded-defect fixtures (semantic errors that pass
   deterministic checks: wrong shading, mislabeled value, reversed arrow) —
   measure audit catch-rate vs deterministic-check catch-rate for terra-low
   and luna-low as candidate audit models, and audit latency. This finalizes
   the reveal-gate policy and `auditBudgetMs`.
5. Sketch-grounding role test: 30-item synthetic sketch corpus (create via the
   board UI + programmatic jitter; no child data) — measure interpretation
   accuracy and confidence calibration per candidate, to decide (default off)
   whether a cheaper-model second opinion (`gpt-5.6-luna`) assists check
   grading in M5.

Acceptance: offline harness tests green; one authorized bake-off run recorded
as `docs/architecture/2026-XX-XX-drawing-model-bakeoff-decision.md` with the
summary table embedded and raw JSON committed under
`server/board/eval/results/` (the gitignored `artifacts/evaluation/` is not
used for decision evidence). All README gates green.

### M1 — Streaming step-structured Director (current provider; parallel-safe with M0 harness build)

Objective: first paint ≤8s p50 for novel scenes without changing provider.

1. Schema (`directorSchema.ts`/`directorPrompts.ts`): step-interleaved
   proposal `{groupLabel, template: VisualTemplate|null, representation,
   illustration?, steps: [{id, reveal, narration, ops: [...]}]}` — `template`
   is the schema-ordered first field. Strict constrained decoding
   (`json_schema`) where expressible.
2. `director.ts` becomes an async-iterator pipeline: stream-parse completed
   steps (incremental top-level-array parser; ~80 lines, prototyped in the
   investigation), per-step `validateOps({tier:'authored'})` + cumulative
   policy (density, id collisions, cross-step inspection), per-step browser
   preflight via `boardStaging.ts`, incremental step intake on
   `storyboardRunner.ts` (runner reveal/beat/handoff/pause/resume contract
   otherwise unchanged). AbortController wired to `visualRequestEpoch`.
3. Adaptive audit gate as specified above. Remove the duplicate final
   preflight in `startDirectedScene`. `directed_scene` persists once,
   terminally.
4. Interim model config: `gpt-5.6-terra` at `reasoning_effort: low` streaming
   with strict schema; one retry escalates to medium on validity failure.
   Structure the Director request as a static prefix (system prompt, kind
   list, schema, hard rules) + dynamic suffix (ledger, intent, raster) so
   prompt caching applies; assert the split in a unit test so later edits
   cannot silently break cacheability.
5. A/B fixture study on the M0 corpus: streamed step-committed scenes vs
   classic atomic scenes — acceptance within 5 percentage points AND rubric
   quality within one grade, else fall back to reveal-after-N-steps buffering
   (still strictly faster) and record the decision.
6. Temporary config `NOURA_DIRECTOR_PIPELINE=streaming|classic` (removed in M6).

Tests: scripted streaming doubles in `director.test.ts` (accept; mid-stream
invalid op; audit reject after step 1 with revealed work intact; audit
timeout proceeds; epoch abort mid-stream), `storyboardRunner.test.ts`
(incremental intake; reconnect mid-stream abandons remainder), integration +
new E2E storyboard-build variant with screenshots (browser protocol above).

Acceptance: all gates green; harness-measured first-paint path cut ≥40% vs
classic; no permanence/replay regression; browser verification report.

### M2 — Role-based model configuration + bake-off winner adoption (depends on M0 + M1)

1. Extract a narrow `SceneModelPort` (streamPropose / inspect) from
   `directorService.ts` so composition and vision-audit roles are configured
   independently on the existing OpenAI path. Do not add adapters for other
   providers; do not add provider credentials. Contract-test the exact
   production step schema under strict `json_schema` decoding, never a
   simplified version.
2. Env: `NOURA_DIRECTOR_MODEL|REASONING_EFFORT` (existing knobs, now driving
   the streaming path) + new `NOURA_VISION_AUDIT_MODEL|REASONING_EFFORT`.
   Adopt the M0 winners as defaults. If the hedged condition won its M0
   adoption bar, implement hedged racing here (`NOURA_DIRECTOR_HEDGE=on|off`,
   default per M0 decision): two concurrent streams, commit on first valid
   step, abort the loser, both legs epoch-scoped. Fallback chain stays within
   OpenAI: stream failure/timeout or validity failure ⇒ one retry at
   escalated configuration (low→medium effort; luna→terra) ⇒ honest
   fail-closed. Update `scripts/runtime-model-diff.mjs`.
3. PII invariant test: Director/audit request payloads contain intents +
   rasters only.

Acceptance: port contract tests green against recorded fixtures; one
authorized short live smoke on the adopted configuration; rollback is an env
flip.

### M3 — Deterministic exact template lane (parallel-safe after M1)

1. `server/board/templateLane.ts` with two entry points: (a) deterministic
   per-template extractors over intent text (generalizing the number-line
   regex) — zero model rounds; (b) stream-head short-circuit — a non-null
   `template` first field aborts the rest of the stream and compiles
   deterministically. Both map onto `adaptSemanticScene`; storyboard beats are
   synthesized deterministically from template checkpoint structure (conveyed-
   idea strings; the voice model phrases them — no extra model call). Hard
   rule: parameters are never guessed; ambiguity falls through to generative
   composition. Replaces `exactTemplateScene`.
2. Route in `visualRequests.ts`: anchor → template → streaming Director.

Acceptance: ≥8 of 16 templates live-reachable with correct params on
fixtures; template-lane first paint ≤2s on the harness; zero false template
captures on holdout intents; E2E fraction-comparison spec with screenshots;
`exactTemplateScene` deleted.

### M4 — Illustration decoupling + gpt-image-2 (parallel-safe after M1; hard deadline before 2026-12-01)

1. Default `NOURA_ILLUSTRATION_MODEL=gpt-image-2`. Move `prepare` out of the
   Director attempt loop: the Director emits brief + overlay steps; overlays
   reveal immediately; the image generates in parallel behind the existing
   `illustration_status` banner. Arrival: run still active ⇒ validated `image`
   add appended as a final reveal step; run completed ⇒ server-initiated
   checkpoint through ordinary staging/visibility. Safety refuse, cache,
   vision validation, exact-overlay invariant unchanged.
2. Encode the image-generation limitations as policy, not habit: a per-lesson
   generation budget (≤2 generations; cache hits free; over-budget requests
   fail-closed to vector/asset diagrams with honest speech), the tutor's
   prompt never promises a picture before arrival, and generation-latency,
   refusal, and cost land in the existing `illustration_generation` metric.

Acceptance: scripted-double tests for arrival orderings (image before/after
overlays; failure ⇒ overlays remain + one honest note) and for the budget
fail-closed path; browser-verified banner/arrival UX; one authorized live
illustration trace with latency + cost telemetry.

### M5 — Grounding hardening (parallel-safe after M1)

1. Candidate raster in context: `visual_render` with `semanticGroupId`
   applies the candidate to a copy of the live coordinator and rasters the
   active region (replacing the empty-coordinator path in `LessonPage.tsx`).
2. Snapshot equation fidelity: raster KaTeX (or measured-outline placeholder)
   instead of plain text in `snapshot.ts`; inspect and regenerate affected
   expectations deliberately.
3. Align harness `nouraRenderScene` with the lesson path (annotation layout).
4. Learner-sketch uncertainty protocol in grounding instructions
   (see-then-interpret, explicit confidence, clarifying question on
   vector/vision conflict); score the M0 sketch corpus offline; wire the
   optional cheaper-model assist only if M0 showed a significant gain.

Acceptance: raster tests prove the candidate includes surrounding board;
sketch baseline recorded; no learner-path regressions; browser screenshots of
before/after candidate rasters inspected.

### M6 — Precomputation + migration completion (last)

1. Compiler pre-authors misconception-branch/detour visuals as additional
   `AnchorScene`s (additive `shared/compiledLesson.ts` field); router prefers
   them like anchors.
2. `directed_scene_cache` (additive migration 005; SQLite + Postgres +
   portable parity): key = normalized intent + board fingerprint. A hit is
   never applied blind: ids remapped fresh, then revalidated through
   `applyDirectorBoardPolicy` + browser preflight against the current board.
3. Speculative stage-entry composition: when a stage brief names a likely
   visual need and no build is active, pre-compose into the cache in the
   background (epoch-scoped, budget-capped via config, never revealed without
   a real request + revalidation). This converts the TTFT floor into a cache
   hit for predictable mid-lesson visuals; measure hit rate before widening
   the trigger.
4. Remove `NOURA_DIRECTOR_PIPELINE` and all classic-path code; confine legacy
   replace semantics to replay modules; update README + ADRs; write the
   handoff note (proven offline / requires live verification / deferred).

Acceptance: branch-visual fixtures compile and route; cache-hit E2E;
speculative composition proven epoch-safe and budget-capped in unit tests
with measured hit rate on the fixture lesson; grep-level absence of the
classic path; all gates green.

## Engineering standards (all milestones)

- All README verification commands green at every milestone close:
  `npm run build`, `typecheck:server`, `lint`, `test:smoke-report`,
  `test:lesson-eval`, `npm test`, `npm audit --omit=dev`, `test:integration`,
  `test:e2e`, `test:visual`, `test:a11y`, `test:security`, `test:storage`,
  `test:brand`, plus `test:runtime-models` and (from M0) `test:director-eval`.
- No module over ~400 lines without a recorded reason. No `any`, no unused
  exports, no commented-out code, no drive-by reformatting.
- Delete superseded code once parity is proven; no accumulating flags beyond
  the one documented pipeline flag (M1–M6 lifespan).
- Prompt, tool schemas, validators, and docs change in the same commit.
- After each milestone: update README and affected ADRs; write a short
  handoff note in `docs/architecture/` separating (a) proven offline,
  (b) requires authorized live verification, (c) deferred.
- If a milestone's design conflicts with something you discover in the code,
  stop and write a decision note rather than silently improvising.

## Hard boundaries

- Do not deploy, push to remotes, create paid resources, or run live-provider
  calls without explicit user authorization in the session.
- Do not use real child data anywhere; synthetic fixtures only.
- Do not weaken permanence, draft-until-Done, floor-ownership, visibility, or
  evidence invariants to make a milestone easier.
- Do not migrate the realtime voice model or transport; this work is the
  drawing pipeline only.
- OpenAI is the sole model provider. Do not add other provider dependencies,
  SDKs, adapters, or credentials, and do not spend effort evaluating other
  providers.

## Definition of done

The goal completes only when automated coverage plus one authorized synthetic
live trace demonstrate, with inspected browser evidence: a child's mid-lesson
"draw…" request paints its first correct mark in ≤8s p50 — pushed toward
≤6s p50 where the M0 data justified hedging — and builds progressively in
step with narration; anchor, template-lane, and cached scenes paint in ≤2s;
an exact-math request renders through the template lane with exact values and
zero model rounds; an illustration request shows exact overlays immediately
with the image arriving without blocking, within the per-lesson generation
budget, and never carrying exact content in pixels; interrupting mid-build
pauses and resumes with nothing vanishing; a rejected, invalid, or failed
scene ends in one honest bridge with all revealed work intact; the board
replays identically after refresh; per-role latency, validity, retries, model
mix, cache hits, and cost are visible in telemetry; exactly one drawing
pipeline exists in the codebase; and the bake-off decision record, updated
ADRs, and milestone handoff notes are in `docs/architecture/`. Audit each
clause against current repository state and command output before marking the
goal complete.
