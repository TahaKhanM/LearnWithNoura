# Authorized Drawing vNext evaluation results

**Agents: never open the files in this directory** — they are multi-megabyte
evidence ledgers and will consume enormous context. Decision summaries live in
`docs/architecture/` decision records with SHA-256 hashes pointing here. If a
specific figure is needed, extract it with a targeted query
(`node -e "..."` / `jq '.summary'`) rather than reading a file.

This directory is reserved for raw JSON from an explicitly authorized,
synthetic live-provider Director bake-off. Offline fixture reports belong in
`artifacts/evaluation/` and are not decision evidence.

Each committed live result must retain the exact condition matrix, per-trial
latency/validity/cache/cost rows, vision-audit and sketch-study rows, spend cap,
pricing source/date, fixed rubric version, and early-stop reason if any. It must
contain no learner data or provider credential.

The live runner also appends `<result>.partial.ndjson` for every spend event and
composition row. Compatible rows may be resumed only from a contiguous,
zero-open-reservation source; the completed report records the source path,
SHA-256, run id, liability, and retained/discarded trial keys. Keep every source
NDJSON named by the final report. Other interrupted diagnostics belong in the
gitignored `artifacts/evaluation/` area. The completed raw JSON and architecture
decision record are the canonical evidence entry points.

## M1 supplemental delivery evidence

The M1 paired replay is intentionally separate from the live-provider M0 raw
artifact:

- `2026-09-01-drawing-m1-pipeline-browser-observations.json` is the immutable
  local Chromium observation ledger, pinned by SHA-256 in the M1 policy;
- `2026-09-01-drawing-m1-pipeline-study.json` is the independently verified
  derived report.

It makes zero provider calls and compares atomic versus incremental delivery
of the same Terra-low proposal. It may support delivery non-inferiority, but it
must never be presented as a model/generator comparison or as passing M1 while
the report's absolute 95% validity and actual UI-first-paint gates remain false.
