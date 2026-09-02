import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileM2LiveSmokeRerunEvidence } from './m2LiveSmokeRerunEvidence.js';

const read = (path: string) => readFileSync(resolve(path), 'utf8');

describe('corrected M2 authorized live-smoke rerun', () => {
  it('verifies the adopted-role live gate, spend, screenshots, and evidence boundary', () => {
    const evidence = compileM2LiveSmokeRerunEvidence({
      resultRawJson: read('server/board/eval/results/2026-09-02-drawing-m2-live-smoke-rerun.json'),
      sceneRawJson: read('server/board/eval/fixtures/m2-live-smoke-rerun-directed-scene.json'),
      liveStep2Screenshot: readFileSync(resolve('artifacts/evaluation/drawing-m2-live-smoke-rerun-step2.png')),
      liveStep3Screenshot: readFileSync(resolve('artifacts/evaluation/drawing-m2-live-smoke-rerun-step3.png')),
      fullTerminalScreenshot: readFileSync(resolve('artifacts/evaluation/drawing-m2-live-smoke-rerun-full.jpg')),
    });

    expect(evidence.resultSha256).toBe('80f9cc3d50467e9a36be7cf6dd27d2bbb17d3ddb52ad7d2fdc0df397f339bf63');
    expect(evidence.report).toMatchObject({
      accepted: true,
      acceptanceScope: 'adopted_role_configuration_and_second_board_change',
      journey: {
        secondBoardChangeObserved: true,
        secondSectionOpened: true,
        auditOutcome: 'approved',
        auditDurationMs: 1850,
        recoveryUsed: false,
        thirdRevealLiveStatus: 'not_observed_before_smoke_end',
      },
      providerUsage: {
        providerCalls: 3,
        estimatedObservedCostUsd: 0.1412604,
        accountedUpperBoundUsd: 0.68,
        hardCapHeadroomUsd: 0.17,
      },
      quality: {
        liveObservedFramesPassed: true,
        connectorLabelOverlapPresent: false,
        fullTerminalSceneBrowserAcceptedOffline: true,
        semanticContentPassed: true,
      },
    });
    expect(evidence.report.evidenceBoundary.notProven).toContain(
      'third storyboard reveal on the live LessonPage before session end',
    );
  });

  it('retains no synthetic learner name, raw transcript, or session identifier', () => {
    const raw = read('server/board/eval/results/2026-09-02-drawing-m2-live-smoke-rerun.json');
    expect(raw).not.toContain('Maya');
    expect(raw).not.toContain('eac1a098-b534-45cb-ad13-39f09b5a2823');
    expect(raw).not.toContain('Wait — please draw');
  });
});
