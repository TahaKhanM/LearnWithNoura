# Phase 3a handoff — Board Director and interleaved reveal-narrate (2026-08-26)

Phase 3a of the approved overhaul (items 1–3 of "Phase 3 — Board Director +
interleaved reveal-narrate" in the implementation prompt; the
renderer-vocabulary and camera-regions items are Phase 3b and were not
started). Implemented offline on `devin/demo-day-interactive-tutor` from
HEAD `f7003e8`. No live provider call was made; all model interactions in
tests are scripted doubles.

## What changed

### The two-tier drawing brain

The fast tier is unchanged: the voice model keeps direct `board_ops`
increments — `highlight`, updates, small additions attached to visible
objects — validated and confirmed sub-second exactly as before.

The slow tier is new. `semantic_visual_plan` was replaced by
`request_visual` (schema 3.0.0): the voice model supplies INTENT only —
`action` (`establish | extend | emphasize | compare | none`), `purpose`,
`idea`, optional `constraints`/targets, `density` — and never geometry or
template parameters. The prompt, tool schema, and validators were rewritten
in the same commits and `promptConsistency.test.ts` now pins that the
template vocabulary is no longer taught to the voice model and that
`semantic_visual_plan` is gone. `replace` is no longer representable in the
request schema at all.

Routing: `emphasize` and `extend` keep their fast-tier semantics.
`establish` with a compiled anchor resolves to the pre-validated anchor
scene. `compare`, and `establish` without a compiled anchor, go to the
Board Director. Structural requests keep the one-plan-per-turn budget, are
rejected while a build is in progress, and comparison sections keep their
announced `…-alt<n>` naming beside the anchor.

### The Board Director (`server/board/`)

`director.ts` drives the pipeline over the existing Chat Completions path
(no new provider dependency; `NOURA_DIRECTOR_MODEL`, default
`gpt-5.6-terra`; `NOURA_DIRECTOR_REASONING_EFFORT`, default `medium`):

1. **Input** — the voice model's intent, the board ledger
   (`BoardContextTracker` summary plus reusable/forbidden ids), the current
   stage brief, the lesson goal, and a rendered screenshot of the visible
   board. The screenshot comes from the board harness's new
   `window.nouraRenderScene` hook: ops compile through the REAL client
   pipeline (DOM-measured KaTeX included) and raster to the canonical board
   JPEG; `headlessSceneValidator.ts` exposes it as `render()` beside
   `validate()` on the same headless-Chromium page.
2. **Output** — zod-validated structured output: add-only BoardOps plus a
   storyboard of reveal steps (1–2 sentence narration beats with the object
   ids each reveals). A directed scene is literally the compiled-anchor
   shape (`AnchorSceneSchema` with `template: null`), so one sequencing
   engine serves both.
3. **Deterministic policy before any retry** — permanence violations
   (clear/erase/update/highlight) are stripped; a storyboard that relied on
   destruction fails coverage and comes back as feedback; density budgets
   (minimal 14 / standard 30) and id-collisions with visible objects reject
   with corrective feedback.
4. **Self-check loop** — the candidate is validated headlessly through the
   real client pipeline, rendered to the canonical JPEG, and inspected by a
   vision pass against the intent. At most two correction rounds, then the
   request fails closed.

At runtime the request returns immediately as `status: "preparing"` with a
tool continuation, so the voice model keeps teaching about visible objects
while the Director works; it is told not to announce waiting and not to
describe the unbuilt picture. On success the scene preflights through the
connected client (fail closed), persists as a `directed_scene` event, and
hands to the storyboard runner. On failure an honest system note bridges
("the picture will not appear — continue with what is visible") and one
simpler retry is allowed within the turn's existing budget.

### The interleaved reveal-narrate engine (`server/realtime/storyboardRunner.ts`)

One runner plays ANY storyboard — compiled anchor or Director scene — and
retires the old "reveal everything at the establishing response's segment
end" behavior (fast-tier non-storyboard ops keep current behavior):

- **Reveal at real playback boundaries, without server playback tracking.**
  Each step cue is tagged with the response whose playback boundary should
  release it and marked `await_narration`; the Phase 1 client cue timeline
  holds it until that response has FINISHED playing (a new hold semantic —
  ordinary cues are unchanged), with fail-safe release for responses that
  will never play (retired, done-with-no-audio, captions-only sessions).
  Forward progress is driven purely by `ops_shown` confirmations, so the
  fail-closed visibility barrier and the released-events ledger work
  unchanged.
- **Beat responses.** On each confirmation the runner issues
  `response.create` with per-response `instructions` scoped to exactly that
  beat ("say 1–2 sentences conveying: …, referring to what appeared; do not
  ask; stop") and `max_output_tokens: 1200` (verified offline against the
  `openai` package types: `RealtimeResponseCreateParams.instructions` and
  `.max_output_tokens`). The next step's cue rides tagged to the beat the
  moment it exists. Beats are tutor-floor continuations: they never deliver
  tasks, never turn a trailing "?" into a handoff, and never spawn bounded
  continuations. All `response.create` sends now flow through one tracked
  helper so the runner never races a learner-turn response.
- **Handoff.** After the last beat, one ordinary (unmarked, uncapped)
  handoff response carries the stage's exact check wording (per-response
  instructions replace the session brief, so the wording rides inline) and
  delivers the task through the existing propose-then-ask contract.
- **Interruption.** A confirmed barge-in cancels the current beat via the
  ordinary generation machinery; revealed objects stay (permanence: the
  runner only ever adds). The run pauses and resumes at the first
  unrevealed step once the learner's turn fully resolves (floor free, no
  in-flight creates, no awaited task), re-sending the pending cue bound to
  the answer's playback boundary with resume framing in the next beat.
  Because a barge-in advances the client's generation identity before any
  new-identity envelope reaches the server, the runner also re-sends the
  pending step when the identity change lands — board-event application is
  idempotent on every layer.
- **Fail-closed stops.** A step the client rejects, or one never confirmed
  within `stepRevealTimeoutMs` (default 45 s), abandons the run cleanly:
  progress recorded, an honest note injected (once — the client-rejection
  path reuses the existing `ops_rejected` note), and the tutor brought back
  to the floor to continue with what is visible.
- **Persistence and reconnect.** Progress persists as additive
  `storyboard_progress` events (runId, source, revealedSteps, totalSteps,
  status) in the existing event log — no schema migration. On reconnect the
  run is rebuilt (compiled anchor or the persisted `directed_scene`) paused
  at the first unrevealed step; revealed steps replay as released board
  truth and the build continues at the resume greeting's playback boundary.
- **Telemetry (Phase 0 pipeline).** Per-step reveal→narration-start gap:
  step cues opt into an awaited-reveal correlation consumed by the NEXT
  playback start, reported under the existing `board_reveal_to_narration`
  metric with positive semantics. Completion/abandonment: a new additive
  `storyboard_outcome` count metric (outcome, source, revealedSteps,
  totalSteps).

`storyboardRunner.ts` is 452 lines, over the ~400 guideline deliberately:
it is one cohesive scheduling state machine (cue staging, beat creation,
pause/resume, identity changes, timeouts, completion accounting) whose
invariants live in the interplay of those pieces; splitting it would
scatter one state machine across files without reducing any single unit of
complexity.

## Module map (new/substantially reworked, with line counts)

| Module | Lines | Responsibility |
| --- | --- | --- |
| `server/board/director.ts` | 202 | Director pipeline: propose → policy → validate → vision, fail closed |
| `server/board/directorSchema.ts` | 90 | Proposal/vision schemas, board policy, directed-scene assembly |
| `server/board/directorPrompts.ts` | 41 | Propose and vision system prompts |
| `server/board/directorService.ts` | 61 | Chat Completions adapter + harness binding |
| `server/realtime/storyboardRunner.ts` | 498 | The interleaved reveal-narrate engine (size reason above) |
| `server/realtime/visualRequests.ts` | 461 | `request_visual` handling: fast tier, anchor build, Director flow, stale-request abandonment |
| `server/realtime/toolHandling.ts` | 261 | Remaining tools (shrank: plan geometry handling removed) |
| `server/realtime/boardStaging.ts` | 171 | Fast-tier staging + preflight (storyboard staging moved out) |
| `server/realtime/turnFloor.ts` | 125 | `response.create` ownership + in-flight tracking + floor gate + visual-request epoch |
| `server/lesson/headlessSceneValidator.ts` | 104 | Headless validate + render on one harness page |
| `server/realtime/storyboardRunner.test.ts` | 907 | Runner behavior vs fake sideband/client + cross-turn visual scoping |
| `server/board/director.test.ts` | 276 | Director scripted-double coverage |
| `server/realtime/storyboardSession.integration.test.ts` | 357 | Full loop: real coordinator ↔ real RealtimeSession |
| `tests/e2e/storyboard-build.spec.ts` | 125 | Offline Playwright build/interrupt/permanence |

(Line counts reflect the post-review rework below.)

## Proven offline

- **Director** (`server/board/director.test.ts`): accepted first try;
  corrected after real-pipeline rejection; corrected after vision
  rejection; persistently invalid → clean fail-closed rejection with
  reasons; permanence violations stripped (and storyboards that relied on
  them rejected); density budgets and id collisions enforced with
  corrective feedback; unrenderable candidates fail closed; junk vision
  replies count as rejections; the board screenshot is attached when the
  board is non-empty.
- **Harness raster**: `nouraRenderScene` produces the canonical board JPEG
  through real headless Chromium (compiled-scenes Playwright suite).
- **Runner** (`storyboardRunner.test.ts`): full beat ordering
  (reveal→narrate→reveal) with per-beat instructions and caps; a second
  structural request rejected during a build; a "?"-ending beat never
  becomes a learner handoff; the closing handoff carries the stage's exact
  check wording and delivers through the existing contract; barge-in
  cancels the beat and resumes at the first unrevealed step with framing;
  silent-client timeout and client rejection abandon cleanly (single honest
  note) with `storyboard_outcome` recorded; reconnect restores and resumes
  a mid-build run; the Director flow builds announced side sections and
  covers its latency conversationally, and its failure bridges honestly
  with one simpler retry allowed.
- **Full loop** (`storyboardSession.integration.test.ts`): raw provider
  events → real coordinator/runner → real envelopes → real
  `RealtimeSession` cue timeline under the fake voice transport. Reveals
  land exactly at playback boundaries (including a cue that arrives before
  its beat starts playing — the new hold-until-finished semantics),
  interruption resumes across the client's generation-identity change, and
  every operation reaching the board is an add.
- **E2E** (`tests/e2e/storyboard-build.spec.ts`, offline fake transport):
  the anchor builds step by step between narration beats on the real lesson
  page, a typed interruption drops only the pending reveal, the resumed
  build completes at the answer's boundary, and nothing ever disappears.
- Prompt/tool consistency green on the new surface; the Phase 2 establish
  tests were adapted deliberately (commit messages record the rationale);
  all fourteen completion gates green at final HEAD (exact results in the
  final report).

## Requires authorized live verification

- **Real Director output quality.** Whether `gpt-5.6-terra` at medium
  effort designs good scenes, survives its own vision pass at a useful
  rate, and stays within acceptable latency. The correction-round budget
  (2) and the prompts are untested against the live model.
- **Real beat-response pacing.** Beat latency (ops_shown → audible
  narration), whether `max_output_tokens: 1200` is the right cap for 1–2
  spoken sentences, whether beats reliably obey "stop after this beat",
  and whether per-response instructions (which replace the session brief
  for that response) preserve voice/persona continuity across beats.
- **Reveal→narrate feel end-to-end**: draw-on animation time plus beat
  generation latency against a child's attention; `stepRevealTimeoutMs`
  (45 s) tuning.
- **Live `response.create` semantics** for per-response `instructions` +
  `max_output_tokens` on `gpt-realtime-2.1` (verified against the `openai`
  package types only).
- **Director topology in deployment**: like Phase 2 compilation, the
  Director needs a reachable board harness and launchable Chromium
  (`NOURA_BOARD_HARNESS_URL`); without them the slow tier fails closed to
  fast-tier-only teaching.

## Deferred

- Phase 3b (assigned to a later agent): renderer vocabulary (tutor
  path/arc/Bézier, handwriting-style strokes, curated local assets) and
  sections as camera regions on one logical canvas (removal of
  visibility-filter sections).
- Multiple concurrent storyboard runs (one build at a time is enforced) and
  Director-authored extensions of an existing section (extend remains
  fast-tier `board_ops`).
- Re-narration of the interrupted beat on resume: the runner resumes at the
  first unrevealed step; the partially heard beat is bridged by framing,
  not replayed.
- Vision-pass inspection of the CURRENT board + candidate composited
  together (the Director sees them as separate inputs today).
- Storyboard beats for post-anchor stages of the compiled lesson (unchanged
  from Phase 2: one anchor storyboard per lesson; Director scenes cover
  mid-lesson needs).

## Rework after the adversarial review (2026-08-26)

An independent adversarial review of `f7003e8..19647b0` returned REWORK
with two High, three Medium, and three Low findings. All eight were fixed
failing-test-first in four commits on the same branch.

### High 1 — Stale async visual tasks lacked turn/request scoping

`startAnchorStoryboard` and `startDirectedScene` fired background work with
no generation guard, so a slow anchor preflight could start a storyboard
mid-learner-turn and a superseded Director scene (alt1) could build after
the tutor had already requested alt2.

**Fix.** A monotonic `visualRequestEpoch` on the coordinator state advances
in `requestModelResponse` — the same single place the one-plan visual
budget resets, i.e. every genuine learner turn. Both async paths capture
the epoch at request acceptance and re-validate
(`visualRequestIsStale` = epoch moved OR another run active) after EVERY
await — the preflight, the Director call, the `directed_scene` persist —
before any state mutation, success `finishTool`, or `startStoryboardRun`,
including in the catch handlers. A stale completion is abandoned
explicitly (below), never applied. The anchor path's first reveal now also
binds floor-aware like the Director path (`revealAfterResponseId: null`
while speech is in progress), so an unconfirmed speech blip — which is not
a learner turn and does not move the epoch — still cannot reveal
mid-speech.

**Proof.** `storyboardRunner.test.ts` "visual request scoping across
turns": a slow anchor preflight accepted after a learner turn builds
nothing and answers the still-pending tool call honestly; a superseded
alt1 Director completion is abandoned while alt2 builds normally.

### High 2 — Stale/superseded Director completion was silently dropped

`if (state.storyboardRun) return;` skipped `failDirectedScene`, so a tutor
told `status:"preparing"` never heard the honest "will not appear" bridge.

**Fix.** `abandonStaleVisualRequest` replaces the silent return: scoped to
THAT request (the active run's `visualPlanState` and board context are
untouched), it injects the honest system note exactly once per request
(bounded `abandonedVisualRequests` set), records a `storyboard_outcome`
abandonment metric, and deliberately creates NO response — a conversation
item cannot interrupt an active beat; the note contextualizes whatever the
coordinator speaks next. The anchor variant skips the note because its
tool result is still pending and is itself the honest channel.

**Proof.** Same describe block: a Director completion landing while an
anchor build is active yields exactly one note and one abandonment metric,
zero new `response.create`s, and the active run continues beat-by-beat
unaffected.

### Medium 3 — `await_narration` could release before beat audio ends

`responsePlaybackStatus` treated a response in the done set as 'finished'
even when its audio had never started, so provider ordering
(`response.done` on the sideband before `output_audio_buffer.started` on
the data channel) revealed the next step at generation-complete — the bug
commit `eae9524` fixed, reintroduced through the fail-safe.

**Fix.** `finishedResponses` became `responseDoneAt` (a done-timestamp
map). A done response whose audio has not started reports 'pending' for a
bounded grace window (`SILENT_RESPONSE_GRACE_MS`, 2.5 s). If audio starts
inside the window, release binds to real playback end as normal (the
"audio heard" bit is the existing `startedResponses` set). If the window
expires with no audio, the response is genuinely silent and held cues
release — the anti-deadlock property is preserved (the 50 ms release poll
observes the expiry).

**Proof (also Low 6).** `storyboardSession.integration.test.ts`: with
`response.done` arriving before `output_audio_buffer.started`, the next
step stays hidden through generation-done AND audio start, and reveals
only at playback end; a separate case proves the grace-window release for
a genuinely silent beat.

### Medium 4 — `storyboard_progress` persistence was fire-and-forget

Progress writes rode `trackSideEffect` without being awaited, so a
sideband reconnect between `ops_shown` and the write landing could restore
stale `revealedSteps`.

**Fix.** `onStepVisibility` awaits the step-boundary progress write before
`advanceStoryboardRun` — the run never narrates past a boundary that is
not durable. Chosen over gating reconnect restore on side-effect
quiescence because the cost is one local event-log insert on a path that
already awaited an insert for the step cue itself, it cannot regress the
reveal itself (the step is already on screen; only the NEXT beat waits for
durability), and it needs no cross-connection coordination. Terminal
writes (completed/abandoned) stay tracked side effects: they gate no
forward progress and teardown already awaits them.

**Proof.** Runner tests: with the `storyboard_progress` insert gated, the
next beat is not created until the write lands; a reconnect during the
gated write restores at the durable step and re-sends it (idempotent),
never skipping ahead.

### Medium 5 — the run completed on handoff `response.created`

A create-rejection after the handoff's `response.created` had no runner
left to retry, losing the stage check.

**Fix.** The run now holds `handoffResponseId` and stays open until that
response reaches `response.done`: completed/failed terminal statuses
complete the run; a cancellation (barge-in mid-handoff) clears the id so
the next quiet floor recreates the handoff; a create-rejection is retried
as before — with the runner still alive. `advanceStoryboardRun` never
creates anything while the handoff is pending. Restore-side,
`sessionRestore` no longer skips an active run with all steps revealed: a
reconnect inside the handoff window restores the run and recreates the
handoff instead of stranding an 'active' record with an undelivered
check.

**Proof.** Runner tests: transient `conversation_already_has_active_response`
on the handoff → retry → completion only at the retried handoff's
`response.done`; a barge-in-cancelled handoff is recreated after the
learner's turn. The two pre-existing completion assertions moved from
handoff-created to handoff-done deliberately.

### Low 6 — integration proof for Medium 3

Added as described under Medium 3; the runner/integration suites now
assert client-release semantics against the real `RealtimeSession` cue
timeline wherever they claim playback binding.

### Low 7 — tool-schema drift check

`promptConsistency.test.ts` now round-trips the `request_visual` JSON
schema against `VisualRequestSchema`: exact property-set equality,
required-list agreement (behavioral omission probes), every advertised
enum value accepted and out-of-enum rejected (both directions for
`action`/`density`), and min/max length and `maxItems` bounds probed at
the boundary and one past it. Verified to fail on a deliberately perturbed
bound.

### Low 8 — duplicate step-cue re-sends could double-enqueue

Re-sends rode fresh envelope `eventId`s, which is what the client timeline
deduped on. Board-event cues now carry a stable cue identity
(`board-event-<event_id>`) across re-sends, so a duplicate re-send (e.g.
an unconfirmed speech blip marking `needsResend` while the original cue is
still pending client-side) can never enqueue twice or double-draw. To keep
the legitimate post-interruption re-send working, `ResponseCueTimeline.cancel`
now frees the cue ids of the cues it removes (a cancelled cue never
applied); the cancelled generation identity itself stays rejected.

**Proof.** Timeline unit tests (stable-id dedupe across envelopes;
cancelled board event re-enqueues under the next identity only) and an
integration test where a blip-triggered duplicate re-send applies the step
exactly once and leaves nothing pending.

### Rework commits

- `8a58573` — Medium 5 + Medium 4 (runner completion + durable progress).
- `e40f4cb` — High 1 + High 2 (visual-request epoch + explicit abandonment).
- `eddc82a` — Medium 3 + Low 6 + Low 8 (playback grace window + stable cue identity).
- `f656545` — Low 7 (schema drift check).

All fourteen completion gates re-ran green at the final HEAD (exact
results in the rework report).
