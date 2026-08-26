# Phase 4 handoff — Illustration layer (2026-08-26)

Phase 4 of the approved overhaul (`2026-08-25-noura-overhaul-implementation-prompt.md`,
"Phase 4 — Illustration layer"). Implemented offline on
`devin/demo-day-interactive-tutor` from HEAD `7b5197a`. No live provider
call was made; generate, vision-check, and cache paths use scripted
doubles.

## What changed

Illustration-class requests (animals, ecosystems, historical scenes,
scientific pictures) can receive a generated image as a **board background**,
with **exact BoardOp overlays** for every label, number, equation, arrow, or
measurement. Generated pixels are never trusted for equations, scales,
measured geometry, or assessment targets.

### `image` ShapeSpec (authored-tier only)

`ImageSpec` in `shared/authoredSpecs.ts`:

```typescript
{ kind: 'image', assetId, at, w, h, alt, crop? }
```

- `assetId` is a server-issued `img-` + 8–40 hex/alphanumeric id. URLs and
  data-URLs are rejected.
- `alt` is a required a11y string (max 200).
- Compile produces an SVG `<image>` with `preserveAspectRatio="xMidYMid meet"`
  (contain, never stretch). Overlays stay on the BoardOp layer.
- Quality: at most one illustration per section (`illustration_density`);
  the image still counts toward the item budget. Inspection treats it as a
  solid container; reserved top/bottom label bands (`IMAGE_LABEL_BAND_PX = 44`)
  stay clear of later labels.
- Persist/replay stores `assetId` only. Bytes live in `board_assets`.

Fast-tier `board_ops` rejects `image` add and `assetId`/`alt`/`crop` updates
(`updatePropsYieldAuthored`). `promptConsistency.test.ts` pins that the
voice prompt never teaches `kind":"image"` or `generate_illustration`.

### Generation / safety / cache

`server/board/illustration.ts` orchestrates:

1. Feature flag — `NOURA_ILLUSTRATIONS=off` returns immediately; Director
   prompt has no illustration vocabulary; `app.ts` does not construct the
   live service.
2. Safety — `illustrationSafety.ts` refuse-closes violence, weapons,
   sexual content, and photoreal/photo-of-child briefs before any model call.
3. Cache — SHA-256 of normalized purpose/subject/style/required/forbidden.
   Cache hits skip generation (`imageCount: 0`).
4. Generate — `gpt-image` family via the installed `openai@7.4` Images API
   (`NOURA_ILLUSTRATION_MODEL`, default `gpt-image-1.5`). Size `1536x1024`,
   `output_format: 'png'`, `moderation: 'auto'`.
5. Vision-validate — multimodal Chat Completions check for embedded text,
   unsafe content, and missing required elements. Invalid JSON fails closed.
   At most 2 retries. Persistent failure → honest Director fail-closed
   (vector/asset diagram feedback; last board stays up).

**Streaming partials:** the SDK **does** support `stream: true` +
`partial_images`. Live adapter (`illustrationService.ts`) consumes
`image_generation.partial_image` and `image_generation.completed`. Partials
are pushed as transient `illustration_status` client envelopes (never
written to the event log). Proven from installed types and a scripted
`onPartial` hook; live latency/feel is unverified.

### Director integration

When `representation: 'illustration'` and the flag is on, the Director:

- strips any invented `image` ops from the proposal
- generates → validates → prepends a server-issued `image` add
- returns overlay BoardOps (labels, arrows, equations) as the storyboard
- runs those overlays through the existing headless compile/inspect/quality
  pipeline

`request_visual` stays intent-only. The voice model is never taught
`generate_illustration`. Compiler raw anchors that invent `image` ops fail
validation and fall back to conversation-led.

### UX

The last visible board stays on screen. A "Preparing illustration" banner
sits above the surface; optional semi-transparent contained partials overlay
the board (`object-fit: contain`, no pointer capture). Ready clears the
banner; failed shows an honest message and auto-clears after 4s. The board
is never blanked.

### Storage

Additive migration version 3:

- SQLite: `board_assets` BLOB
- Postgres: `board_assets.bytes` as **TEXT base64** (pg-mem corrupts BYTEA
  `0x89` as UTF-8; TEXT is the v0 portable store — no new paid blob product)
- Portable snapshot field `boardAssets[].bytes_b64`
- `GET /api/board-assets/:assetId` — parent/guest cookie required (SVG
  `<image>` cannot attach a Lesson Authorization header)

### Cost telemetry

Duration metric `illustration_generation` through the Phase 0 pipeline:
`latencyMs` plus `{ cache: 'hit'|'miss', outcome: 'accepted'|'failed'|'refused', imageCount, totalTokens }`.
No currency claim.

### Feature flag

`NOURA_ILLUSTRATIONS=off` disables the path with no dead illustration
vocabulary in the Director prompt and no live image client. Director
proposals that still ask for illustration get fail-closed diagram feedback.

## Module map (new / extracted)

| Module | Lines | Responsibility |
| --- | --- | --- |
| `shared/authoredSpecs.ts` | (extended) | `ImageSpec`, authored-only kind, fast-tier reject |
| `src/board/compileImages.ts` | 50 | SVG image node, href, label bands |
| `server/board/illustrationTypes.ts` | 51 | Brief / store / generate / vision ports |
| `server/board/illustrationSafety.ts` | 22 | Fail-closed subject refuse |
| `server/board/illustrationPrompts.ts` | 35 | Child-safe generate + vision prompts |
| `server/board/illustrationCache.ts` | 19 | Normalized SHA-256 cache key |
| `server/board/illustration.ts` | 212 | Orchestrator: flag, cache, generate, vision, store |
| `server/board/illustrationService.ts` | 95 | Live Images stream + Chat vision adapter |
| `server/board/illustration.test.ts` | 189 | Scripted generate / cache / vision / flag |
| `server/board/memoryIllustrationStore.ts` | 21 | In-memory store for tests |
| `server/board/repoIllustrationStore.ts` | 16 | DomainRepository-backed store |
| `src/lesson/IllustrationStatusBanner.tsx` | 36 | Preparing banner + partial preview |
| `server/store/migrations/004_board_assets.sql` | 13 | Additive Postgres table |

Extended without monolithic growth: `compile.ts` composes `compileImage`;
`boardOps.ts` stays a union; `LessonPage.tsx` only mounts the banner.

## Proven offline

- Fast-tier rejection of `image` add/update; authored accept of server ids;
  data-URL / http reject (`shared/authoredSpecs.test.ts`).
- Compile / quality / inspection / snapshot treat the image as a solid
  container with reserved label bands; SVG href is `/api/board-assets/…`,
  never a data-URL.
- Generation: cache hit skips generate; vision retry then fail-closed;
  unsafe brief refuse; flag-off; partial hook (`illustration.test.ts`).
- Director overlay-only-for-labels; flag-off never prepares an image
  (`director.test.ts`).
- Compiler invented `image` ops fall back to conversation-led
  (`compiler.test.ts`).
- Prompt pin: voice model never taught `kind":"image"` or
  `generate_illustration`.
- Storage + portable + parent-auth byte GET; Postgres TEXT base64
  round-trip in pg-mem.
- Visual fixture `scene-illustration-overlays` (placeholder pond + exact
  "frog" / "reeds" overlays). Inspected once; existing baselines untouched.
- All fourteen completion gates green at final HEAD (table below).

Green baseline at starting HEAD `7b5197a`: `npm run build` ✓;
`npm run typecheck:server` ✓; `npm run lint` ✓; `npm test` ✓ 68 files /
502 tests.

## Requires authorized live verification

- Live `gpt-image-1.5` quality, safety-pass rate, and generation latency.
- Streaming partial feel on a real lesson (SDK path is wired; pixels unseen).
- Vision-check false-positive/false-negative rate on real illustrations.
- Director reliability choosing illustration vs diagram on real intents.
- Lesson-page `<image>` fetch with only the guest-parent cookie (same-device
  v0). Multi-device child without that cookie is unverified.
- Cache hit rate and token/image-count telemetry on real traffic.

## Deferred

- Compiler-authored illustrations (no server-issued assetId at compile time;
  raw `image` ops are rejected).
- Parent-scoped asset ACLs (ids are unguessable; any authenticated parent
  can GET a known `img-` id).
- Headless JPEG of unresolved `/api/board-assets/…` hrefs (bbox/quality still
  run; the raster may show a broken image until bytes are served).
- Paid object storage / CDN (local SQLite BLOB + Postgres TEXT is v0).
- Changing Vercel function durations (illustration work rides the existing
  300s WS function with the Director, not the 60s REST function).

## Completion gates (Phase 4 HEAD)

| Gate | Result |
| --- | --- |
| `npm run build` | ✓ |
| `npm run typecheck:server` | ✓ |
| `npm run lint` | ✓ (oxlint, 0 issues) |
| `npm test` | ✓ 70 files / 528 tests |
| `npm audit --omit=dev` | ✓ 0 vulnerabilities |
| `npm run test:integration` | ✓ 70 files / 528 tests |
| `npm run test:e2e` | ✓ 24 tests |
| `npm run test:visual` | ✓ 53 tests |
| `npm run test:a11y` | ✓ 4 tests |
| `npm run test:security` | ✓ 20 tests |
| `npm run test:storage` | ✓ 9 tests |
| `npm run test:brand` | ✓ passed |
| `npm run test:runtime-models` | ✓ 70 tests |
| `npm run test:smoke-report` | ✓ 70 passed |

Starting HEAD `7b5197a` unit baseline was 68 files / 502 tests. The new
visual baseline `scene-illustration-overlays-chromium-darwin.png` was
inspected (placeholder pond, exact overlay labels below the image, harness
chrome unchanged). Existing visual baselines were not regenerated.
