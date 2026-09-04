# Drawing vNext — M1 acceptance correction and continuation goal for GPT-5.6 Sol (Codex)

Start a Codex session at the repository root and run the `/goal` command below
as your FIRST action. The rest of this document is the goal's binding
specification; the goal is not complete until the Definition of Done at the
end is evidenced against the current repository state.

```
/goal Execute the Drawing vNext continuation specified in docs/architecture/2026-09-01-drawing-vnext-m1-acceptance-and-continuation-prompt.md end to end: fix the preflight-authority parity gap and the other listed defects failing-test-first; recompute M1 acceptance under the corrected layered gates from immutable hash-bound artifacts; measure the real ops_presented first-paint distribution offline on the actual lesson page; add the targeted streaming layout-correction round; build and check in the Curriculum Visual Coverage Matrix that defines "draw anything at 11+/SAT level"; flip the dev/preview default to streaming; complete M2 (role ports, luna-low audit adoption, correction/escalation recovery defaults) and M3 (template lane as accelerator, curriculum matrix informing routing, open-set generative acceptance). The end state this program is building toward is a tutor that, when a child does not understand, can compose whatever validated visual it takes at 11+/SAT level through the generative lane alone — the M7/M8 specifications in this document are the committed path there. Quality over everything; every README verification gate green at each milestone close; browser-verified behavior with personally inspected screenshots; provider spend only through fresh itemized user authorization per study, with caps treated as ceilings never targets; honest separation of offline-proven versus live-required evidence. Do not mark this goal complete until every Definition of Done clause is verified requirement-by-requirement against repository state and command output.
```

If `/goal` is unavailable, maintain the identical contract manually: full
objective intact across turns, no redefining success around smaller tasks,
requirement-by-requirement completion audit before any completion claim.

---

## Context: what the review of the previous session established

The previous session (M0 + M1 implementation) was audited line-by-line by an
independent architecture review, including the raw evidence ledgers. Its
findings are authoritative; do not re-derive them:

- The M1 **implementation is sound**: streaming pipeline, adaptive audit
  state machine, epoch/abort wiring, permanence, terminal `directed_scene`
  ordering, classic-default flag, and closed-signal telemetry all check out.
  The gate matrix genuinely passes (independently re-run).
- The M1 **acceptance gate was mis-specified in the original prompt**: one
  ambiguous "≥95% first-pass validity" bar, implemented as the strictest
  four-way conjunction. The measured gap is entirely browser layout placement
  (stroke collisions/bounds): strict schema 360/360, policy+coverage 360/360,
  browser preflight 329/360 (91.4%). Dense-geometry intents (unit circle,
  fraction strips, plotted graphs) dominate the failures.
- An independent terra-medium proxy recovers 26/31 layout failures (~98.6%
  post-recovery estimate) — but it is not a true conditional retry study.
- The "43.6% first-paint cut" evidence is a provider-timing proxy; the real
  intent→`ops_presented` distribution was never measured (it costs $0).
- One real correctness gap: production per-step preflight validates less than
  the evidence authority did (new-scene ops only vs board+candidate).
- The sketch study "10% accuracy" is mode collapse (both models answered
  "straight line" on all 30 items) — an uninformative corpus artifact.
- Spend: $29.73 of the $30 cap. ~43% ($12.72) went to unretained diagnostic
  attempts, and the run proceeded despite the planner reporting the matrix
  did not fit the cap. The spend rules below exist because of this.

## The capability target (read before any trade-off decision)

The product teaches children at **11+ and SAT level**, and when a child does
not understand a concept, the tutor must be able to **illustrate whatever it
takes** — compose essentially any visual that curriculum demands,
autonomously, with low perceived latency and honest exactness. This is a
defined, measurable capability, not a slogan:

- **The concrete coverage definition** is the Curriculum Visual Coverage
  Matrix (built this session, task T1 below): 11+ non-verbal reasoning's ~14
  question types in three families (interpreting shapes: sequences, matrices,
  analogies, codes, odd-one-out; moving 2D: rotation, reflection, hidden
  shapes, paper folding/hole-punch, combining shapes; moving 3D: nets/cubes,
  rotating solids, block building, plan views), SAT maths (transformations of
  points/shapes/function graphs, coordinate geometry, systems and
  inequalities, data analysis: scatterplots/histograms/boxplots/two-way
  tables), KS2/SAT arithmetic models (bar models, fraction strips/areas/sets,
  ratio tables, number lines), and science/English support (labelled
  processes, grammar trees, timelines). Every row maps to primitives that
  exist, compose, or are missing — the missing set defines M7's scope.
- **The generative lane is the product core.** Templates (M3) are latency
  accelerators for known exact shapes — never the ceiling, never the excuse.
  The binding proof is M8's **templates-off gate**: every curriculum domain
  must reach ≥90% delivered validity (≥95% target) through the generative
  lane alone, template and anchor lanes disabled, on sealed holdout intents.
  Coverage must provably never depend on the catalogue.
- **Exactness stays deterministic as capability grows.** New curriculum
  primitives follow the standing philosophy — the model supplies parameters,
  code computes geometry. In particular `transform`
  (rotate/reflect/translate/enlarge of referenced objects) exists so a model
  never hand-computes transformed coordinates: both 11+ NVR and SAT
  transformation content become exact by construction.
- **Layout reliability is fixed at the source, not just patched.** Research
  (Penrose; the Feynman diagramming agent) shows diagram meaning lives in
  relative relationships, and staged constraint layout is what makes
  machine-generated layout reliable. M7 adds a deterministic relational
  placement layer (`place: {anchor, side, gap, align}` resolved client-side
  in stages) so the Director expresses relationships while code computes
  coordinates — attacking the measured dominant failure class (stroke
  collisions/bounds) structurally; the F9 correction round remains the
  backstop.
- **Annotation is core architecture, not an emergent skill (M7 part 0).**
  The board must mark anything easily: tutor drawings, learner strokes, and
  regions inside images (the substrate for future past-paper and
  answer-marking features). One addressing model — `AnchorRef`: semantic
  object + deterministic sub-anchors exported by every spec compiler
  (number-line ticks, table cells, vertices, bar tops), learner-stroke ids,
  and normalized image regions persisted as a W3C-style selector union for
  robust replay. One `annotate` spec kind (circle/underline/arrow/tick/
  cross/bracket/callout/highlighter) where the model says what to mark and
  code computes the geometry — available to the FAST tier so annotation on
  visible objects is sub-second with zero vision calls. Image-region
  grounding follows current research (Set-of-Marks; GUI-Lens): structured
  hints, VLM proposal, then a render-back self-check through the existing
  vision-audit machinery, with a child-tap fallback under low confidence.
  Annotations never mutate their target; permanence applies.
- **"Whatever it takes" is an orchestrated behavior (M8):** on
  misunderstanding evidence, the server requires a *different* validated
  representation of the same concept (concrete–pictorial–abstract ladder),
  bounded per stage, measured by a `re_representation` telemetry metric and
  a browser-verified E2E flow.
- **Latency targets are set by measured reality, not caution.** M0 measured
  warm p50 TTFT 1,122ms and p50 first-valid-op 2,834ms on terra-low. The
  first-paint ambition is: novel-scene intent→`ops_presented` p50 ≤4s,
  stretch ≤3s (harness-measured, G4); anchor/template/cached ≤2s. The old
  ≤8s figure is retired as stale.
- **Exactness and permanence are never traded for any of this.**
  Deterministic validation and the connected-browser authority remain the
  hard gate; ambition is reached by better vocabulary, placement, feedback,
  and orchestration — never by weakening checks (the reverted metric-gaming
  repair is the standing example of what not to do).

## Spend rules (binding; corrects the previous session's inefficiencies)

1. **Caps are ceilings, never targets.** Ending a study far under cap is
   success, not underuse. Default for everything in this goal: $0 (offline
   replay of hash-bound artifacts, fake-transport lesson page, `/dev/board`).
2. **Fresh, itemized authorization before any paid call**: exactly what runs,
   expected call count, conservative cost, and the decision the evidence
   changes. One study per ask; no batching unrelated spend.
3. **Fit-before-launch**: if a planned matrix does not fit its cap in the
   conservative plan, shrink the design before any live call. Never launch
   relying on the ledger to stop you mid-run — that is how 43% of the last
   budget became diagnostic churn.
4. **Canary-then-scale**: before any full matrix, prove the exact live path
   with an offline dry-run, then a ≤5-call live canary, then scale. Harness
   bugs must never be discovered by the full matrix.
5. **Staged design**: screen with the minimum informative sample, confirm
   only finalists at full N. Do not re-run cells whose outcome cannot change
   the decision (the pre-registered early-stop rule applies at every stage).
6. **Bounded transport retries with fail-fast**, and no paid re-attempts to
   fix accounting or resume mechanics — those are proven offline first.

## Corrected M1 acceptance gates (architecture-owner decision)

This is a specification correction by the architecture owner, recorded here
before recomputation. The pre-registered M0 negative result stands unedited;
append an addendum to
`docs/architecture/2026-09-01-drawing-model-bakeoff-decision.md` linking here
— do not rewrite its history.

M1 is accepted when ALL of the following hold, computed from immutable
hash-bound artifacts (existing or newly created):

- **G1 — Structured validity ≥95% single-shot** (strict schema + authored
  policy + storyboard coverage). Terra-low measured 360/360; recompute, cite.
- **G2 — Full conjunctive first-pass ≥90% single-shot under the production
  preflight authority** (after fix F1). Measured 91.4% under the eval
  authority; re-verify by $0 replay under the fixed production authority.
- **G3 — Delivered-scene recovery ≥97%**: of first-pass layout failures, the
  production recovery path (targeted correction round and/or terra-medium
  escalation, per the F9 study) recovers enough that ≥97% of requested scenes
  deliver, with honest fail-closed on the remainder. Evidence: the F9
  micro-study (paid item 1). If authorization is declined, record G3 as
  proxy-only (~98.6% estimate, caveat documented), accept M1 provisionally on
  G1/G2/G4/G5, and verify G3 through M2's live-smoke telemetry.
- **G4 — Real first-paint distribution, $0, harness-measured**: replay the M0
  provider timing distribution through the fake voice transport into the REAL
  lesson page; measure actual intent→`ops_presented` for streaming vs
  classic on identical scenes. Acceptance: p50 cut ≥40% vs classic AND
  streaming p50 ≤4s (stretch ≤3s). Inspect screenshots at first paint.
- **G5 — No permanence/replay regression; all README gates green** after all
  fixes below.

The 95% single-shot conjunctive figure is retired as a generative-lane gate
and re-anchored as the system-level bar it was always meant to be:
`blended_first_pass_validity ≥95%` across anchor/template/cached/generative
lanes (tracked from M3), **plus** the generative-lane ambition of ≥95%
delivered validity via F9's correction path — both achieved by better
routing and feedback, never by weakening any check.

## Defects to fix (failing-test-first; all before M1 acceptance)

**F1 (High) — Preflight authority parity.** Production streaming validates
only the new scene's cumulative ops with scoped-group inspection
(`server/board/streamingDirector.ts:86-99` →
`src/board/sceneCoordinator.ts:73-88`); the M1 evidence validated
`[...existingOps, ...cumulativeOps]`
(`server/board/eval/m1PipelineStudy.ts:86-91`). Make production validate the
candidate in board context (matching the eval and classic semantics), prove
the divergence with a failing test first, re-run the $0 paired replay under
the fixed authority, recompute G2, hash-bind the artifacts.

**F2 (Medium) — Late-reject hang window.** A post-budget audit reject waits
on `onFirstDurable` (`adaptiveVisionAuditGate.ts:140-155`); a client that
never paints and never times out strands the side-effect task. Ensure
terminal resolution is also reachable from the step-reveal timeout and
reconnect abandonment; add the stuck-client test.

**F3 (Medium) — Audit port constructed under classic** (`server/app.ts:104-111`)
where nothing uses it. Construct only for streaming; test that classic mode
creates no audit surface.

**F4 (Medium) — Number-line short-circuit missing from the streaming lane**
(classic has it at `director.ts:111-117`). Do not port the special case; pull
the M3 template-lane routing ahead of the stream for the number-line template
only (deterministic extractor → `adaptSemanticScene` → preflight) as the
first M3 slice.

**F5 (Medium) — Classic vision loop injects free-form judge text** into
correction prompts (`director.ts:208-209`, `319-324`), reachable via the
illustration fallback. Map classic vision issues to the same closed codes the
adaptive gate uses before they touch any prompt or log.

**F6 (Low) — Size and docs.** `storyboardRunner.ts` (~701 lines): extract the
audit-hold and streaming-intake sub-machines or record the cohesion reason in
the file header. Document `NOURA_DIRECTOR_PIPELINE` in README and the active
runtime ADR. Fix the misleading `.env.example` effort comment (classic
default is medium). Fix the handoff's invalid `--reporter=basic` reference.

**F7 (Low) — Telemetry hygiene.** Strip `VisionAuditEvent.issues` free text
at the event boundary (`streamingVisualRequest.ts:162`) so no caller can log
it.

**F8 (Process) — Working-tree overlays.** 24 files carry pre-existing
uncommitted auth + drawing-recovery overlays (e.g. `visualRequests.ts` is 400
lines at HEAD, 480 dirty). Never commit, revert, or modify the auth work
(`server/auth.ts`, `src/auth/*`, `api/auth/*`, auth README/env edits). Stage
hunks selectively so only drawing work lands. If the dirty drawing-recovery
logic conflicts with your modules, reconcile in the working tree without
committing auth portions, and record the reconciliation in the handoff.

## F9 — Targeted layout-correction round (the ambition fix; includes paid item 1)

The failure taxonomy says the generative lane's only material weakness is
layout placement. The ambitious, correct fix is a **targeted correction
round**, not template avoidance and not blind whole-scene retry:

- On a browser-preflight layout rejection, send one bounded correction
  request carrying the closed rejection codes plus the exact colliding object
  ids and bounding boxes, asking only for corrected placements of the
  offending ops (stream, low effort, cheap — the classic Director's
  correction loop proved the pattern; the reverted deterministic multipass
  repair proved deterministic nudging alone harms quality).
- Corrected output passes the identical validation chain (policy → browser
  preflight → audit). Never bypass; never expose free-form judge text.
- Runtime order of recovery: targeted correction first (cheap), terra-medium
  whole-scene escalation second (expensive), honest fail-closed third.

**Paid item 1 — recovery micro-study (request authorization first):** on the
31 recorded terra-low layout failures, run three arms — (a) terra-medium
escalation, (b) targeted low-effort correction with collision feedback,
(c) correction-then-escalation. Design to fit ≤$5 conservative (~90–120
calls); canary 3 intents first; early-stop an arm once its outcome cannot
change the decision. Pre-registered rule: adopt the cheapest arm chain
reaching ≥97% delivered validity with blind-grade quality within one grade of
the M0 sample; that arm chain becomes the production recovery default (M2)
and the G3 evidence.

## Corrections to recorded conclusions (evidence, not code)

- **C1 — Sketch study is uninformative, not negative** (constant-answer mode
  collapse; exact-string grading on a non-enum field). Assistance stays off;
  re-label the conclusion in an addendum; corpus rebuild (enum-constrained
  answers, human-verifiable renders, realistic stroke sizes) is an M5 task —
  no spend now.
- **C2 — Hedge rejection stands** (lower validity at higher cost).
- **C3 — Evidence bloat is acknowledged, not repeated.** Commit derived
  reports + hashes; keep raw ledgers gitignored unless a decision record
  names and hashes them as its source.

## T1 — Curriculum Visual Coverage Matrix (this session, $0, before M3)

Build and check in the matrix that operationalizes the capability target:
`server/board/eval/curriculum-matrix.json` plus a short companion doc. Rows:
every visual type from the taxonomy in "The capability target" above.
Columns: required primitives/capabilities; current status
(`supported` — direct spec kind exists; `composable` — buildable from
existing kinds with acceptable effort; `missing` — needs a new primitive);
the deterministic-lane template if any; and at least two eval intents per
row (these seed corpus v2). Include annotation rows: marking tutor objects
and sub-parts (ticks, cells, vertices), marking learner strokes, and marking
image regions (the past-paper/answer-marking substrate). Validate status
claims by actually compiling a representative fixture per `composable` row
through the real pipeline — no status by assertion. The `missing` set
defines M7's scope (expected: the `annotate`/`AnchorRef` layer plus
`transform`, `panelGrid`, `regionFill`, `scatter`/`boxplot`/`histogram`,
nets/solids/plan-view family, paper-fold/hole-punch, and parametric
instruments such as grid paper, clock, protractor). The matrix informs M3
routing decisions and is the acceptance instrument for M7/M8.

## Continuation after M1 acceptance

**Flip the default:** dev/preview `NOURA_DIRECTOR_PIPELINE=streaming`;
classic stays solely as the documented rollback until M6 removes it.

**M2 — Role ports + adoption:** extract `SceneModelPort`; env knobs
`NOURA_DIRECTOR_MODEL|REASONING_EFFORT` + `NOURA_VISION_AUDIT_MODEL|REASONING_EFFORT`;
adopt luna-low audit (M0 evidence: 100% catch, 8.3% false-reject, p95
2,398ms); composition default = terra-low + the F9-winning recovery chain,
labeled "corrected-gate evidence", never "M0 winner". Hedge stays off. PII
invariant test. **Paid item 2:** the plan's short authorized live smoke on
the adopted configuration, repeating the previously failed
second-board-change gate with the new telemetry — itemize and ask first;
one short synthetic lesson.

**M3 — Template lane, MECHANISM-ONLY scope (re-scoped 2026-09-02 by the
architecture owner; supersedes the earlier "≥8 of 16 templates" bar):**
this program's priority is the underlying engine, not lesson-content
authoring. M3 is complete when the *routing mechanism* is proven, not when
the catalogue is populated:

- The lane infrastructure: both entry points (deterministic extractor and
  stream-head short-circuit), the never-guess-parameters contract with
  fall-through to generative composition, `exactTemplateScene` replaced,
  routing order anchor → template → streaming Director, and the ≤2s
  first-paint path.
- Proven with exactly **three exemplar templates** (number line, fraction
  strips, one plotted graph) — enough to exercise both entry points, the
  fall-through, and false-capture rejection on holdout intents. Adding
  extractors beyond these three is explicitly OUT of M3 scope: broad
  per-template extractor coverage is content-shaped work, deferred behind
  the engine layers and pulled matrix-row-by-row only when a lesson domain
  needs it (M8 at the earliest).
- The open-set generative-lane check stays in M3 (it is an engine property):
  on unfamiliar/abstract/novel intents that templates must never capture,
  delivered validity ≥95% via the F9 recovery chain.
- The `blended_first_pass_validity ≥95%` gate MOVES to M8 (it depends on
  coverage breadth, which is deliberately deferred).

After minimal M3, proceed DIRECTLY to M7 parts 0–2 — the anchoring/
annotation layer, relational placement, and the curriculum primitives are
the engine this program exists to build; they must not queue behind
template-catalogue population.

**M4–M6** remain as specified in the original prompt
(`docs/architecture/2026-08-30-drawing-vnext-implementation-prompt.md`),
including the gpt-image-2 deadline (2026-12-01), grounding hardening, the
sketch-corpus rebuild (C1), precomputation, and classic-path removal — with
M6 (cleanup) moved to last, after M7/M8.

**M7 — Anchoring/annotation layer + curriculum vocabulary + relational
placement (after M3; parallel-safe with M4/M5).** Three parts:

0. **The anchoring + annotation layer (core, first):** the shared
   `AnchorRef` type (semantic object + compiler-exported sub-anchors;
   learner-stroke; normalized image region with selector-union persistence;
   raw point as last resort); the `annotate` spec kind
   ({style: circle|underline|arrow|tick|cross|bracket|callout|highlighter,
   target: AnchorRef | AnchorRef[], note?}) — fast-tier AND authored-tier,
   geometry always computed by code from resolved anchors; the image-region
   grounding service (structured hints → VLM proposal → render-back
   self-check via the adopted luna-low audit → tap fallback under low
   confidence); annotations are tutor-owned overlays that never mutate their
   targets. Evidence: a grounding micro-study on synthetic worksheet images
   (pointing accuracy, self-check catch rate, tap-fallback rate; itemized
   authorization) plus fast-tier and grounded E2E rows with inspected
   screenshots.
1. New authored-tier spec kinds, model-parameters/code-geometry, each with
   validation + compile + inspection + occupancy + quality + describeScene +
   visual baseline, failing-test-first: `transform` (rotate/reflect/
   translate/enlarge of referenced objects — never model-computed
   coordinates), `panelGrid` (N×M scoped mini-scene panels for NVR
   sequences/matrices/analogies/odd-one-out), `regionFill` (intersections/
   unions/half-planes for Venn, inequalities, fraction shading),
   `scatter`/`boxplot`/`histogram`, the 3D family (isometric solids, cube/
   cuboid nets with face labels, plan views), paper-fold/hole-punch panels,
   and parametric instruments (grid/dot paper, clock, protractor overlay).
2. The relational placement layer: authored ops gain optional
   `place: {anchor: objectId, side: above|below|left|right|inside|on, gap,
   align}`, resolved deterministically client-side in stages (structure →
   relational placements → existing annotation lanes) before inspection.
   Director prompt prefers relational placement for labels/annotations/
   relations; absolute coordinates remain for exact quantitative geometry.

Acceptance: every matrix row `supported` or `composable`; M0-corpus replay
with relational placement shows single-shot conjunctive validity ≥95% on
representative rows (offline replay where possible; otherwise an authorized
micro-study under the spend rules); the annotate layer passes fast-tier
(semantic/stroke anchors, sub-second, zero vision calls) and grounded
(image-region, render-back-verified, tap fallback) E2E rows; no latency
regression on G4's harness.

**M8 — Re-representation + curriculum-scale acceptance (after M7).**

1. Re-representation policy: on misunderstanding evidence, the server
   requires a different validated representation of the same concept
   (concrete–pictorial–abstract ladder), bounded per stage, with a
   `re_representation` metric (trigger, ladder step, subsequent check
   outcome) and a browser-verified E2E flow with inspected screenshots.
2. Curriculum corpus v2: 150–250 intents spanning the full matrix, sealed
   ≥30% holdout, including re-representation intents and open-set novel
   phrasings. Deterministic rows are $0; generative rows run staged
   screen→confirm under the spend rules with itemized authorization.
3. **Templates-off gate:** per curriculum domain, ≥90% delivered validity
   (≥95% target) through the generative lane alone (template and anchor
   lanes disabled) on holdout, via the recovery chain — the falsifiable
   form of "draws anything at this level without depending on templates".

Acceptance: per-domain blended delivered validity ≥95%; templates-off gate
passed; re-representation verified in the browser; latency targets held;
all gates green.

## 2026-09-04 opening-anchor production clarification

For a `board_led` lesson whose Current stage has board purpose
`establish_anchor` and whose anchor is not yet visible, the voice tutor's
opening response has a mandatory ordering: one short greeting, then a
same-response `request_visual` call with action `establish`, before any
substantive explanation, `propose_teaching_move`, or learner question. The
voice tutor still supplies intent only; the compiled anchor, deterministic
validation, storyboard visibility protocol, and permanence rules remain the
sole path to visible work. This ordering is pinned by
`server/realtime/promptConsistency.test.ts` after production session
`350f7a79-857d-4d81-920b-b29d3d49ee0b` persisted ordinary lesson/tool
activity but no visual ingress or downstream drawing events. Live recovery
is not proven until the mandated post-deploy provider smoke passes.

## Unchanged constraints

Everything in the original prompt's "Non-negotiable invariants", "Browser
verification protocol", "Engineering standards", and "Hard boundaries"
applies verbatim: OpenAI is the sole provider; failing tests first;
adversarial self-review before each milestone close (Phase 3a rework
standard); inspected screenshots for every rendering-path change; never
update visual baselines blindly; honest offline/live separation; no
deploy/push/paid calls without explicit authorization; no real child data.

## Definition of done for this goal

M1 accepted under G1–G5 with hash-bound recomputed evidence and a decision
addendum; F1–F8 fixed failing-test-first; F9 implemented with its
micro-study run (or its declined-authorization fallback recorded) and the
winning recovery chain adopted; C1–C3 addenda recorded; T1's Curriculum
Visual Coverage Matrix checked in with fixture-validated statuses and the
M7 `missing` set enumerated; dev/preview default flipped to streaming with
classic as documented rollback; M2 complete (ports, knobs, luna-low audit,
recovery default, live smoke if authorized); M3 complete at its
MECHANISM-ONLY scope (lane infrastructure + three exemplar templates + the
open-set generative-lane check; the blended-validity gate moved to M8);
novel-scene first paint p50 ≤4s
harness-measured (stretch ≤3s) and anchor/template/cached ≤2s; all README
gates green; README/ADR document the flag, the corrected gates, the recovery
chain, and the M7/M8 path to curriculum-complete capability; total new
provider spend within its per-study authorizations with the ledger showing
headroom, not exhaustion; and a handoff note separating proven-offline from
requires-live evidence. M7 and M8 are subsequent goals with their
specifications fixed above — do not start them in this session unless
everything before them is complete and gates are green, and if you do,
their acceptance criteria bind exactly as written. Audit every clause
against current repository state and command output before marking the goal
complete.
