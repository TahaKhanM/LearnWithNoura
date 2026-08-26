# Polish punch-list handoff (2026-08-26)

Starting HEAD: `48d10f9`. Branch: `devin/demo-day-interactive-tutor`. Final HEAD after this note is the commit that adds it.

No push, deploy, or live provider calls. Visual baselines were not regenerated. The three untracked 2026-08-23 / 2026-08-25 architecture review docs were left uncommitted.

## Commits

| SHA | Summary |
| --- | --- |
| `c3293db` | Harden P0 voice-path, check, and illustration gates. |
| `e300b1b` | Scope board assets to owners and persist only after accept. |
| `30dce06` | Harden Phase 5 eval ingest and close fixture holes. |
| `fe15283` | Close Phase 3 lows on epoch, handoff, and pairing. |
| `ac54da0` | Add the required illustration record to the Director success fixture. |
| *(this file)* | Polish punch-list handoff. |

## P0 — load-bearing Mediums

### 1. Fast-tier denylist — **fixed**

`FAST_TIER_AUTHORED_UPDATE_PROPS` is now only `handle`, `selected`, `tolerance`, `numberlineId`, `shape`, plus image keys `assetId` / `alt` / `crop` (`shared/authoredSpecs.ts` 219–222). Geometry keys (`at`, `from`, `to`, `r`, `w`, `h`, `size`, `label`) are no longer denylisted. `kind` and `style: handwritten` remain authored-only.

Live apply defaults to `{ tier: 'fast' }` so `isAuthoredOnlySpec` actually guards the voice path (`src/board/scene.ts` 44, 91; `server/realtime/boardContext.ts` 34; `server/realtime/toolHandling.ts` 115). Restore / director replay still pass `{ tier: 'authored' }`.

### 2. Server re-eval ignores client check spec — **fixed**

`evaluateBoardSubmissionCheck` voids `clientCheck` and evaluates only the delivered/compiled check looked up by `submission.taskId` (`server/realtime/manipulativeSubmission.ts` 14–57). No server-owned check → `null` (fail closed; do not mark passed). Wired from `server/realtime/clientEvents.ts`.

### 3. Illustration cache re-runs vision — **fixed**

Cache hits call `inspectCachedRecord` before `ok()` (`server/board/illustration.ts` 93–98). Failed vision or empty bytes are not returned as accepted.

### 4. Subject refuse regex — **fixed**

`illustrationSafety.ts` 8–17: `photoreal(istic)?|realistic` + child synonyms; `picture|portrait|photo(graph)?|selfie` + `of (a) ` + child synonyms; `selfie (of (a))?` + child synonyms. Fail-closed before generate.

## P1 — security / fetch Mediums

### 5. Asset IDOR — **fixed**

Additive migration version 4 stores `parent_id` and `session_id` on `board_assets` (SQLite `server/store/db.ts` 250–254; Postgres `server/store/postgresRepo.ts` + `server/store/migrations/005_board_asset_ownership.sql`). Both repos and the portable snapshot round-trip the columns. `GET /api/board-assets/:id` requires the parent cookie to match `asset.parentId` (`server/api.ts` 269–298). Parent B cannot GET parent A’s asset (404). Legacy rows without `parentId` fail closed.

### 6. Child-device illustration href 401 — **fixed**

GET accepts a lesson capability from `Authorization: Lesson`, `?cap=`, or the `noura_lesson` cookie (`server/api.ts` 321–339). Session create/continue sets that cookie so SVG `<image href="/api/board-assets/…">` can authenticate without a parent cookie. Same-device guest-parent cookie still works. Random ids 404.

### 7. Orphan illustration blobs — **fixed**

`prepareIllustration` no longer `store.put`s. `persistIllustrationRecord` (`server/board/illustration.ts` 168–178) runs only after the Director accepts the scene (`server/board/director.ts` 185–210). A failed Director attempt leaves no get-able asset.

## P1 — Phase 5 eval Mediums

### 8. Ingest BoardOps through production `validateOps` — **fixed**

`ProductionBoardOpsSchema` (`server/lesson/eval/types.ts` 7–18) fails parse when `validateOps` rejects any entry. A `{op:"remove"}` batch throws `/unknown op/`.

### 9. `clear` fail fixture — **fixed**

`server/lesson/eval/fixtures/object-permanence-fail-clear.json` is loaded by `test:lesson-eval`.

### 10. Barge-in `provider_failed` — **fixed**

`server/lesson/eval/fixtures/barge-in-provider-failed.json` pins `expectedProviderFailed: 1`.

### 11. Reveal `anchorScene` + negative binding fixture — **fixed**

`anchorScene` is required on `RevealNarrationFixtureSchema`. Coherent fixture already had one; incoherent / consecutive fixtures now carry matching scenes. `reveal-narration-unbound.json` would pass if `storyboardRunSteps` binding were deleted.

### 12. Permanence navigation path — **fixed**

`object-permanence-pass.json` now has a same-id overwrite whose `ts` matches a `sectionNavigation` (excused). Erase/clear still fail even if a navigation row is present (`RenderedTutorObjectTracker` treats a missing id as `scene_mutation`). That is documented in the clear-fail test; no dead nav fields remain.

### 13. `scriptedJudgments` — **fixed (removed)**

Unused hatch removed from the schema and `scoreBlueprintQuality`. A scripted 1.0 cannot rescue a weak blueprint.

## P2 — Lows

### 14. Epoch-invalidate preflight during speech — **fixed**

`speech_started` increments `visualRequestEpoch` (`server/realtime/upstreamEvents.ts` 117–123). Anchor path rechecks staleness at first-beat scheduling (`server/realtime/visualRequests.ts` after accepted preflight).

### 15. Handoff completes only on `completed` — **fixed**

`noteStoryboardResponseDone` (`server/realtime/storyboardRunner.ts` 229–240) completes only on `status === 'completed'`. Cancelled / failed / other statuses clear `handoffResponseId` so the next quiet floor retries.

### 16. `boardContext.apply` honors `op.semanticGroupId` — **fixed**

`server/realtime/boardContext.ts` 38: `semanticGroupId ?? op.semanticGroupId ?? existing?.semanticGroupId`.

### 17. Draft navigation queue — **fixed**

`queuedDraftNavigationRef` is an array (`src/lesson/LessonPage.tsx` 81, 145–148, 169–176). A second notice-open during an open draft is queued, not overwritten.

### 18. Pairing gate for manipulate delivery — **fixed**

Any `responseMode === 'manipulate'` without a compiled/delivered `manipulativeCheck` is rejected, including conversation-led and orient stages (`server/realtime/toolHandling.ts` 55–64). Board-led guided/independent still also require visible targets for non-manipulate questions.

## Gates at final HEAD

All green (no live provider calls; visual baselines unchanged):

| Gate | Result |
| --- | --- |
| `npm run build` | pass |
| `npm run typecheck:server` | pass |
| `npm run lint` | pass |
| `npm test` | 568 passed |
| `npm run test:lesson-eval` | 15 gates pass |
| `npm run test:e2e` | 24 passed |
| `npm run test:visual` | 53 passed |
| `npm run test:a11y` | 4 passed |
| `npm run test:security` | 22 passed |
| `npm run test:storage` | 9 passed |
| `npm run test:brand` | pass |
| `npm run test:runtime-models` | pass (no runtime model identifier changes) |
| `npm run test:smoke-report` | 70 passed |

## Deferred

Nothing on this punch list is deferred. Remaining product honesty (unchanged): the offline lesson-eval report still marks live provider behavior and target-hardware acoustics as `UNVERIFIED`.
