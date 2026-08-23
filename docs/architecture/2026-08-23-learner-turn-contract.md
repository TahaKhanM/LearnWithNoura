# Learner Turn Contract (Board Intelligence v3)

Date: 2026-08-23. Status: active. Supersedes the implicit turn behavior of
Board Intelligence v2; the v2 geometry/section/ledger invariants remain in
force.

## The defect this replaces

Previously, the first board pointer-down could interrupt Noura, every
completed stroke became an answer candidate, 650 ms of inactivity was treated
as "finished", a DOM-cloned board screenshot was captured, and a model
response was requested. A learner pausing between strokes was inspected
mid-thought; resuming interrupted the response their own partial work had
triggered. One E2E test asserted this behavior (`requestResponse: true` after
a single stroke); it has been replaced by the opposite invariant.

## Contract

Shared types live in `shared/lessonTurn.ts` (`DeliveredTask`,
`BoardSubmission`, `reduceLessonTurn`, `mayCreateResponse`).

1. **Drafts, not answers.** A learner drawing is a local draft until the
   learner explicitly submits. Pointer-up and inactivity never submit,
   capture, grade, or request a response. Drafts support stroke, erase,
   undo, redo, clear, and cancel (`src/lesson/learnerDraft.ts`), autosave to
   session storage, and survive a reload.
2. **One owner of `response.create`.** Provider semantic VAD is configured
   with `create_response: false` and `interrupt_response: false`; it only
   chunks and transcribes. The proxy coordinator creates every response,
   keyed and idempotent: voice stop (only when no draft is open), typed text,
   an explicit board submission, session start, or a tool continuation while
   the tutor holds the floor. Speech during an open draft accumulates as
   context for the one response created by Done (mixed answers).
3. **Explicit handoff.** `propose_teaching_move` carries `questionOrTask`,
   `taskId`, and `responseMode` (`voice|text|draw|choice|mixed`). The task is
   delivered at the heard-audio boundary as a `learner_task` cue (imperatives
   like "Circle the acute angle." yield exactly like questions), shown as a
   persistent banner, persisted for reconnect restore, and reduced into the
   orchestrator. Trailing-`?` detection remains only as a fallback for
   unstructured spoken questions. The proxy never injects a generic question;
   the only continuation is a once-only nudge when the model proposed a
   question move and failed to ask it.
4. **One idempotent submission.** Done freezes the draft into a
   `BoardSubmission` (submission id, draft id, task id, section, ops, vector
   analysis, canonical image, board revision). Duplicate ids never duplicate
   events or responses. The stored `learner_board` event id becomes the
   evidence source for that answer.
5. **Canonical capture.** Board images are rendered from immutable scene data
   (`src/board/snapshot.ts`), never by cloning the mounted SVG — identical on
   desktop and mobile, independent of focus viewport, compact text hiding,
   highlights, pen, or animation state. Equations render as deterministic
   readable math text.
6. **Prepared visuals.** Accepted semantic plans are compile-checked as a
   complete candidate scene in the browser (`visual_preflight`) before the
   model is told they are usable; a rejected preflight stages nothing.
7. **Stable learner view.** Tutor checkpoints never switch the active section
   or reset the part position while the learner is composing, highlights do
   not steer the viewport, compact mode shows "Part X of Y", tools never
   overlay board content on compact screens, and only operable learner marks
   are keyboard-focusable.
8. **Fallback parity.** In captions-only mode, Done posts the committed
   vector analysis and scene description to `/api/board-submission` (no image
   claim is made for the text model); failures surface with a retry and never
   fail silently.

## v3.1 correction: tutor continuity and lesson coherence

Live use of the first v3 cut showed tutor visuals still disappearing (atomic
replacement and auto-switching sections both *look* like erasure) and lessons
wandering (no persisted plan). The follow-up review
(`2026-08-23-whiteboard-follow-up-review-and-devin-prompt.md`) corrected the
governing product model:

1. **Visible tutor work is permanent.** `replace` is removed from the live
   tool surface, prompt, and policy; every live replace request is rejected
   with nothing staged. Raw `clear` remains rejected, and a tutor object
   cannot be erased in the same logical turn that created it. Legacy
   committed replacements replay as historical truth only.
2. **New sections never hide the current board.** Only the first anchor
   section auto-activates. Later sections are announced in the lesson UI
   ("Noura added a new board section … Open it") and are reachable via the
   picker; the learner's active view never switches automatically, including
   while a draft is open.
3. **One durable lesson blueprint.** `create_lesson_blueprint` runs before
   the first substantive explanation: mode chosen once
   (`board_led|conversation_led`), success criteria, one anchor
   representation, and 3–5 stages. Moves carry `stageId`/`goalLink` and are
   validated: stage jumps, anchor changes, decorative visuals, and premature
   completion are rejected; correct answers advance the stage, partial ones
   change tactic only, missing prerequisites push a bounded detour that
   returns to the recorded stage. Blueprint and stage progress persist as
   `lesson_blueprint`/`blueprint_progress` events and restore on reconnect.
4. **Server-owned board actions.** The model states intent with
   `establish | extend | emphasize | compare | none`; the server assigns
   sections (`lesson-anchor`, announced `lesson-anchor-altN` comparisons),
   builds emphasize highlights from visible ids, and routes extensions into
   the anchor. At most one structural plan per logical tutor turn (one retry
   after a failure); the budget resets only when a learner turn begins.
5. **Visibility barrier.** A plan's successful tool result is withheld until
   the browser confirms every checkpoint on screen (`ops_shown`); the result
   then carries the authoritative visible board, so continuation speech can
   only describe what the learner actually sees. Preflight fails closed: no
   connected browser or a timeout is "not shown", never acceptance.
6. **Board-led questions depend on the board.** Guided/independent checks
   must name visible `targetObjectIds` or they are rejected.

## Deliberately unchanged

Runtime models and transport, the BoardOp DSL and validation, exact semantic
templates and the compiler, geometry inspection/annotation layout/quality
budgets, released-only replay and the board ledger, generation identity and
stale-event gates, sample-clock synchronization, immutable session ending,
and SQLite/Postgres parity. Turn/task/draft durability uses the existing
event log (`learner_task`, `learner_draft`, `learner_board` submissions), so
both repositories persist it without schema migrations.

## Known limits (honest)

- Draft strokes are autosaved locally (session storage) and as draft
  open/close events; the provider only ever sees submitted revisions.
- Snapshot text renders with the board font when available; the serialized
  SVG cannot embed external fonts, so rasterized text may fall back to a
  system font. Content, geometry, and layout are unaffected.
- The `/api/board-submission` fallback endpoint mirrors `/api/fallback-turn`
  and is exercised by type checks and client tests, not yet by an endpoint
  integration test.
- Stage/objective relatedness is enforced structurally (blueprint id, stage
  id, anchor id, visible target ids), not semantically; a model could still
  write a weak `goalLink` sentence.
- The fallback (captions-only) tutor validates actions and rejects
  replacement but does not enforce the blueprint or the visibility barrier;
  it has no realtime board round-trip.
- **The live-behavior fix is unverified.** All evidence here is from offline
  deterministic and browser-automation tests. No live-provider synthetic
  lesson has been run against this code, and any previously deployed
  environment (e.g. learnwithnoura.com) does not contain these changes until
  they are deployed. Resolution of the user-observed live defects requires
  at least one short authorized synthetic live run recording tool order,
  group ids, `ops_shown` timing, active-section changes, and the transcript.
