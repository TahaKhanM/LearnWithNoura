import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileM2LiveSmokeEvidence } from './m2LiveSmokeEvidence.js';

const read = (path: string) => readFileSync(resolve(path), 'utf8');

describe('M2 authorized live smoke evidence', () => {
  it('verifies measured usage and preserves the manual quality failure', () => {
    const evidence = compileM2LiveSmokeEvidence({
      resultRawJson: read('server/board/eval/results/2026-09-02-drawing-m2-live-smoke.json'),
      sceneRawJson: read('server/board/eval/fixtures/m2-live-smoke-directed-scene.json'),
      correctedScreenshot: readFileSync(resolve('artifacts/evaluation/drawing-m2-live-smoke-corrected.jpg')),
    });

    expect(evidence.resultSha256).toBe('8293830bc09e5ef2581883aaeba3612897dc6f231f5d98a565e52b24e3ad8a93');
    expect(evidence.report).toMatchObject({
      accepted: false,
      automatedSmokeGatePassed: true,
      manualQualityGatePassed: false,
      requiresAuthorizedRerun: true,
      providerUsage: {
        providerCalls: 3,
        estimatedObservedCostUsd: 0.1530788,
        accountedUpperBoundUsd: 0.68,
        hardCapHeadroomUsd: 0.57,
      },
      quality: {
        manualFinding: 'connector_label_overlap',
        correctedOfflineBrowserAccepted: true,
        correctedScreenshotInspected: true,
      },
    });
    expect(evidence.report.providerUsage.accountedUpperBoundUsd).toBeLessThanOrEqual(1.25);
    expect(evidence.report.providerUsage.estimatedObservedCostUsd).toBeLessThanOrEqual(
      evidence.report.providerUsage.accountedUpperBoundUsd,
    );
  });

  it('contains no synthetic learner identity or raw session identifier', () => {
    const raw = read('server/board/eval/results/2026-09-02-drawing-m2-live-smoke.json');
    expect(raw).not.toContain('Maya');
    expect(raw).not.toContain('3e362948-a435-4426-8624-f759e7a4b622');
  });
});
