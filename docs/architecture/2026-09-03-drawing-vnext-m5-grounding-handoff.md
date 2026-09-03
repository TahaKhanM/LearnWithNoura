# Drawing vNext M5 remainder handoff

**Date:** 2026-09-03  
**Implementation status:** remainder complete and offline-verified  
**Acceptance:** remainder accepted offline; full M5 (candidate raster + harness alignment) is not claimed  
**Provider calls:** 0

## Offline evidence

- `npm run gate:quick`: 874 tests passed. Zero provider calls.
- Snapshot tests: measured-outline `data-katex` group with occupancy rect and readable `A+B+C=180°`.
- Sketch tests: enum-closed replies, width 4, 30 unique SVGs, offline accuracy 30/30, contact sheet matches the checked-in fixture.
- Full README matrix: build, typecheck, lint, smoke-report, lesson-eval, npm test (via gate:quick), integration, e2e 30 passed, a11y 4 passed, security, storage, brand, runtime-models, director-eval through `audit:m7-acceptance` all passed. M7 remains `accepted: false` on the spend incident.
- `npm audit --omit=dev`: 1 moderate `qs` advisory; lockfile unchanged.
- `npm run test:visual`: 12 home/lesson snapshots passed. 48 `/dev/board` harness snapshots fail because M7 added fixture buttons the baselines do not include (~4% pixels, chrome). Baselines were not refreshed. Live KaTeX rendering is unchanged; the outline is snapshot-only.

## Remainder that landed

1. Canonical snapshots emit a measured-outline KaTeX placeholder (`data-katex`, occupancy rect, readable `latexToPlainText`). SVG-as-image cannot paint KaTeX HTML; the outline is the specified alternative.
2. Sketch corpus C1 rebuild: interpretations are a closed ten-label enum in the base schema and the live-study JSON schema. Free-text replies are invalid. Stroke width is 4 (live learner pen / path compile default).
3. Human-verifiable renders: unique SVG per jittered variant plus checked-in contact sheet `server/board/eval/fixtures/sketch-corpus-contact-sheet.svg` (ten bases, jitter seed 1). Inspected: line, underline, circle, triangle, arrow, cross, check, box, increasing curve, fraction partition.
4. Offline geometric scorer (`interpretSketchOffline`) is spatial hints only (`semanticClaim: false`). Accuracy 30/30 on the rebuilt corpus. Cheaper-model assist stays **off** (M0 gain 0.03, below 0.05). This corpus still cannot authorize check grading.
5. Tutor prompt: see-then-interpret; vector features are hints; explicit confidence; clarifying question on vector/vision conflict.

## Deferred (not this remainder)

- M5 item 1: `visual_render` candidate raster from a copy of the live coordinator (LessonPage still uses an empty coordinator when `semanticGroupId` is present).
- M5 item 3: align harness `nouraRenderScene` with the lesson annotation-layout path.
- Live sketch re-score with the enum schema. Not run. Do not start it without a fresh itemized cap.
- M7 spend incident is owner-ratified as process-complete, not authorized
  after the fact. Hash-bound `accepted` stays false.

## Next

Do not start M8 or M6. Live `gpt-image-2` still needs a fresh itemized cap.
