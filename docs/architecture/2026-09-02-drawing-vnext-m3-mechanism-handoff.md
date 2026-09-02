# Drawing vNext M3 mechanism-only handoff

**Date:** 2026-09-02  
**Status:** accepted under the architecture-owner’s 2026-09-02 re-scope  
**Next:** M7 parts 0–2, not template-catalogue population

## Accepted mechanism

M3 proves the template lane as an engine mechanism rather than a content
catalogue:

1. Routing remains `anchor → deterministic template → streaming Director`.
2. The deterministic extractor requires every parameter; ambiguous requests
   return `null` and continue through the generative lane.
3. The strict stream schema keeps `template` first. A non-null completed stream
   head aborts the provider stream, recompiles the same exact request through
   `adaptSemanticScene`, browser-validates cumulative steps, and hands them to
   the normal storyboard boundary.
4. `exactTemplateScene` has no runtime occurrence.
5. Template storyboard checkpoints and narration beats are synthesized without
   another model round.

The mechanism is accepted with exactly three exemplar templates:

- `number_line`: exact range, step and optional mark;
- `fraction_comparison`: exact numerator/denominator strips when strips are
  requested, with a shared-scale representation retained for scale requests;
- `slope_comparison`: exact linear expressions and a code-computed intersection
  point when requested.

All three pass the real loopback Chromium policy/preflight/raster path. Maximum
measured extractor-to-raster first paint was 36 ms against the 2,000 ms gate;
there were zero external requests and zero provider calls. The three exact
screenshots were manually inspected after rejecting and fixing merged fraction
labels and a missing graph-intersection marker.

## Open-set engine gate

The four sealed `unfamiliar_abstract` intents are never template-captured.
Across their 40 immutable M1 rows, 37 passed first attempt and all three failures
were recovered by the F9 Terra-medium arm: 40/40 delivered (100%, threshold
95%). This is templates-off evidence reconstructed from the hash-bound M1 and
F9 artifacts; no call was repeated and no live claim was inferred.

The blended first-pass gate is deliberately **not** an M3 result. The updated
binding specification moves it to M8, where curriculum breadth and the
templates-off domain gates are evaluated together.

## Re-scope reconciliation

Before the architecture-owner re-scope arrived, six additional extractors had
already been completed and tested: unit-circle projection, Pythagorean area
proof, triangle angle sum, causal cycle, timeline and grammar structure. They
remain as tested code; no additional extractor was authored after the update,
and none is used to satisfy M3’s three-exemplar bar. Further catalogue work is
deferred and may be pulled only matrix-row-by-row, no earlier than M8.

## Retained evidence

- acceptance:
  `server/board/eval/results/2026-09-02-drawing-m3-mechanism-acceptance.json`
- acceptance SHA-256:
  `299c3b7a07a98114795c3cf760b98ad3ab4230cb7e31ac58b22e82fedb53a758`
- browser result SHA-256:
  `079554a67026654a4d32d992b5ec17b9572de9b93daa165fed02974c3cdceab1`
- fixture SHA-256:
  `ba4739968be0eb3fd42d2978058e151817cf9b40c387c6e0aa841daa569cbae4`
- verifier: `npm run test:m3-acceptance`

Proven offline: both lane entry points, strict fall-through, three browser
exemplars and their timing, zero holdout captures, exact source/evidence hashes,
and 40/40 open-set delivered validity. No new provider spend occurred in M3.
Target-hardware behavior and real-child behavior remain unverified.
