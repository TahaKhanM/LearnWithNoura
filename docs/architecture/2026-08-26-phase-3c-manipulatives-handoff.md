# Phase 3c handoff — interactive manipulatives (2026-08-26)

Phase 3c of the approved overhaul (`2026-08-25-noura-overhaul-implementation-prompt.md`).
Implemented offline on `devin/demo-day-interactive-tutor` from HEAD `c43b487`.
No live provider call was made.

## What changed

### Authored-tier interactive ShapeSpecs

| Spec | Purpose | Who may emit |
| --- | --- | --- |
| `draggable` | Learner-movable token/point/piece with ≥44px hit target | Director, Lesson Compiler |
| `snapZone` | Box, interval-on-numberline, or point drop target | Director, Lesson Compiler |
| `tappable` | Tap-to-choose target with `selected` state | Director, Lesson Compiler |

Fast-tier `board_ops` rejects all three (`promptConsistency.test.ts` pins
this). Validation lives in `shared/manipulativeSpecs.ts`; renderers in
`src/board/compileManipulatives.ts`; pointer/keyboard hit layer in
`src/board/ManipulativeLayer.tsx`.

### Local machine-check

`ManipulativeCheckSchema` (`shared/manipulativeCheck.ts`):

```typescript
{ targetId, predicate: 'within' | 'selected' | 'snapped', snapZoneId?, bounds?, tolerance? }
```

Evaluation runs in the browser on Done (instant visual feedback on tap-only
tasks when the learner toggles a target). Results attach to `BoardSubmission`
as `manipulativeResult` and persist on `learner_board` events
(`localCheckPassed`, full result JSON). The model receives a compact text
summary plus optional one revision-bound JPEG — never per-drag traffic.

### Task contract

- `responseMode: 'manipulate'` added to `ResponseModeSchema`; `submitPolicy`
  matches `draw` (explicit Done, not VAD).
- `DeliveredTask` and `StageCheck` carry optional `manipulativeCheck`.
- Server `taskFromMove` enriches from the compiled stage check by `taskId`.
- Orchestrator / floor rules unchanged: manipulate tasks behave like draw
  tasks for endpointing and explicit submit.

### Draft / undo / replay

- Manipulate tasks auto-open a draft; Done may submit with zero moves
  (`beginSubmit({ allowEmpty: true })`).
- Learner moves record as draft `update` ops; undo/redo/clear apply inverses
  through `applyManipulativeDraft` (tutor-owned objects keep their owner;
  only `at` / `selected` change).
- Reconnect replays learner `update` ops with `manipulativeDraft: true`.
- Camera draft-lock, section picker disabled while drafting, and queued
  task-focus navigation unchanged from Phase 3b.

### Fixture

New `server/lesson/fixtures/numberline-fractions.json`: fraction number line
with draggable marker + interval snap zone at 3/4 and a `manipulate` guided
check. `fixtureCompiler` routes fraction/number-line goals to this fixture.

## Module map (new / extended)

| Module | Lines | Responsibility |
| --- | --- | --- |
| `shared/manipulativeSpecs.ts` | 193 | Spec validation, learner-update props |
| `shared/manipulativeCheck.ts` | 253 | Check schema + browser evaluation |
| `shared/manipulativeCheck.test.ts` | 125 | Tolerance + fast-check property tests |
| `src/board/compileManipulatives.ts` | 202 | Render draggable/snap/tap visuals |
| `src/board/ManipulativeLayer.tsx` | 144 | Pointer/keyboard hit targets + drag/snap |
| `src/board/manipulativeDraft.test.ts` | 32 | Draft undo + empty manipulate submit |
| `tests/e2e/manipulate-check.spec.ts` | 77 | Drag, Done-only submit, evidence payload |
| `server/lesson/fixtures/numberline-fractions.json` | 155 | Offline manipulate-lesson fixture |

Extended without monolithic growth: `shared/boardOps.ts` delegates authored
kinds; `LessonPage.tsx` gained manipulate wiring only; server submission path
extended in `clientEvents.ts`.

## Proven offline

- Property tests on check tolerance (on / in-band / just-outside) with
  fast-check.
- Unit: manipulative draft undo/redo, empty manipulate Done, scene
  manipulative updates, board-context replay of learner updates on tutor
  manipulatives.
- E2E: `manipulate-check.spec.ts` — drag does not submit; Done emits
  `board_submission` with `manipulativeResult`; task banner + manipulative
  controls render.
- All fourteen completion gates green at final HEAD (exact results in final
  report below).
- Prompt consistency: voice model not taught `draggable` / `snapZone` /
  `tappable`.

## Requires authorized live verification

- Whether the live Compiler/Director reliably pairs manipulatives with
  matching `manipulativeCheck` specs on real lessons.
- Drag/snap feel on real touch hardware (44px targets, reduced-motion,
  gutter-peek camera while drafting).
- End-to-end tutor reaction quality when the local check passes vs fails
  (summary-only vs snapshot grounding).
- Parent evidence UI presentation of `localCheckPassed` lineage.

## Deferred

- Phase 4 illustration layer (unchanged).
- Compiler prompt auto-authoring of manipulate checks beyond fixtures (live
  model quality unverified).
- Persisting in-draft manipulative positions separately from submitted ops
  (session-storage draft entries suffice today).
- Auto-pan to manipulative targets on task delivery (task-focus queue after
  Done only, same as draw tasks during draft).

## Completion gates (final HEAD)

| Gate | Result |
| --- | --- |
| `npm run build` | ✓ |
| `npm run typecheck:server` | ✓ |
| `npm run lint` | ✓ (oxlint, 0 issues) |
| `npm test` | ✓ 65 files / 486 tests |
| `npm audit --omit=dev` | ✓ 0 vulnerabilities |
| `npm run test:integration` | ✓ 65 files / 486 tests |
| `npm run test:e2e` | ✓ 23 tests |
| `npm run test:visual` | ✓ 52 tests |
| `npm run test:a11y` | ✓ 3 tests |
| `npm run test:security` | ✓ 18 tests |
| `npm run test:storage` | ✓ 8 tests |
| `npm run test:brand` | ✓ passed |
| `npm run test:runtime-models` | ✓ 70 tests |
| `npm run test:smoke-report` | ✓ passed |
