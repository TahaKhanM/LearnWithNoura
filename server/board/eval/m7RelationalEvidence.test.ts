import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileM7RelationalEvidence } from './m7RelationalEvidence.js';

const m0RawJson = readFileSync('server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json', 'utf8');
const resultRawJson = readFileSync('server/board/eval/results/2026-09-03-drawing-m7-relational-m0-replay-accepted.json', 'utf8');

describe('M7 relational M0 replay evidence', () => {
  it('verifies the deterministic representative selection and 95% gate', () => {
    const evidence = compileM7RelationalEvidence({ m0RawJson, resultRawJson });
    expect(evidence).toMatchObject({
      accepted: true,
      sourceRows: 36,
      eligibleRelationalRows: 34,
      originalValidatorAcceptedRows: 32,
      relationalRecoveredRows: 2,
      acceptedRows: 34,
      singleShotConjunctiveValidity: 1,
      threshold: 0.95,
      providerCalls: 0,
    });
  });

  it('rejects source and result tampering', () => {
    expect(() => compileM7RelationalEvidence({ m0RawJson: `${m0RawJson} `, resultRawJson })).toThrow(/hash/i);
    expect(() => compileM7RelationalEvidence({ m0RawJson, resultRawJson: resultRawJson.replace('"acceptedRows": 34', '"acceptedRows": 33') })).toThrow(/hash/i);
  });
});
