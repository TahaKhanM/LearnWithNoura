import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildM2RoleAdoptionEvidence, compileM2RoleAdoptionEvidence } from './roleAdoptionEvidence.js';

const read = (path: string) => readFileSync(resolve(path), 'utf8');

describe('Drawing vNext M2 role adoption evidence', () => {
  it('binds independent defaults to M0 audit and corrected-gate recovery evidence', () => {
    const report = buildM2RoleAdoptionEvidence({
      m0RawJson: read('server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json'),
      recoveryRawJson: read('server/board/eval/results/2026-09-01-drawing-f9-recovery-study.json'),
      generatedAt: '2026-09-02T05:05:00.000Z',
    });

    expect(report.defaults).toEqual({
      composition: { model: 'gpt-5.6-terra', reasoningEffort: 'low' },
      visionAudit: { model: 'gpt-5.6-luna', reasoningEffort: 'low', budgetMs: 3_000 },
      recovery: 'medium_escalation',
      hedge: 'off',
    });
    expect(report.auditEvidence).toMatchObject({
      sourceSha256: 'e02ccc9f240f72a7937fe192f30867434eb7f857fb6c45a5f8b52fa06507ae79',
      deterministicCatchRate: 1,
      deterministicFalseRejectRate: 0.0833,
      p95LatencyMs: 2398,
    });
    expect(report.recoveryEvidence).toMatchObject({
      sourceSha256: '54201d05481fa871abe1708c644a6f009183908a463ee1da5dc97f38e21d76ed',
      deliveredValidity: 0.972222,
      winner: 'medium_escalation',
      evidenceLabel: 'corrected-gate evidence',
    });
    expect(report.contracts).toMatchObject({
      scenePort: 'SceneModelPort.streamPropose',
      auditPort: 'VisionAuditPort.inspect',
      strictProductionStepSchema: true,
      legacyTextModelDrivesDrawingRoles: false,
      piiSentinelEscaped: false,
    });
    expect(report.liveSmoke).toEqual({
      status: 'requires_fresh_authorization',
      providerCalls: 0,
      costUsd: 0,
      claim: 'not_live_verified',
    });
  });

  it('verifies the retained report without converting offline evidence into a live claim', () => {
    const evidence = compileM2RoleAdoptionEvidence({
      m0RawJson: read('server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json'),
      recoveryRawJson: read('server/board/eval/results/2026-09-01-drawing-f9-recovery-study.json'),
      resultRawJson: read('server/board/eval/results/2026-09-02-drawing-m2-role-adoption.json'),
    });
    expect(evidence.resultSha256).toBe('0235f1cfde95421ac27f02252b6b12286282134e7fd973ff6edcb216ed4e4db3');
    expect(evidence.report.liveSmoke.claim).toBe('not_live_verified');
  });
});
