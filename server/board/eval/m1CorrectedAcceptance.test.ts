import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileCorrectedM1AcceptanceEvidence, computeCorrectedM1Acceptance } from './m1CorrectedAcceptance.js';

const read = (path: string) => readFileSync(resolve(path), 'utf8');
const input = {
  sourceRawJson: read('server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json'),
  browserObservationRawJson: read('server/board/eval/results/2026-09-01-drawing-m1-pipeline-browser-observations.json'),
  m1ReportRawJson: read('server/board/eval/results/2026-09-01-drawing-m1-pipeline-study.json'),
  recoveryRawJson: read('server/board/eval/results/2026-09-01-drawing-f9-recovery-study.json'),
  firstPaintRawJson: read('server/board/eval/results/2026-09-01-drawing-g4-first-paint.json'),
  verificationGates: [
    'npm run build', 'npm run typecheck:server', 'npm run lint', 'npm run test:smoke-report',
    'npm run test:lesson-eval', 'npm test', 'npm audit --omit=dev', 'npm run test:integration',
    'npm run test:e2e', 'npm run test:visual', 'npm run test:a11y', 'npm run test:security',
    'npm run test:storage', 'npm run test:brand', 'npm run test:runtime-models',
    'npm run test:director-eval', 'npm run test:director-m1-eval',
    'npm run test:director-recovery', 'npm run test:first-paint',
  ].map((command) => ({ command, exitCode: 0 })),
  generatedAt: '2026-09-02T04:35:00.000Z',
};
const resultRawJson = read('server/board/eval/results/2026-09-01-drawing-m1-corrected-acceptance.json');

describe('corrected Drawing vNext M1 acceptance', () => {
  it('applies G1-G5 independently from immutable evidence', () => {
    const report = computeCorrectedM1Acceptance(input);

    expect(report.accepted).toBe(true);
    expect(report.gates).toMatchObject({
      G1: { numerator: 360, denominator: 360, rate: 1, threshold: 0.95, passed: true },
      G2: { numerator: 329, denominator: 360, rate: 0.913889, threshold: 0.9, passed: true },
      G3: { numerator: 350, denominator: 360, rate: 0.972222, threshold: 0.97, passed: true, recoveryDefault: 'medium_escalation' },
      G4: { streamingP50Ms: 2818, classicP50Ms: 4909, p50Cut: 0.425952, passed: true },
      G5: { commands: 19, failedCommands: [], passed: true },
    });
    expect(report.evidence.newProviderSpend).toEqual({
      authorizedCapUsd: 3.25,
      accountedCostUsd: 0.2692976,
      headroomUsd: 2.9807024,
      providerCalls: 53,
    });
  });

  it('verifies the checked-in corrected acceptance report by hash and recomputation', () => {
    const evidence = compileCorrectedM1AcceptanceEvidence({
      sourceRawJson: input.sourceRawJson,
      browserObservationRawJson: input.browserObservationRawJson,
      m1ReportRawJson: input.m1ReportRawJson,
      recoveryRawJson: input.recoveryRawJson,
      firstPaintRawJson: input.firstPaintRawJson,
      resultRawJson,
    });

    expect(evidence.resultSha256).toBe('72e12e65eed3361e169e29dabedbb87d26f83542022db8f7c21903360409c2e7');
    expect(evidence.report.accepted).toBe(true);
  });

  it('does not collapse the corrected layered gates back into a 95% conjunction', () => {
    const failedG2 = computeCorrectedM1Acceptance({
      ...input,
      verificationGates: input.verificationGates.map((gate) =>
        gate.command === 'npm run test:e2e' ? { ...gate, exitCode: 1 } : gate),
    });
    expect(failedG2.gates.G2.passed).toBe(true);
    expect(failedG2.gates.G5.passed).toBe(false);
    expect(failedG2.accepted).toBe(false);
  });
});
