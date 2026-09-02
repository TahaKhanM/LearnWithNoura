import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileImageGroundingStudyEvidence } from './imageGroundingEvidence.js';

const fixtureRawJson = readFileSync('server/board/eval/fixtures/m7-image-grounding-study.json', 'utf8');
const resultRawJson = readFileSync('server/board/eval/results/2026-09-02-drawing-m7-image-grounding-study.json', 'utf8');
const ledgerRawJsonl = readFileSync('server/board/eval/results/2026-09-02-drawing-m7-image-grounding-study.ledger.jsonl', 'utf8');

describe('M7 image grounding retained evidence', () => {
  it('recomputes corrected metrics and verifies every spend transition', () => {
    const evidence = compileImageGroundingStudyEvidence({ fixtureRawJson, resultRawJson, ledgerRawJsonl });
    expect(evidence.accepted).toBe(true);
    expect(evidence.metrics).toEqual({
      pointingAccuracy: 1,
      correctSelfCheckFalseRejectRate: 0,
      seededDefectCatchRate: 0.8,
      tapFallbackRate: 0,
      malformedReplyRate: 0,
    });
    expect(evidence.spend).toEqual({
      maximumProviderCalls: 17,
      actualProviderCalls: 17,
      hardCapUsd: 0.6,
      observedCostUsd: 0.005022,
      conservativeAccountedCostUsd: 0.51,
      openReservationUsd: 0,
    });
  });

  it('rejects result-only and ledger tampering', () => {
    expect(() => compileImageGroundingStudyEvidence({
      fixtureRawJson,
      resultRawJson: resultRawJson.replace('"providerCalls": 17', '"providerCalls": 16'),
      ledgerRawJsonl,
    })).toThrow(/hash/i);
    expect(() => compileImageGroundingStudyEvidence({
      fixtureRawJson,
      resultRawJson,
      ledgerRawJsonl: ledgerRawJsonl.replace('"status":"completed"', '"status":"failed"'),
    })).toThrow(/hash/i);
  });
});
