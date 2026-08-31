import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDirectorEvalAuthorization } from './authorization.js';
import {
  DIRECTOR_EVAL_CONDITIONS,
  loadDirectorEvalCorpus,
  loadSeededDefects,
  materializeSketchCorpus,
  promptTuningCorpus,
} from './corpus.js';
import { chooseCompositionWinner } from './decision.js';
import { runOfflineDirectorEval } from './runDirectorEval.js';
import { directorEvalMessages } from './streamingProbe.js';
import { seededDefectOps, syntheticSketchOps } from './liveStudies.js';
import { validateOps } from '../../../shared/boardOps.js';
import { SpendGuard } from './liveDirectorEval.js';

describe('Drawing vNext M0 evaluation harness', () => {
  it('keeps 24 representative and 12 sealed holdout intents across every required category', () => {
    const corpus = loadDirectorEvalCorpus();
    const representative = corpus.filter((entry) => entry.split === 'representative');
    const holdout = corpus.filter((entry) => entry.split === 'holdout');

    expect(representative).toHaveLength(24);
    expect(holdout).toHaveLength(12);
    expect(new Set(corpus.map((entry) => entry.category))).toEqual(new Set([
      'exact_math_geometry',
      'graphs_charts',
      'scientific_systems',
      'timelines_causal',
      'grammar_structure',
      'comparisons_part_whole',
      'unfamiliar_abstract',
      'mixed_diagram_illustration',
      'revisions_existing_board',
    ]));
    expect(promptTuningCorpus().every((entry) => entry.split === 'representative')).toBe(true);
    expect(promptTuningCorpus()).toHaveLength(24);
    const revisions = corpus.filter((entry) => entry.category === 'revisions_existing_board');
    expect(revisions).toHaveLength(4);
    expect(revisions.every((entry) => (entry.existingBoardOps?.length ?? 0) > 0)).toBe(true);
  });

  it('pins the four single configurations and one first-valid-step hedge', () => {
    expect(DIRECTOR_EVAL_CONDITIONS).toEqual([
      { id: 'terra-low', legs: [{ model: 'gpt-5.6-terra', reasoningEffort: 'low', maxCompletionTokens: 4_000 }] },
      { id: 'terra-med', legs: [{ model: 'gpt-5.6-terra', reasoningEffort: 'medium', maxCompletionTokens: 4_000 }] },
      { id: 'luna-low', legs: [{ model: 'gpt-5.6-luna', reasoningEffort: 'low', maxCompletionTokens: 5_000 }] },
      { id: 'luna-med', legs: [{ model: 'gpt-5.6-luna', reasoningEffort: 'medium', maxCompletionTokens: 5_000 }] },
      {
        id: 'terra-low+luna-low',
        legs: [
          { model: 'gpt-5.6-terra', reasoningEffort: 'low', maxCompletionTokens: 2_000 },
          { model: 'gpt-5.6-luna', reasoningEffort: 'low', maxCompletionTokens: 2_000 },
        ],
      },
    ]);
  });

  it('keeps the cacheable Director policy static and puts intent data last', () => {
    const [first, second] = loadDirectorEvalCorpus();
    const firstMessages = directorEvalMessages(first);
    const secondMessages = directorEvalMessages(second);
    expect(firstMessages[0]).toEqual(secondMessages[0]);
    expect(firstMessages[0].role).toBe('system');
    expect(firstMessages[1].role).toBe('user');
    expect(firstMessages[1]).not.toEqual(secondMessages[1]);
    expect(JSON.stringify(firstMessages[0])).not.toContain(first.intent);
    expect(JSON.stringify(firstMessages[1])).toContain(first.intent);
  });

  it('applies the pre-registered validity, quality, latency, hedge, and cost rule', () => {
    const base = [
      { conditionId: 'terra-med', firstPassValidity: 0.99, qualityGrade: 4, p50FirstValidOpMs: 10_000, meanCostUsd: 0.03 },
      { conditionId: 'terra-low', firstPassValidity: 0.97, qualityGrade: 3, p50FirstValidOpMs: 7_000, meanCostUsd: 0.02 },
      { conditionId: 'luna-low', firstPassValidity: 0.96, qualityGrade: 3, p50FirstValidOpMs: 6_000, meanCostUsd: 0.005 },
      { conditionId: 'luna-med', firstPassValidity: 0.94, qualityGrade: 4, p50FirstValidOpMs: 7_500, meanCostUsd: 0.008 },
    ];
    expect(chooseCompositionWinner([
      ...base,
      { conditionId: 'terra-low+luna-low', firstPassValidity: 0.98, qualityGrade: 3, p50FirstValidOpMs: 5_150, meanCostUsd: 0.027 },
    ])).toMatchObject({ winnerConditionId: 'luna-low', hedgeAdopted: false });

    expect(chooseCompositionWinner([
      ...base,
      { conditionId: 'terra-low+luna-low', firstPassValidity: 0.98, qualityGrade: 3, p50FirstValidOpMs: 4_800, meanCostUsd: 0.027 },
    ])).toMatchObject({ winnerConditionId: 'terra-low+luna-low', hedgeAdopted: true });
  });

  it('ships seeded semantic defects and exactly thirty synthetic jittered sketches', () => {
    const defects = loadSeededDefects();
    expect(new Set(defects.map((entry) => entry.defectKind))).toEqual(new Set([
      'wrong_shading',
      'mislabeled_value',
      'reversed_arrow',
    ]));
    expect(defects.every((entry) => entry.deterministicValidatorPasses)).toBe(true);

    const sketches = materializeSketchCorpus();
    expect(sketches).toHaveLength(30);
    expect(sketches.every((entry) => entry.synthetic && entry.source === 'board_ui_base_plus_programmatic_jitter')).toBe(true);
    expect(new Set(sketches.map((entry) => entry.jitterSeed))).toEqual(new Set([1, 2, 3]));
    for (const defect of defects) {
      expect(validateOps(seededDefectOps(defect), { tier: 'authored' }).rejected).toEqual([]);
    }
    expect(syntheticSketchOps(sketches[0])[0]).toMatchObject({ op: 'add', spec: { kind: 'path' } });
  });

  it('runs 5 warm and 5 cold trials per condition and intent without provider calls', () => {
    const report = runOfflineDirectorEval();
    expect(report.pass).toBe(true);
    expect(report.evidenceMode).toBe('deterministic_offline_fixture');
    expect(report.providerCalls).toBe(0);
    expect(report.trials).toHaveLength(36 * 5 * 5 * 2);
    expect(report.trials.filter((trial) => trial.cacheState === 'warm')).toHaveLength(36 * 5 * 5);
    expect(report.trials.filter((trial) => trial.qualitySampled)).toHaveLength(25 * 5);
    expect(report.trials.filter((trial) => !trial.qualitySampled).every((trial) =>
      trial.qualityGrade === null && !trial.qualityEvidenceComplete)).toBe(true);
    expect(report.compositionDecision.status).toBe('offline_fixture_only');
    expect(report.visionAudit.seededDefectCount).toBeGreaterThanOrEqual(9);
    expect(report.visionAudit.deterministicCatchRate).toBe(0);
    expect(report.sketchGrounding.itemCount).toBe(30);
    expect(report.sketchGrounding.cheaperModelAssistDefault).toBe('off');
  });

  it('requires an explicit live flag and enforces the hard thirty-dollar ceiling', () => {
    expect(parseDirectorEvalAuthorization([])).toEqual({
      authorizedLiveRun: false,
      maxSpendUsd: 30,
    });
    expect(parseDirectorEvalAuthorization(['--authorized-live-run', '--max-spend-usd', '25'])).toEqual({
      authorizedLiveRun: true,
      maxSpendUsd: 25,
    });
    expect(() => parseDirectorEvalAuthorization(['--authorized-live-run', '--max-spend-usd', '30.01'])).toThrow(/30/);
    expect(() => parseDirectorEvalAuthorization(['--authorized-live-run', '--max-spend-usd', 'zero'])).toThrow(/spend/i);
  });

  it('stops before a live call could cross its configured spend ceiling', () => {
    const spend = new SpendGuard(1);
    const callId = spend.begin({ phase: 'composition', models: ['gpt-5.6-terra'], reserveUsd: 0.8 });
    spend.noteProviderCalls(callId, 1);
    spend.complete(callId, { status: 'completed', observedCostUsd: 0.7, upperBoundUsd: 0.7, usage: [] });
    expect(spend.providerCalls).toBe(1);
    expect(spend.estimatedCostUsd).toBe(0.7);
    expect(() => spend.begin({ phase: 'judge', models: ['gpt-5.6-luna'], reserveUsd: 0.31 })).toThrow(/spend cap/i);
  });

  it('exposes a default-offline package gate', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['test:director-eval']).toBe('tsx scripts/evaluate-director.ts');
    expect(packageJson.scripts['test:director-eval']).not.toContain('authorized-live-run');
  });
});
