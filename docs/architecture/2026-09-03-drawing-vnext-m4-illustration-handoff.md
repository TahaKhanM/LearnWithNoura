# Drawing vNext M4 illustration handoff

**Date:** 2026-09-03  
**Implementation status:** complete and offline-verified  
**Acceptance:** not accepted — live illustration trace still requires itemized authorization  
**Deadline:** 2026-12-01

## Decisions

1. Default `NOURA_ILLUSTRATION_MODEL=gpt-image-2`. Cache hits stay free.
2. Director emits overlay BoardOps plus an `illustrationBrief`. `prepare` is not in the Director attempt loop.
3. Parallel lane (`server/realtime/illustrationLane.ts`) generates behind `illustration_status`. Arrival: same run still active → append validated `image` as the final reveal step; run gone → `stageServerInitiatedCheckpoint`. Failure keeps overlays and emits one honest note.
4. A ready image waits until overlay intake is complete, so it is never first paint. Compile paints `image` specs behind other items even when the image arrives last.
5. Per-lesson budget ≤2 paid generations; over-budget fail-closed at generate time (`illustration_budget:exhausted`). Tutor prompt does not promise a picture before it is visible. Illustration vision uses closed `illustration_vision:*` codes only.
6. Streaming illustration headers no longer fall back to classic. M1 eval still uses the historical route name `classic_illustration`.
7. M3 hash-verify ignores later-milestone source fingerprints; mechanism predicates still recompute against live sources.

## Offline evidence

- `npm run gate:quick`: 865 tests passed after the follow-up. Zero provider calls.
- Scripted doubles: overlay-then-image, image-ready-before-overlays, slow checkpoint, generation failure, budget remaining=2, generate skipped at remaining=0.
- `npm run test:e2e`: 30 passed, including `tests/e2e/illustration-arrival.spec.ts`. Screenshots inspected: preparing banner; overlay `frog` with banner up; banner gone on ready with overlay remaining; failed banner with overlay remaining.
- Offline eval verifiers (`test:director-eval` through `audit:m7-acceptance`) passed. M7 remains `accepted: false` on the spend incident.
- `npm run test:visual`: 12 home/lesson snapshots passed. 48 `/dev/board` harness snapshots fail because M7 added fixture buttons the baselines do not include. Diffs are chrome, not board geometry. Baselines were not refreshed.
- `npm audit --omit=dev`: 1 moderate `qs` advisory in a transitive dependency; lockfile unchanged.

## Deferred

- One authorized live `gpt-image-2` trace with latency + cost on `illustration_generation`. Not run. Do not start it without a fresh itemized cap.
- M7 spend incident is owner-ratified as process-complete, not authorized
  after the fact. Hash-bound `accepted` stays false.
- Harness visual baselines for M7 chrome.

## Next

M5 remainder (KaTeX snapshot fidelity + sketch-corpus rebuild). Do not start M8 or M6.
