import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateImageGroundingStudy, planImageGroundingStudy } from './imageGroundingStudy.js';

const fixtureRaw = readFileSync('server/board/eval/fixtures/m7-image-grounding-study.json', 'utf8');

describe('M7 image grounding micro-study', () => {
  it('fits a five-call canary and 17-call full study under the conservative cap', () => {
    expect(planImageGroundingStudy(fixtureRaw, { reservePerCallUsd: 0.03, capUsd: 0.6 })).toEqual({
      syntheticItems: 6,
      canary: { proposals: 2, correctSelfChecks: 2, seededDefectChecks: 1, maximumCalls: 5, conservativeCostUsd: 0.15 },
      full: { proposals: 6, correctSelfChecks: 6, seededDefectChecks: 5, maximumCalls: 17, conservativeCostUsd: 0.51 },
      capUsd: 0.6,
      fits: true,
    });
  });

  it('measures pointing accuracy, self-check catches, and tap fallback independently', () => {
    const attempts = [
      ['axle', 0.9, true, 'approved'],
      ['fraction-denominator', 0.82, true, 'approved'],
      ['cell-organelle', 0.78, true, 'approved'],
      ['angle-arc', 0.8, true, 'approved'],
      ['timeline-event', 0.86, true, 'rejected'],
      ['graph-intersection', 0.7, false, null],
    ] as const;
    const report = evaluateImageGroundingStudy(fixtureRaw, {
      proposals: attempts.map(([itemId, confidence, accurate]) => ({
        itemId,
        selector: accurate
          ? JSON.parse(fixtureRaw).items.find((item: { id: string }) => item.id === itemId).expected
          : { type: 'PointSelector', x: 0.05, y: 0.05 },
        confidence,
      })),
      correctSelfChecks: attempts.flatMap(([itemId, _confidence, _accurate, outcome]) => outcome ? [{ itemId, outcome }] : []),
      defectSelfChecks: ['axle', 'fraction-denominator', 'cell-organelle', 'angle-arc', 'timeline-event'].map((itemId) => ({ itemId, outcome: 'rejected' as const })),
      malformedReplies: 0,
    });
    expect(report.metrics).toEqual({
      pointingAccuracy: 5 / 6,
      correctSelfCheckFalseRejectRate: 1 / 5,
      seededDefectCatchRate: 1,
      tapFallbackRate: 2 / 6,
      malformedReplyRate: 0,
    });
    expect(report.gates).toEqual({
      pointingAccuracy: true,
      correctSelfCheckFalseRejectRate: true,
      seededDefectCatchRate: true,
      malformedReplyRate: true,
    });
    expect(report.accepted).toBe(true);
  });
});
