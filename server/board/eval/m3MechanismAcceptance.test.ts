import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileM3MechanismAcceptanceEvidence, computeM3MechanismAcceptance } from './m3MechanismAcceptance.js';

const read = (path: string) => readFileSync(resolve(path), 'utf8');
const input = {
  m0RawJson: read('server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json'),
  m1BrowserRawJson: read('server/board/eval/results/2026-09-01-drawing-m1-pipeline-browser-observations.json'),
  m1ReportRawJson: read('server/board/eval/results/2026-09-01-drawing-m1-pipeline-study.json'),
  recoveryRawJson: read('server/board/eval/results/2026-09-01-drawing-f9-recovery-study.json'),
  fixtureRawJson: read('server/board/eval/fixtures/m3-template-routing-fixtures.json'),
  browserRawJson: read('server/board/eval/results/2026-09-02-drawing-m3-template-browser.json'),
  matrixRawJson: read('server/board/eval/curriculum-matrix.json'),
  templateLaneSource: read('server/board/templateLane.ts'),
  streamingDirectorSource: read('server/board/streamingDirector.ts'),
  visualRequestsSource: read('server/realtime/visualRequests.ts'),
  screenshots: {
    numberLine: readFileSync(resolve('artifacts/evaluation/drawing-m3-templates/number-line.jpg')),
    fractionStrips: readFileSync(resolve('artifacts/evaluation/drawing-m3-templates/fraction-strips.jpg')),
    plottedGraph: readFileSync(resolve('artifacts/evaluation/drawing-m3-templates/plotted-graph.jpg')),
  },
  generatedAt: '2026-09-02T15:10:00.000Z',
};

describe('M3 mechanism-only acceptance', () => {
  it('proves exactly three exemplars and the open-set generative engine', () => {
    const report = computeM3MechanismAcceptance(input);

    expect(report.accepted).toBe(true);
    expect(report.scope).toBe('mechanism_only');
    expect(report.mechanism).toMatchObject({
      deterministicExtractorEntry: true,
      streamHeadShortCircuitEntry: true,
      neverGuessParameters: true,
      anchorTemplateStreamingOrder: true,
      exactTemplateSceneRemoved: true,
      exemplarTemplates: ['number_line', 'fraction_comparison', 'slope_comparison'],
      exemplarCount: 3,
      maximumFirstPaintMs: 36,
      firstPaintThresholdMs: 2_000,
      falseHoldoutCaptures: 0,
    });
    expect(report.openSetGenerative).toEqual({
      templateRoutingDisabled: true,
      rows: 40,
      firstPassAccepted: 37,
      recovered: 3,
      delivered: 40,
      deliveredValidity: 1,
      threshold: 0.95,
      passed: true,
    });
    expect(report.blendedFirstPassGate).toBe('deferred_to_m8');
    expect(report.retainedCompletedExtractors).toHaveLength(6);
  });

  it('hash-verifies the retained mechanism-only acceptance report', () => {
    const { generatedAt: _generatedAt, ...sources } = input;
    const evidence = compileM3MechanismAcceptanceEvidence({
      ...sources,
      resultRawJson: read('server/board/eval/results/2026-09-02-drawing-m3-mechanism-acceptance.json'),
    });
    expect(evidence.resultSha256).toBe('299c3b7a07a98114795c3cf760b98ad3ab4230cb7e31ac58b22e82fedb53a758');
    expect(evidence.report.accepted).toBe(true);
  });

  it('fails if an open-set intent is captured by a template', () => {
    const tampered = JSON.parse(input.browserRawJson) as { openSetCaptures: string[] };
    tampered.openSetCaptures = ['abstract-recursion'];
    expect(() => computeM3MechanismAcceptance({
      ...input,
      browserRawJson: `${JSON.stringify(tampered)}\n`,
    })).toThrow(/open-set|hash/i);
  });
});
