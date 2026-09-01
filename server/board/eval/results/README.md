# Authorized Drawing vNext evaluation results

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
