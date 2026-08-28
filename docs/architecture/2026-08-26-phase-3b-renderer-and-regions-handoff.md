# Phase 3b handoff — renderer vocabulary and spatial camera regions (2026-08-26)

Phase 3b of the approved overhaul (items 4–5 of "Phase 3 — Board Director +
interleaved reveal-narrate"). Implemented offline on
`devin/demo-day-interactive-tutor` from HEAD `1666601`. No live provider call
was made; tests use scripted doubles and local fixtures.

## What changed

### A. Renderer vocabulary (Director / compiler only)

The exact-geometry core is unchanged. Three new specs and one text style
were added as **authored-tier** vocabulary:

| Spec | Shape | Who may emit it |
| --- | --- | --- |
| `arc` | Center/radius/angles **or** three-point (`from`/`through`/`to`; collinear rejected) | Director, Lesson Compiler |
| `curve` | Cubic Bézier: 4 + 3k points, clamped, width 1–12, max 31 points | Director, Lesson Compiler |
| `asset` | Curated local icon (`assetId`, `at`, optional `size`/`label`) | Director, Lesson Compiler |
| `text.style: "handwritten"` | Short Caveat margin note; existing draw-on reveal | Director, Lesson Compiler |
| `path` | Learner freehand (unchanged) | Learner only |
| Existing kinds (`line`, `polygon`, `circle`, …) | Unchanged | Fast tier + authored |

`validateOps(raw)` remains the voice-model **fast** gate and rejects `arc`,
`curve`, `asset`, handwritten style, and learner `path`.
`validateOps(raw, { tier: 'authored' })` is used by the Director policy, the
compiled-lesson schema, the compiler's raw-anchor path, session restore, and
`BoardContextTracker` replay so persisted Director/compiler ops survive
reconnect. `promptConsistency.test.ts` pins that `server/prompts/realtime.md`
never teaches `arc` / `curve` / `asset` / `handwritten`.

New spec renderers live in focused modules that `compile.ts` composes
(`compileCurves.ts`, `compileAssets.ts`) so the existing compiler does not
grow monolithically. Inspection, annotation occupancy, quality (assets count
toward the item budget and have an 8-icon cap), snapshots, and describe-scene
all cover the new kinds.

Handwritten notes use the already-bundled Caveat variable font
(`@fontsource-variable/caveat`) at weight 500 plus the existing text draw-on
path. No font-outline or stroke-synthesis dependency. KaTeX equations are
untouched. Default board text rendering is unchanged (still Caveat 600), so
canonical single-section scenes stay pixel-identical.

### B. Sections are spatial camera regions

`sceneForGroup` is no longer the live render filter. It remains the
**section-scoped slice** for Director screenshots, learner submissions,
preflight, and quality. The live canvas renders every region.

- **Layout** (`src/board/regionLayout.ts`): each section keeps its local
  1000×600 coordinates. Regions tile horizontally with `REGION_GUTTER = 80`.
  Legacy items without a `semanticGroupId` map to region 0 (first named
  section, or the origin). This is the replay mapping — first stored section
  → region 0 — kept in one module, not scattered special cases.
- **Camera** (`src/board/camera.ts` + `BoardCanvas`): settled single-section
  viewBox is exactly `0 0 1000 600`. With two or more regions the camera
  includes a `REGION_PEEK = 200` sliver of the previous tile (gutter plus a
  hint of the neighbouring drawing). Pans animate
  420 ms (cubic ease); `prefers-reduced-motion` (and the first committed
  target) apply the settled box on the same render so compact mobile-focus
  crops stay identical to the derived viewport — a stale animated viewBox
  was clipping edge labels. The camera moves only
  on announced navigation: learner tabs/arrows/`Part X of Y`, the section
  notice's "Open it", task-driven focus (`task.semanticGroupId`), or
  `tutor_announce`. It never moves during an open learner draft.
- **Mobile**: `semanticViewport` focus crops apply **inside** the active
  region; the crop is then offset by the region origin.
- **Learner marks** still inherit the active region. Erase/draft/Done are
  unchanged. Canonical snapshots stay section-scoped.
- **Board summary**: objects in a non-camera region are still "on the
  board". `BoardContextTracker` describes them as
  `[region K of N: label]` and states that every region remains present.
- **Reconnect**: camera position is derived (first/anchor region via
  existing `initial_anchor` registration). The learner can pan back. No
  schema migration.
- **Permanence**: the v3.1-era announced-section E2E was adapted
  deliberately — off-camera objects stay in the DOM (`toHaveCount(1)`), and
  `permanenceRegions.test.ts` proves a camera pan never drops a tutor object
  from the scene. The same E2E now also asserts the draft lock: the
  section picker stays disabled while a drawing draft is open; after Done
  the learner can pan back and the mark is still in the scene.

## Asset set and licensing

50 original single-color educational icons in `shared/boardAssets.ts`.
Each has an id, a11y label, 24×24 viewBox, and path data validated by
`authoredSpecs.test.ts` (unique ids, safe path alphabet, 40–60 count).

**Ids:** sun, moon, cloud, raindrop, snowflake, lightning, wind, flame,
leaf, plant, tree, root, flower, seed, mountain, volcano, river, wave,
rock, bird, fish, butterfly, rabbit, atom, cell, magnet, battery, bulb,
thermometer, beaker, flask, microscope, gear, scale, prism, heart, lungs,
brain, eye, globe, compass, person, book, pencil, cycle, star, clock, ice,
soil, speech.

**Licensing:** authored for this repository as simple original geometry
(circles, arcs, polylines). No third-party icon library was vendored. No
network fetch at lesson time. No raster images. No new runtime dependency.

## Module map (new / substantially extended)

| Module | Lines | Responsibility |
| --- | --- | --- |
| `shared/authoredSpecs.ts` | 156 | Arc/curve/asset validation; authored-tier kinds |
| `shared/boardAssets.ts` | 90 | 50-icon registry (original path data) |
| `src/board/compileCurves.ts` | 202 | Arc + cubic Bézier compilation and occupancy samples |
| `src/board/compileAssets.ts` | 69 | Local icon compile (transform + optional label) |
| `src/board/regionLayout.ts` | 90 | SectionId → region offset; settled camera box |
| `src/board/camera.ts` | 54 | Animated camera interpolation; reduced-motion / first-target jump |
| `shared/boardOps.ts` | 724 | Fast vs authored `validateOps`; ShapeSpec union. Already over 400: it is the single shared contract; new kinds delegate to `authoredSpecs.ts`. |
| `src/board/compile.ts` | 1160 | Composes new renderers; grew only ~22 lines. Already over 400: deterministic compiler; new specs extracted. |
| `src/board/BoardCanvas.tsx` | 521 | Region transforms + composed camera/focus viewBox. Already over 400: one mount-lifetime unit (animator refs, pointer capture, viewBox). |

## Visual baselines

Default single-section canonical scenes were not bulk-regenerated. New
baselines only:

| File | Why |
| --- | --- |
| `scene-handwritten.png` | New: handwritten Caveat margin note |
| `scene-assets.png` | New: four local icons (sun, cloud, raindrop, plant) |
| `scene-arc-curve.png` | New: tutor arc + cubic curve |
| `scene-two-regions-gutter.png` | New: camera on region 2 with previous-region gutter peek |

Existing canonical / home / lesson baselines were not regenerated. The
52-test visual suite passed against the pre-3b snapshots plus the four
new ones above.

## Proven offline

- Authored-tier validation: arcs (center and three-point; collinear reject),
  curves (point/width clamp; non-cubic reject), assets (unknown id reject),
  handwritten style; fast tier unchanged; learner `path` still rejected on
  both tiers.
- Registry walk: 50 unique ids, labels, safe path data.
- Compile / inspection / quality coverage for the new specs; asset density
  cap at 8.
- Region layout: first section → offset 0; later sections adjacent; single
  section camera identical to today; region-1 camera includes gutter peek.
- Permanence: camera pan leaves every tutor object in the scene; tracker
  reports no disappearance. The announced-section E2E keeps the picker
  disabled while a draft is open, then pans after Done.
- Prompt consistency: voice model is not taught authored geometry
  vocabulary.
- Restore / board context / compiled-lesson schema accept authored ops.

## Requires authorized live verification

- Whether `gpt-5.6-terra` actually emits arcs, curves, handwritten notes,
  and assets (and when it prefers an icon over constructed geometry).
- Camera-pan feel against a child's attention, including the 420 ms timing
  and gutter peek on real devices.
- Compare-section first-beat announcement plus learner-driven pan (the
  camera still does not auto-steal the view).
- Reconnect camera derivation (lands on the first/anchor region) in a live
  multi-region lesson.

## Rework (adversarial reviews, 2026-08-26)

Two independent reviews of `1666601..646b8dd` asked for a rework. Findings
and resolutions:

| ID | Finding | Resolution | Proving test |
| --- | --- | --- | --- |
| H1 | Fast-tier `update` could set `style: handwritten` (and would accept future authored-only props). | `validateOps` rejects authored-only update props on the fast tier. `applyUpdate` defaults to fast and will not introduce authored-only vocabulary; `applyOps` / board-context replay pass `{ tier: 'authored' }` so a validated Director update still lands. | `authoredSpecs.test.ts` add+update batch; `boardOps.test.ts` applyUpdate tiers; `scene.test.ts` typeset remains typeset |
| M1 | Director current-board JPEG flattened every region into one 1000×600 tile. | `visibleOps()` preserves `semanticGroupId`. `applyOps` reads it when the caller does not pass a group. `sceneToCanonicalSvg` tiles regions with the live gutter; a single region is still `0 0 1000 600`. | `snapshot.test.ts` two boxes at `[500,300]` get distinct translates; `boardContext.test.ts` visibleOps membership |
| M2 | `sceneForGroup` kept ungrouped items in every scoped slice. | Ungrouped items belong to region 0 only (first named section), matching `layoutRegions`. | `sceneGroups.test.ts` |
| M-draft | `task_focus` during an open draft was dropped. | Queue the navigation in a ref; flush on Done (submission ack) or Cancel. Camera still does not move while the draft is open. | `LessonPage.test.tsx` queues then pans to region 2 after Done |
| L-peek | Compact focus hiding compared neighbour local boxes to the active-region crop. | `contains` now uses the camera (world) against origin-offset node boxes. | `BoardCanvas.test.tsx` two-region compact focus |
| L1 | Board summary omitted handwritten style. | `describeSpec` appends `, handwritten`. | `boardContext.test.ts` |
| L2 | `camera.ts` comment claimed a first-target jump the code did not do. | Comment aligned with `instant \|\| prefersReducedMotion()`. | n/a (comment only) |
| L3 | `tutor_announce` auto-pan. | Still deferred. Not implemented. | n/a |

No existing visual baselines were regenerated.

## Deferred

- Vertical / grid region layouts (horizontal strip only).
- Persisting the last camera region as its own event (derivation from
  `initial_anchor` + learner navigation is enough; additive if we later
  want exact restore).
- Auto-pan on a storyboard `tutor_announce` step (the cause exists; compare
  scenes still wait for the learner to open the new region).
- Phase 3c manipulatives and Phase 4 generated illustrations.
- Replacing Caveat-for-all-board-text with typeset Outfit for non-handwritten
  labels (would change every canonical baseline).
