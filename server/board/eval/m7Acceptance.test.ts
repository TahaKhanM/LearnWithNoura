import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileM7AcceptanceEvidence, computeM7Acceptance } from './m7Acceptance.js';

const read = (path: string) => readFileSync(resolve(path), 'utf8');
const curriculumResultRawJson = read('server/board/eval/results/2026-09-03-drawing-m7-curriculum-browser-verified.json');
const curriculumResult = JSON.parse(curriculumResultRawJson) as { rows: Array<{ rowId: string; screenshotPath: string }>; contactSheets: Array<{ path: string }> };
const input = {
  curriculum: {
    matrixRawJson: read('server/board/eval/curriculum-matrix-m7.json'),
    baselineFixturesRawJson: read('server/board/eval/fixtures/curriculum-matrix-scenes.json'),
    m7FixturesRawJson: read('server/board/eval/fixtures/m7-curriculum-new-scenes.json'),
    resultRawJson: curriculumResultRawJson,
    screenshots: Object.fromEntries(curriculumResult.rows.map((row) => [row.rowId, readFileSync(resolve(row.screenshotPath))])),
    contactSheets: curriculumResult.contactSheets.map((sheet) => readFileSync(resolve(sheet.path))),
  },
  m0RawJson: read('server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json'),
  relationalResultRawJson: read('server/board/eval/results/2026-09-03-drawing-m7-relational-m0-replay-accepted.json'),
  groundingFixtureRawJson: read('server/board/eval/fixtures/m7-image-grounding-study.json'),
  groundingResultRawJson: read('server/board/eval/results/2026-09-02-drawing-m7-image-grounding-study.json'),
  groundingLedgerRawJsonl: read('server/board/eval/results/2026-09-02-drawing-m7-image-grounding-study.ledger.jsonl'),
  previousG4RawJson: read('server/board/eval/results/2026-09-01-drawing-g4-first-paint.json'),
  m7G4RawJson: read('server/board/eval/results/2026-09-03-drawing-m7-g4-first-paint.json'),
  m7G4StreamingScreenshot: readFileSync(resolve('artifacts/evaluation/drawing-m7-g4-first-paint/streaming-first-paint.png')),
  m7G4ClassicScreenshot: readFileSync(resolve('artifacts/evaluation/drawing-m7-g4-first-paint/classic-first-paint.png')),
  incidentRawJson: read('server/board/eval/results/2026-09-03-m7-g4-harness-provider-incident.json'),
  fastTierUnitSource: read('server/realtime/proxy.test.ts'),
  fastTierE2ESource: read('tests/e2e/interaction-lifecycle.spec.ts'),
  fastTierScreenshot: readFileSync(resolve('artifacts/evaluation/drawing-m7-fast-annotations.png')),
  generatedAt: '2026-09-03T00:00:00.000Z',
};

describe('M7 acceptance audit', () => {
  it('passes every technical gate but blocks formal acceptance on the recorded spend incident', () => {
    const report = computeM7Acceptance(input);
    expect(report.technicalAccepted).toBe(true);
    expect(report.accepted).toBe(false);
    expect(report.blockers).toEqual(['provider_spend_process_violation']);
    expect(report.curriculum).toMatchObject({ totalRows: 39, missingRows: 0, browserAccepted: 39 });
    expect(report.relational).toMatchObject({ rows: 34, validity: 1, threshold: 0.95 });
    expect(report.grounding).toMatchObject({ pointingAccuracy: 1, seededDefectCatchRate: 0.8, providerCalls: 17, observedCostUsd: 0.005022 });
    expect(report.g4).toMatchObject({ sampleRows: 72, totalRows: 290, streamingP50FirstPaintMs: 2789, p50Cut: 0.413336, noRegression: true });
    expect(report.fastTier).toMatchObject({ thresholdMs: 1000, zeroVisionCalls: true, actualLessonE2E: true });
  });

  it('hash-verifies the retained blocked acceptance audit', () => {
    const { generatedAt: _generatedAt, ...sources } = input;
    const evidence = compileM7AcceptanceEvidence({
      ...sources,
      resultRawJson: read('server/board/eval/results/2026-09-03-drawing-m7-acceptance.json'),
    });
    expect(evidence.resultSha256).toBe('e54d4aa964996b162f2ce6d6dd8579a114bf5689b4cd663f2c49c11336702e35');
    expect(evidence.report).toMatchObject({ technicalAccepted: true, accepted: false });
  });

  it('still reproduces when a later e2e recapture changes the gitignored screenshot', () => {
    const { generatedAt: _generatedAt, ...sources } = input;
    const evidence = compileM7AcceptanceEvidence({
      ...sources,
      fastTierScreenshot: Buffer.from('later-e2e-recapture'),
      fastTierE2ESource: `${input.fastTierE2ESource}\n// later milestone comment\n`,
      resultRawJson: read('server/board/eval/results/2026-09-03-drawing-m7-acceptance.json'),
    });
    expect(evidence.report.accepted).toBe(false);
    expect(evidence.report.fastTier.zeroVisionCalls).toBe(true);
    expect(evidence.report.fastTier.actualLessonE2E).toBe(true);
  });

  it('rejects any incident or G4 artifact tampering', () => {
    expect(() => computeM7Acceptance({ ...input, incidentRawJson: `${input.incidentRawJson} ` })).toThrow(/incident.*hash/i);
    expect(() => computeM7Acceptance({ ...input, m7G4RawJson: input.m7G4RawJson.replace('"rows": 72', '"rows": 71') })).toThrow(/G4.*hash/i);
  });
});
