# Architecture doc index

Docs are listed newest-first within each tier. Do not
bulk-read this directory: **Current** docs are authoritative; **Historical**
docs are records — consult only when investigating how a decision was made.

## Current (authoritative)

- `2026-09-01-drawing-vnext-m1-acceptance-and-continuation-prompt.md` — the
  binding Drawing vNext program spec: corrected gates, milestones M2–M8,
  spend rules, 2026-09-02 M3 mechanism-only re-scope, M7/M8 specifications.
- `2026-09-02-curriculum-visual-coverage-matrix.md` — the "draw anything at
  11+/SAT level" coverage definition (with `server/board/eval/curriculum-matrix.json`).
- `2026-08-23-noura-runtime-architecture.md` — the runtime ADR (transport,
  compilation, orchestration, persistence). Still accurate for the non-drawing
  runtime; drawing sections superseded where the program spec differs.
- `2026-08-23-board-intelligence-v2.md` — board pedagogy invariants
  (permanence corrected by v3.1 notes inside; density budgets; grammar).
- `2026-08-23-learner-turn-contract.md` — draft-until-Done, floor ownership.

## Milestone handoffs (evidence records; read the one you're continuing)

- `2026-09-03-drawing-vnext-m5-grounding-handoff.md` — M5 remainder (KaTeX
  measured-outline snapshots + C1 sketch-corpus rebuild). Candidate raster
  and harness-alignment items remain deferred.
- `2026-09-03-drawing-vnext-m4-illustration-handoff.md` — M4 offline-complete
  (gpt-image-2, parallel lane, overlay-first arrival). Live illustration
  trace still requires itemized authorization.
- `2026-09-02-drawing-vnext-m3-mechanism-handoff.md` — M3 accepted (mechanism
  + 3 exemplars; open-set 40/40; extra extractors quarantined).
- `2026-09-02-drawing-vnext-m2-role-adoption-handoff.md` — M2 accepted
  (role ports, luna-low audit, live smoke incl. second-board-change gate).
- `2026-09-01-drawing-vnext-m1-handoff.md` + `2026-09-01-drawing-vnext-m1-ab-decision.md`
  — M1 implementation + original (superseded) non-acceptance; corrected
  acceptance evidence lives in `server/board/eval/results/`.
- `2026-09-01-drawing-model-bakeoff-decision.md` — M0 bake-off decision
  (+ later addenda). Raw evidence hashes inside.
- `2026-08-30-drawing-vnext-m0-handoff.md` — M0 telemetry + harness.

## Historical (superseded or completed programs — do not read for current truth)

- `2026-08-30-drawing-vnext-implementation-prompt.md` — original program
  prompt; still referenced for M4–M6 base specs, otherwise superseded by the
  2026-09-01 continuation prompt.
- `2026-08-26-*` phase handoffs (phase-1 WebRTC, phase-2 compiler, phase-3a/b/c,
  phase-4 illustrations, phase-5 eval, polish punch list) — the August
  overhaul's records; behavior since modified by Drawing vNext.
- `2026-08-26-drawing-runtime-recovery.md`, `2026-08-26-media-caption-runtime-recovery.md`
  — incident audits that motivated the overhaul.
- `2026-08-25-*` (overhaul implementation prompt, phase-0 telemetry docs) and
