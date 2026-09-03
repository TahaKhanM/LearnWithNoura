# Drawing vNext M7 handoff

**Date:** 2026-09-03  
**Technical status:** gates passed (offline-verified)  
**Acceptance:** not accepted — `processCompliant: false`  
**Blocker:** `provider_spend_process_violation`  
**Ratification:** given 2026-09-03 (process-complete; **not** retroactive authorization)

## Technical gates (hash-bound)

Result SHA-256 `e54d4aa964996b162f2ce6d6dd8579a114bf5689b4cd663f2c49c11336702e35`.

- Curriculum: 39/39 `supported` or `composable`; 0 missing; 39 browser-accepted.
- Relational M0 replay: 34/34 delivered (validity 1.0, threshold 0.95).
- Image-region grounding: pointing 1.0; seeded-defect catch 0.8; 17 authorized provider calls.
- G4 72-row Lesson-page sample: streaming p50 cut 0.413336 vs classic; no regression; 0 provider calls.
- Fast-tier annotations: sub-second, zero vision calls (predicates recomputed; living e2e screenshot hashes ignored).

## Spend incident (ratified, not authorized)

Incident `g4_harness_started_without_fixture_compiler`  
SHA-256 `a5fc906dfc4f98e45210809b57cf0f821d588b83023d3a6a8a38a96482036de8`

- Local G4 harness started a server with a provider key and without `NOURA_LESSON_COMPILER=fixture`.
- Synthetic only. No real child data. No itemized authorization.
- Observed: 6 synthetic sessions; 5 compiled lessons ready; 1 pending at shutdown.
- Minimum 11 completed provider requests. Exact call count and USD unknown (compiler usage is not persisted). No invoice was invented.
- Containment: server stopped; incident evidence excluded from G4; replacement run used fixture compiler and constructed no drawing provider.

The owner ratified this record as process-complete. Hash-bound `accepted` stays **false**. The calls were not authorized after the fact. `processCompliant` stays false.

## Containment in code

Local provider starts without the fixture compiler or an authorized live flag now fail closed (`server/providerStartGuard.ts`).

## Unproven

Target-device acoustics; real-child grounding behavior; full 290-row post-M7 G4 replay.

## Next

Do not start M8 or M6. M4/M5 remainder already landed offline. Live `gpt-image-2` still needs a fresh itemized cap.
