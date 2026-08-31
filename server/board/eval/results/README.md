# Authorized Drawing vNext evaluation results

This directory is reserved for raw JSON from an explicitly authorized,
synthetic live-provider Director bake-off. Offline fixture reports belong in
`artifacts/evaluation/` and are not decision evidence.

Each committed live result must retain the exact condition matrix, per-trial
latency/validity/cache/cost rows, vision-audit and sketch-study rows, spend cap,
pricing source/date, fixed rubric version, and early-stop reason if any. It must
contain no learner data or provider credential.

The live runner also appends `<result>.partial.ndjson` after every composition
trial. Keep it with an interrupted run for recovery/audit; a completed final
JSON remains the decision record.
