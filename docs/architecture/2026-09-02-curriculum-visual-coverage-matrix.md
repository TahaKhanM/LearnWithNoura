# Drawing vNext Curriculum Visual Coverage Matrix

**Status:** T1 baseline complete; M7 missing set fixed  
**Machine-readable source:** `server/board/eval/curriculum-matrix.json`  
**Scope:** UK 11+ non-verbal reasoning plus US SAT/KS2 visual explanation

## Operational meaning of “draw anything at 11+/SAT level”

This is a bounded curriculum claim, not unrestricted image generation. The
machine-readable matrix enumerates 39 required visual types across:

- 11+ interpreting-shapes, moving-shapes 2D and moving-shapes 3D questions;
- SAT transformations, coordinate geometry, systems and data analysis;
- bar models, fraction strips/areas/sets, ratio tables and number lines;
- labelled science processes, grammar trees and timelines;
- annotations targeting tutor objects, subparts, learner strokes and image
  regions; and
- parametric grid paper, clocks and protractors.

A row is **supported** only when a first-class current BoardSpec or deterministic
template represents it directly. A row is **composable** only when current
BoardOps can express it and a representative fixture passes the production
policy plus real Chromium `/dev/board` preflight. A row is **missing** when a
named capability is required for reliable coverage. M7 is complete only when
every row is supported or composable through the generative lane.

## T1 baseline

| Status | Rows | Meaning |
|---|---:|---|
| Supported | 5 | Coordinate geometry, systems graphs, two-way tables, ratio tables and number lines have direct current representations. |
| Composable | 10 | Shape codes, hidden/combining shapes, bar and fraction models, labelled processes, grammar trees and timelines compile from current BoardOps. |
| Missing | 24 | One or more fixed M7 capabilities are absent. |

All 15 supported/composable fixture scenes passed policy, browser layout,
finite-bounds and raster generation checks. The loopback browser made zero
external requests and no provider calls. Manual inspection rejected an early
“green” pass whose fraction strip was not partitioned and whose coordinate
markers were spatially wrong; the sealed fixtures correct those defects.

Evidence:

- matrix SHA-256:
  `bad84b66a673df27841c19fd6c20d921c9c084c190618b3492adea941d13664a`
- fixture SHA-256:
  `ba30677f41c7f0532be09c4782c0a2724a4b7db4551f9400001ef454469c87f6`
- browser result SHA-256:
  `62d6654d5ea16ae154ba1cfd54d9fc1a41e9fa133b16a2b5e218ffb29553c583`
- provider-free verifier: `npm run test:curriculum-matrix`

The verifier checks exact source/result hashes, one-to-one fixture bindings,
closed preflight outcomes, all status counts and the missing-set identity. The
explicit regeneration path is loopback-only and refuses any external request.

## Fixed M7 missing set

| Capability | Required by |
|---|---|
| `panelGrid` | Shape sequences, matrices, analogies, odd-one-out and paired 2D transformations |
| `transform` | 2D rotation/reflection, paper folds, cube nets, rotating solids and SAT graph/shape transformations |
| `paperFoldHolePunch` | Fold, punch and unfold questions |
| `cubeNet` | Cube-net folding and face correspondence |
| `isometricSolid` | Rotating solids, block building and 3D-to-2D views |
| `planView` | Plan/front/side elevations |
| `regionFill` | Inequality feasible regions and reliable bounded shading |
| `scatter` | Data points, trend lines and correlation semantics |
| `histogram` | Frequency-density bins and interval semantics |
| `boxplot` | Five-number summaries and comparative box plots |
| `anchorRef`, `annotate` | Existing tutor objects, object subparts and learner strokes |
| `imageRegionGrounding` | Grounded callouts into existing image regions |
| `gridPaper` | Parametric square and dot grids |
| `clock` | Exact analogue clock faces and hands |
| `protractor` | Exact scales, rays and angle measurement |

These identifiers are contractual capability names. M7 must implement them as
versioned schema/rendering primitives, compiler support and validation—not as
prompt-only conventions or a fixed template catalogue. The matrix row IDs and
two or more eval intents per row are the acceptance corpus seed.

## Routing contract

The matrix informs routing but does not block novel visual requests:

1. Use an exact deterministic template when a row names one and all parameters
   are unambiguous.
2. Otherwise use the streaming generative lane; templates are accelerators, not
   capability boundaries.
3. Apply targeted layout correction only to closed browser issue metadata, then
   use the evidence-selected Terra-medium escalation when correction cannot
   preserve semantics.
4. A currently missing row must fail closed rather than be reported as covered.
   Its request and closed failure category feed M7 prioritization.

## M7 and M8 acceptance boundary

M7 closes the 24 missing rows and proves every one of the 39 rows supported or
composable using browser fixtures, multi-representation retry where useful and
adversarial checks for dense labels, small screens, exact values and learner
marks. It may add deterministic templates for speed, but each new primitive
must remain usable by the generative lane.

M8 is an open-set generative gate, not a template benchmark. Run a sealed,
representative and holdout corpus spanning every matrix family with template
routing disabled. The streaming generative lane, structured correction,
Terra-medium escalation and re-representation must still satisfy schema,
policy, production-browser, permanence, semantic-identity and quality gates.
Only that gate supports the final claim that Noura can compose whatever bounded
11+/SAT visual a learner needs rather than merely recognizing a template list.
