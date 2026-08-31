import { describe, expect, it } from 'vitest';
import { loadDirectorResumeEvidence, mergeDirectorResumeEvidence } from './resumeEvidence.js';

describe('Director live-evaluation resume evidence', () => {
  it('discards rows with superseded cache or incomplete blind-quality evidence', () => {
    const evidence = loadDirectorResumeEvidence(
      'server/board/eval/results/2026-08-31-drawing-model-bakeoff-attempt-7-cache-boundary.ndjson',
    );
    expect(evidence.metadata[0]).toMatchObject({
      sourceLiabilityUsd: 2.87231764,
      retainedTrialCount: 313,
      discardedTrialCount: 15,
    });
    expect(evidence.trials.every((trial) => trial.cacheExpectationMet)).toBe(true);
  });

  it('merges disjoint retained rows from multiple hashed run segments', () => {
    const merged = mergeDirectorResumeEvidence([
      loadDirectorResumeEvidence(
        'server/board/eval/results/2026-08-31-drawing-model-bakeoff-attempt-7-cache-boundary.ndjson',
      ),
      loadDirectorResumeEvidence(
        'server/board/eval/results/2026-09-01-drawing-model-bakeoff-attempt-12-transport-retries-exhausted.ndjson',
      ),
      loadDirectorResumeEvidence(
        'server/board/eval/results/2026-09-01-drawing-model-bakeoff-attempt-13-incomplete-quality.ndjson',
      ),
    ]);
    expect(merged.trials).toHaveLength(1_781);
    expect(merged.metadata).toHaveLength(3);
  });
});
