# Drawing vNext M1 paired delivery-path decision

Date: 2026-09-01
Status: supplemental study passed; M1 acceptance failed

## Decision

Keep `NOURA_DIRECTOR_PIPELINE=classic` as the default rollback-safe production
setting. The paired delivery evidence supports `each_validated_step` rather
than reveal-after-two buffering when the streaming lane is explicitly enabled,
but it does **not** authorize M1 acceptance or M2 work.

The study is deliberately a `paired_delivery_path_same_proposal` comparison.
It holds the Terra-low proposal constant and compares atomic whole-scene
preflight with production incremental parsing and every cumulative browser
preflight. It is not a classic-vs-streaming generator or model comparison.

## Evidence boundary

- Source: the immutable authorized M0 raw artifact, SHA-256
  `e02ccc9f240f72a7937fe192f30867434eb7f857fb6c45a5f8b52fa06507ae79`.
- Raw browser ledger: 360 atomic verdicts, 847 cumulative verdicts, 720
  renders, and zero external requests; SHA-256
  `a8847373ff3a9d3aa8bdd1c34fa5f4dcb99e4bc617ce23459ccdebd67767017a`.
- Derived report SHA-256:
  `44409bf22112a0e76ed95af0ccb605158f0f1fb01f16600acd5d79b67493d209`.
- Provider calls: 0. Incremental runtime cost: $0. The authorized bake-off
  liability remains $29.73066603 under the hard $30 ceiling.
- No child data, account credential, or external network request entered the
  replay. The browser collector accepts only the loopback `/dev/board` origin.

## Results

| Measure | Atomic | Streamed delivery | Decision |
| --- | ---: | ---: | --- |
| Diagram acceptance | 290 / 320 (90.625%) | 290 / 320 (90.625%) | 0 pp drop; within 5 pp |
| Holdout diagram acceptance | 92 / 100 | 92 / 100 | parity |
| Reusable blind grades | 24 / 24 | 24 / 24 | complete, non-attriting reuse |
| Mean blind grade | 3.7292 | 3.7292 | 0-grade delta |
| p50 provider-critical-path readiness | 4,708 ms | 2,655 ms | 43.6066% cut |

The readiness cut uses the authorized M0 provider timing boundary: first
browser-validated streamed step versus complete proposal. It is not renamed
or presented as actual learner-browser first paint. Actual first paint remains
the `visual_first_paint` / `ops_presented` contract and needs its own acceptance
evidence.

## Why M1 is not accepted

The full Terra-low cohort remains 329 / 360, or 91.3889%. The pre-registered
absolute first-pass validity gate is 95%; it is not met. A guarded multipass
layout repair was tested offline and numerically reached 95%, but manual raster
inspection exposed overlapping labels and nested-box text. That change was
reverted rather than weakening the quality bar.

Therefore:

1. delivery-path non-inferiority is proven for source-identical proposals;
2. the conservative provider-readiness cut exceeds 40%;
3. absolute first-pass validity and actual `ops_presented` first paint remain
   open acceptance blockers;
4. M2 must not start, and the classic pipeline remains the default.

## Reproduction

```bash
npm run test:director-m1-eval
```

Regeneration is provider-free and accepts only a loopback harness:

```bash
npm run client -- --host 127.0.0.1 --port 5180
npm run test:director-m1-eval -- --regenerate \
  --harness-url http://127.0.0.1:5180/dev/board
```
