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
   Replacement is a single atomic checkpoint (see v2 invariant 5), is refused
   while a draft is open, and forks a new section version over learner marks.
7. **Stable learner view.** Tutor checkpoints never switch the active section
   or reset the part position while the learner is composing, highlights do
   not steer the viewport, compact mode shows "Part X of Y", tools never
   overlay board content on compact screens, and only operable learner marks
   are keyboard-focusable.
8. **Fallback parity.** In captions-only mode, Done posts the committed
   vector analysis and scene description to `/api/board-submission` (no image
   claim is made for the text model); failures surface with a retry and never
   fail silently.

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
- Live-provider behavior (real multi-stroke sessions with long pauses,
  reuse-versus-replace) remains an evaluation task; nothing here claims
  physical-device or real-child readiness.
