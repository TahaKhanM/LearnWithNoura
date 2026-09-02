# Drawing vNext M0 model bake-off decision

Date: 2026-09-01. Status: authorized synthetic evidence complete; composition
adoption withheld by the pre-registered rule.

## Decision

- **Composition:** no condition cleared the required 95% first-pass validity
  bar. No composition arm is adopted as an evidence-backed default, and the
  hedge remains off. M1 may use its explicitly mandated Terra-low interim
  configuration behind the temporary pipeline rollback, but that is an
  implementation fallback, not an M0 winner. M2 must not describe it as a
  bake-off adoption.
- **Vision audit:** adopt `gpt-5.6-luna` at low reasoning effort. Gate step 1
  for a measured 3,000 ms budget; deterministic validation remains the hard
  authority. If the budget expires, use the approved step-2 fallback policy.
- **Sketch grounding:** keep cheaper-model assistance off. Both candidates
  reached only 10% accuracy on the synthetic corpus, with zero paired gain and
  one-sided p=1.0. This evidence cannot authorize check-grading assistance.
- **Prompt caching:** retain the static-prefix/dynamic-suffix request shape.
  Cold cells stayed cold; substantive warm-hit rates were 98.3%–100% by
  condition. Individual cache misses remain measured data rather than aborting
  the study.

## Authorized live evidence

Raw evidence: `server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json`
(SHA-256 `e02ccc9f240f72a7937fe192f30867434eb7f857fb6c45a5f8b52fa06507ae79`).

The completed report contains 1,800 composition rows: 24 representative and 12
sealed holdout synthetic intents, five conditions, five cold trials, and five
warm trials. Blind raster quality was pre-registered on cold trial 1 for a
25-intent all-category sample (16 representative, 9 holdout). All 125 planned
sample rows were observed; 116 passed deterministic/browser validation and all
116 received a valid blind grade.

The final report is assembled from three SHA-256-bound, zero-open-reservation
run segments plus a fresh tail. Retained rows are compared byte-for-byte with
their source NDJSON by the decision-evidence compiler. Incompatible output-cap,
cache-boundary, and invalid-judge rows were discarded and rerun; they are not
mixed into the final matrix.

| Condition | Eligible | First-pass validity | Quality | p50 TTFT | p50 first valid op | p50 complete | Mean upper-bound cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| terra-low | no | 91.4% | 3.73 | 1,122 ms | 2,834 ms | 4,953 ms | $0.011203 |
| terra-med | no | 90.3% | 3.81 | 1,388 ms | 3,760 ms | 5,474 ms | $0.012544 |
| luna-low | no | 90.0% | 3.48 | 4,286 ms | 5,652 ms | 7,607 ms | $0.001316 |
| luna-med | no | 85.3% | 3.63 | 9,435 ms | 10,556 ms | 12,537 ms | $0.001968 |
| terra-low + luna-low | no | 88.6% | 3.41 | 1,125 ms | 2,876 ms | 4,911 ms | $0.017848 |

The hedge did not beat the best eligible single arm because there was no
eligible single arm, and it also posted lower validity and quality than
Terra-low at higher combined cost. Adopting it would violate the pre-registered
rule.

### Cache evidence

| Condition | Cold expectation | Warm substantive-hit rate |
| --- | ---: | ---: |
| terra-low | 100.0% | 100.0% |
| terra-med | 100.0% | 98.9% |
| luna-low | 100.0% | 99.4% |
| luna-med | 100.0% | 98.3% |
| terra-low + luna-low | 100.0% | 100.0% |

Provider cache reporting for these models rounds down to 128-token boundaries.
The raster-bearing reusable prefix reported 1,792 cached tokens, so the study
requires at least that substantive block; a token-level or zero hit never
counts as warm evidence.

### Vision audit

| Condition | Catch rate | False-reject rate | Invalid replies | p50 | p95 | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Deterministic checks | 0.0% | 0.0% | n/a | n/a | n/a | $0 |
| terra-low | 91.7% | 8.3% | 0.0% | 1,450 ms | 2,069 ms | $0.050612 |
| luna-low | 100.0% | 8.3% | 0.0% | 1,466 ms | 2,398 ms | $0.005608 |

Luna-low clears the catch, false-reject, invalid-reply, latency, and cost bars.
Its 3,000 ms budget covers measured p95 plus the bounded network margin.

### Sketch grounding

| Condition | Accuracy | Brier score | Invalid replies | Cost |
| --- | ---: | ---: | ---: | ---: |
| terra-low | 10.0% | 0.0900 | 0.0% | $0.067608 |
| luna-low | 10.0% | 0.0929 | 0.0% | $0.007042 |

Paired assisted accuracy was also 10%, for +0 percentage points and p=1.0.
Cheaper-model assistance remains off and is not eligible for check grading.

## Spend and provenance

The user authorized a cumulative hard maximum of $30. Failed and
usage-incomplete calls were charged their full conservative reservation. The
session ended with $29.29978078 carried into the final tail and $0.43088525
accounted by that tail, for a cumulative conservative liability of
**$29.73066603**. No ledger has an open reservation.

The three retained source NDJSONs remain checked in because the final report
names and hashes them. Other diagnostic-only attempts are preserved locally
under the gitignored `artifacts/evaluation/drawing-vnext-diagnostics/` directory
and are not decision inputs. The compiler rejects missing, modified,
overlapping, or incompatible retained resume rows.

All inputs were checked-in synthetic intents, synthetic existing-board rasters,
seeded semantic defects/controls, and synthetic jittered sketches. No child
data, learner identifier, account credential, or generated-image call entered
the study. Browser validation used the local production-shaped `/dev/board`
harness.

## Consequences for later milestones

1. M1 keeps the prompt's Terra-low interim path and one escalated retry, but M1
   acceptance must improve deterministic/browser first-pass validity rather
   than lowering the 95% bar.
2. M2 adopts Luna-low for the vision-audit role and a 3,000 ms gate. It does
   not adopt a composition or hedge winner from M0.
3. M3's deterministic template lane is now more important for exact and
   quantitative requests: generative composition did not meet the reliability
   bar even when latency and schema completion were strong.
4. M5 leaves cheaper-model sketch assistance off.

Official provider references used for the run: [model comparison and
pricing](https://developers.openai.com/api/docs/models/compare), [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), and [prompt
caching](https://developers.openai.com/api/docs/guides/prompt-caching).

## Architecture-owner addendum: corrected M1 gates and evidence conclusions

This addendum does not rewrite the pre-registered M0 decision above. The gate
ambiguity and corrected layered M1 acceptance criteria were recorded before
recomputation in
[`2026-09-01-drawing-vnext-m1-acceptance-and-continuation-prompt.md`](2026-09-01-drawing-vnext-m1-acceptance-and-continuation-prompt.md).
The original M0 statement that no composition arm cleared its then-binding 95%
conjunctive gate remains historically true; Terra-low is not relabelled an M0
winner.

The sketch conclusion is corrected from “negative” to **uninformative**. Both
models returned the constant answer “straight line” across the 30-item corpus,
and exact-string grading was applied to a non-enum field. Assistance remains
off, but this study is not evidence that assistance cannot work. M5 owns an
enum-constrained, human-verifiable corpus rebuild with realistic stroke sizes;
no additional sketch spend was made here.

The hedge rejection stands: it had lower validity and quality than Terra-low
at higher cost. Evidence bloat is also acknowledged: approximately $12.72 of
the old $30 ceiling funded discarded diagnostics. New work uses fit-before-
launch, canary-first, early-stop studies and retains derived reports plus
hashes; raw ledgers are retained only when a decision record names and hashes
them.

The authorized F9 conditional recovery study is new corrected-gate evidence,
not an M0 winner selection. It used 53 calls and accounted $0.2692976 under a
$3.25 ceiling. Terra-medium escalation recovered 21/24 screened failures,
reaching 350/360 delivered scenes (97.2222%) with mean blind grade 3.9643.
Targeted low-effort correction recovered 2/13; correction then escalation did
not improve on medium alone. Therefore Terra-medium escalation alone is the
cheapest qualifying recovery default. The retained result SHA-256 is
`54201d05481fa871abe1708c644a6f009183908a463ee1da5dc97f38e21d76ed`.
