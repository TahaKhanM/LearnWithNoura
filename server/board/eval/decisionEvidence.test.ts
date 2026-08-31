import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import rubric from './fixtures/director-raster-rubric.json' with { type: 'json' };
import { plannedLiveBudget } from './budget.js';
import {
  DIRECTOR_EVAL_CONDITIONS,
  loadDirectorEvalCorpus,
  loadDirectorQualitySampleIntentIds,
  loadSeededDefects,
  materializeSketchCorpus,
} from './corpus.js';
import { compileDirectorBakeoffDecisionEvidence } from './decisionEvidence.js';
import { chooseCompositionWinner } from './decision.js';
import { summarizeConditions } from './liveDirectorEval.js';
import { chooseVisionAuditDecision } from './liveStudies.js';
import { runOfflineDirectorEval } from './runDirectorEval.js';
import { LiveSpendLedger } from './spendLedger.js';
import type { DirectorEvalTrial } from './types.js';

describe('Drawing vNext M0 decision-evidence compiler', () => {
  it('accepts a complete negative composition decision without inventing a winner', () => {
    const raw = readFileSync(
      'server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json',
      'utf8',
    );
    const evidence = compileDirectorBakeoffDecisionEvidence(raw);
    expect(evidence.trialRounds).toBe(5);
    expect(evidence.composition.winnerConditionId).toBeNull();
    expect(evidence.composition.hedgeAdopted).toBe(false);
    expect(evidence.visionAudit.selectedConditionId).toBe('luna-low');
  });

  it('reproduces decisions and emits copy-ready summary tables from completed raw JSON', () => {
    const report = completedLiveReportFixture();
    const rawJson = `${JSON.stringify(report, null, 2)}\n`;
    const evidence = compileDirectorBakeoffDecisionEvidence(rawJson, {
      rawEvidencePath: 'server/board/eval/results/test-raw.json',
    });

    expect(evidence.rawEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.trialRounds).toBe(5);
    expect(evidence.composition.winnerConditionId).toBe(report.compositionDecision.winnerConditionId);
    expect(evidence.visionAudit.selectedConditionId).toBe('luna-low');
    expect(evidence.visionAudit.auditBudgetMs).toBe(1_500);
    expect(evidence.sketchGrounding.cheaperModelAssistDefault).toBe('off');
    expect(evidence.cache).toHaveLength(10);
    expect(evidence.cache.every((row) => row.expectationPassRate === 1)).toBe(true);
    expect(evidence.markdown).toContain('### Composition summary');
    expect(evidence.markdown).toContain('| p50 first valid op |');
    expect(evidence.markdown).toContain('### Cache evidence');
    expect(evidence.markdown).toContain('### Vision-audit summary');
    expect(evidence.markdown).toContain('### Sketch-grounding summary');
    expect(evidence.markdown).toContain('server/board/eval/results/test-raw.json');
    expect(evidence.markdown).toContain('Authorization accounting reserves $0.260000');
    expect(evidence.markdown).toContain('balanced spend ledger for run `decision-evidence-test-run`');
  });

  it('rejects offline, failed, and incomplete reports instead of drafting a decision from them', () => {
    const offline = runOfflineDirectorEval();
    expect(() => compileDirectorBakeoffDecisionEvidence(JSON.stringify(offline)))
      .toThrow(/completed passing live report/i);

    const failed = { ...completedLiveReportFixture(), pass: false };
    expect(() => compileDirectorBakeoffDecisionEvidence(JSON.stringify(failed)))
      .toThrow(/completed passing live report/i);

    expect(() => compileDirectorBakeoffDecisionEvidence('{"schemaVersion":'))
      .toThrow(/not valid JSON/i);
  });

  it('rejects stale reported decisions even when the raw rows and summaries remain valid', () => {
    const report = completedLiveReportFixture();
    report.compositionDecision = {
      ...report.compositionDecision,
      winnerConditionId: report.compositionDecision.winnerConditionId === 'terra-low'
        ? 'luna-low'
        : 'terra-low',
    };
    expect(() => compileDirectorBakeoffDecisionEvidence(JSON.stringify(report)))
      .toThrow(/composition decision does not reproduce/i);
  });

  it('rejects an unbalanced raw matrix and a forged cache claim', () => {
    const unbalanced = completedLiveReportFixture();
    unbalanced.trials.pop();
    expect(() => compileDirectorBakeoffDecisionEvidence(JSON.stringify(unbalanced)))
      .toThrow(/missing|trial count|summaries/i);

    const cacheMismatch = completedLiveReportFixture();
    const warm = cacheMismatch.trials.find((trial) => trial.cacheState === 'warm');
    expect(warm).toBeDefined();
    warm!.modelUsage[warm!.selectedLegIndex].cachedInputTokens = 0;
    expect(() => compileDirectorBakeoffDecisionEvidence(JSON.stringify(cacheMismatch)))
      .toThrow(/cache expectation/i);
  });

  it('rejects open reservations and ledger summaries that diverge from report totals', () => {
    const leaked = completedLiveReportFixture();
    leaked.spendLedger.entries.pop();
    expect(() => compileDirectorBakeoffDecisionEvidence(JSON.stringify(leaked)))
      .toThrow(/open reservation/i);

    const open = completedLiveReportFixture();
    open.spendLedger.openReservationUsd = 0.01;
    expect(() => compileDirectorBakeoffDecisionEvidence(JSON.stringify(open)))
      .toThrow(/open reservation/i);

    const divergent = completedLiveReportFixture();
    divergent.spendLedger.providerCalls += 1;
    expect(() => compileDirectorBakeoffDecisionEvidence(JSON.stringify(divergent)))
      .toThrow(/terminal provider calls/i);

    const costMismatch = completedLiveReportFixture();
    costMismatch.accountedCostUsd += 0.01;
    expect(() => compileDirectorBakeoffDecisionEvidence(JSON.stringify(costMismatch)))
      .toThrow(/terminal accounted cost/i);
  });

  it('rejects invalid spend-ledger sequences, call IDs, and cumulative values', () => {
    const badSequence = completedLiveReportFixture();
    badSequence.spendLedger.entries[1].sequence += 1;
    expect(() => compileDirectorBakeoffDecisionEvidence(JSON.stringify(badSequence)))
      .toThrow(/event sequence/i);

    const badCall = completedLiveReportFixture();
    badCall.spendLedger.entries[1].callId = 'eval-call-999';
    expect(() => compileDirectorBakeoffDecisionEvidence(JSON.stringify(badCall)))
      .toThrow(/without an open reservation/i);

    const skippedCallId = completedLiveReportFixture();
    skippedCallId.spendLedger.entries[0].callId = `${skippedCallId.spendLedger.runId}:call-2`;
    expect(() => compileDirectorBakeoffDecisionEvidence(JSON.stringify(skippedCallId)))
      .toThrow(/not the next call ID/i);

    const duplicateStart = completedLiveReportFixture();
    duplicateStart.spendLedger.entries[2].status = 'started';
    expect(() => compileDirectorBakeoffDecisionEvidence(JSON.stringify(duplicateStart)))
      .toThrow(/started more than once/i);

    const badCumulative = completedLiveReportFixture();
    badCumulative.spendLedger.entries.at(-1)!.cumulativeAccountedCostUsd += 0.01;
    expect(() => compileDirectorBakeoffDecisionEvidence(JSON.stringify(badCumulative)))
      .toThrow(/accounted-cost cumulative/i);
  });

  it('rejects a ledger event mixed in from another run', () => {
    const report = completedLiveReportFixture();
    report.spendLedger.entries[3].runId = 'another-evaluation-run';
    expect(() => compileDirectorBakeoffDecisionEvidence(JSON.stringify(report)))
      .toThrow(/different run/i);
  });

  it('rejects authorization accounting that cannot reproduce or crosses the session cap', () => {
    const arithmeticMismatch = completedLiveReportFixture();
    arithmeticMismatch.authorizationLedger.combinedMaximumUsd -= 0.01;
    expect(() => compileDirectorBakeoffDecisionEvidence(JSON.stringify(arithmeticMismatch)))
      .toThrow(/combined maximum does not reproduce/i);

    const capExceeded = completedLiveReportFixture();
    capExceeded.authorizationLedger.priorReservedUsd = 0.28;
    capExceeded.authorizationLedger.combinedMaximumUsd = 30.01;
    expect(() => compileDirectorBakeoffDecisionEvidence(JSON.stringify(capExceeded)))
      .toThrow(/exceeds the session hard cap/i);
  });

  it('reconciles composition ledger costs with raw trial costs', () => {
    const report = completedLiveReportFixture();
    report.trials[0].costUsd -= 0.000001;
    expect(() => compileDirectorBakeoffDecisionEvidence(JSON.stringify(report)))
      .toThrow(/composition observed cost does not reconcile/i);
  });
});

function completedLiveReportFixture() {
  const offline = runOfflineDirectorEval();
  const trials: DirectorEvalTrial[] = offline.trials.map((trial) => {
    const modelUsage = trial.modelUsage.map((usage) => ({ ...usage }));
    const totals = modelUsage.reduce((result, usage) => ({
      inputTokens: result.inputTokens + usage.inputTokens,
      cachedInputTokens: result.cachedInputTokens + usage.cachedInputTokens,
      cacheWriteTokens: result.cacheWriteTokens + usage.cacheWriteTokens,
      outputTokens: result.outputTokens + usage.outputTokens,
    }), { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
    const costUsd = Math.round(trial.costUsd * 0.35 * 1e8) / 1e8;
    return {
      ...trial,
      ...totals,
      modelUsage,
      costUsd,
      costUpperBoundUsd: costUsd,
      rasterHashes: trial.qualityEvidenceComplete ? ['a'.repeat(64)] : [],
    };
  });
  const rowsPerCondition = trials.length / DIRECTOR_EVAL_CONDITIONS.length;
  const conditionSummaries = summarizeConditions(trials, rowsPerCondition);
  const compositionDecision = {
    status: 'authorized_live_evidence' as const,
    ...chooseCompositionWinner(conditionSummaries),
  };
  const defects = loadSeededDefects();
  const visionTrials = defects.flatMap((defect) =>
    (['defect', 'clean_control'] as const).flatMap((sample) =>
      (['terra-low', 'luna-low'] as const).map((conditionId) => {
        const rejected = sample === 'defect';
        return {
          defectId: defect.id,
          defectKind: defect.defectKind,
          sample,
          conditionId,
          latencyMs: conditionId === 'terra-low' ? 2_000 : 1_000,
          expectedReject: sample === 'defect',
          rejected,
          caught: sample === 'defect' && rejected,
          falseRejected: sample === 'clean_control' && rejected,
          validReply: true,
          costUsd: conditionId === 'terra-low' ? 0.001 : 0.0001,
        };
      })));
  const visionCandidates = [
    {
      conditionId: 'terra-low' as const,
      model: 'gpt-5.6-terra' as const,
      catchRate: 1,
      falseRejectRate: 0,
      invalidReplyRate: 0,
      p50LatencyMs: 2_000,
      p95LatencyMs: 2_000,
      costUsd: 0.024,
    },
    {
      conditionId: 'luna-low' as const,
      model: 'gpt-5.6-luna' as const,
      catchRate: 1,
      falseRejectRate: 0,
      invalidReplyRate: 0,
      p50LatencyMs: 1_000,
      p95LatencyMs: 1_000,
      costUsd: 0.0024,
    },
  ];
  const visionDecision = chooseVisionAuditDecision(visionCandidates);
  const sketches = materializeSketchCorpus();
  const sketchRows = sketches.flatMap((sketch) => ([
    {
      sketchId: sketch.id,
      conditionId: 'terra-low' as const,
      interpretation: sketch.expectedInterpretation,
      confidence: 0.9,
      validReply: true,
      correct: true,
      costUsd: 0.0001,
    },
    {
      sketchId: sketch.id,
      conditionId: 'luna-low' as const,
      interpretation: sketch.expectedInterpretation,
      confidence: 0.8,
      validReply: true,
      correct: true,
      costUsd: 0.00001,
    },
  ]));
  const corpus = loadDirectorEvalCorpus();
  const sampled = trials.filter((trial) => trial.qualitySampled);
  const spendLedger = completedSpendLedger({ trials, visionTrials, sketchRows });
  return {
    schemaVersion: '1.0.0' as const,
    pass: true as const,
    evidenceMode: 'authorized_live_synthetic' as const,
    evidenceBoundary: 'Synthetic checked-in intents and synthetic board/sketch rasters only; no child data. Provider latency and output quality are live for this run; browser validation is the configured local board harness.',
    realChildData: false as const,
    providerCalls: spendLedger.providerCalls,
    transportRetryProviderCalls: 0,
    judgeInvalidResponseRetries: 0,
    estimatedCostUsd: spendLedger.observedCostUsd,
    accountedCostUsd: spendLedger.accountedCostUsd,
    maxSpendUsd: spendLedger.maxSpendUsd,
    costSource: 'official rate-card estimate from provider token usage; cache writes are 1.25x and aborted legs without final usage are charged their conservative reservation',
    pricingSource: 'https://developers.openai.com/api/docs/models/compare (checked 2026-08-30)',
    stoppedEarly: null,
    conservativePlanFitsRunCap: false,
    resumedEvidence: null,
    authorizationLedger: {
      sessionHardCapUsd: 30 as const,
      priorReservedUsd: 0.26,
      runMaxSpendUsd: spendLedger.maxSpendUsd,
      combinedMaximumUsd: Math.round((0.26 + spendLedger.maxSpendUsd) * 1e10) / 1e10,
    },
    spendLedger,
    budgetPlan: plannedLiveBudget({
      intentCount: corpus.length,
      judgedIntentCount: loadDirectorQualitySampleIntentIds().length,
      trialsPerCacheState: 5,
      judgedTrialsPerCacheState: 1,
      judgedCacheStateCount: 1,
      conditions: DIRECTOR_EVAL_CONDITIONS,
      defectCount: defects.length,
      sketchCount: sketches.length,
      contextRasterIntentCount: corpus.filter((intent) => (intent.existingBoardOps?.length ?? 0) > 0).length,
    }),
    cacheEvidenceComplete: true as const,
    qualityEvidenceComplete: true as const,
    qualitySample: {
      preregisteredTrial: 1 as const,
      cacheState: 'cold' as const,
      intentIds: loadDirectorQualitySampleIntentIds(),
      plannedRows: loadDirectorQualitySampleIntentIds().length * DIRECTOR_EVAL_CONDITIONS.length,
      observedRows: sampled.length,
      eligibleRows: sampled.filter((trial) => trial.validatorPassed).length,
      gradedRows: sampled.filter((trial) => trial.qualityEvidenceComplete).length,
    },
    corpus: { representative: 24 as const, holdout: 12 as const, total: 36 as const },
    conditions: DIRECTOR_EVAL_CONDITIONS,
    trials,
    conditionSummaries,
    compositionDecision,
    visionAudit: {
      seededDefectCount: defects.length,
      cleanControlCount: defects.length,
      deterministicCatchRate: 0,
      deterministicFalseRejectRate: 0,
      candidates: visionCandidates,
      trials: visionTrials,
      decision: visionDecision,
      auditBudgetMs: visionDecision.auditBudgetMs,
    },
    sketchGrounding: {
      itemCount: sketches.length,
      candidates: [
        { conditionId: 'terra-low' as const, accuracy: 1, brierScore: 0.01, invalidReplyRate: 0, costUsd: 0.003 },
        { conditionId: 'luna-low' as const, accuracy: 1, brierScore: 0.04, invalidReplyRate: 0, costUsd: 0.0003 },
      ],
      assistedAccuracy: 1,
      cheaperModelAssistGain: 0,
      significantGainThreshold: 0.05,
      pairedImprovementPValue: 1,
      statisticallySignificant: false,
      assistDecisionEligibleForCheckGrading: false as const,
      cheaperModelAssistDefault: 'off' as const,
      decisionReason: 'This synthetic corpus measures sketch interpretation, not semantic check grading; it cannot authorize a grading assist.',
      rows: sketchRows,
    },
    rasterRubric: rubric,
  };
}

function completedSpendLedger(input: {
  trials: DirectorEvalTrial[];
  visionTrials: Array<{ conditionId: 'terra-low' | 'luna-low'; costUsd: number }>;
  sketchRows: Array<{ conditionId: 'terra-low' | 'luna-low'; costUsd: number }>;
}) {
  const runId = 'decision-evidence-test-run';
  const ledger = new LiveSpendLedger(29.73, undefined, runId);
  const complete = (
    phase: 'warmup' | 'composition' | 'judge' | 'vision_audit' | 'sketch',
    models: Array<'gpt-5.6-terra' | 'gpt-5.6-luna'>,
    observedCostUsd: number,
    usage: Array<{
      model: 'gpt-5.6-terra' | 'gpt-5.6-luna';
      inputTokens: number;
      cachedInputTokens: number;
      cacheWriteTokens: number;
      outputTokens: number;
      usageComplete: boolean;
    }> = [],
  ) => {
    const upperBoundUsd = observedCostUsd;
    const callId = ledger.begin({
      phase,
      models,
      reserveUsd: Math.max(0.000001, upperBoundUsd),
    });
    ledger.noteProviderCalls(callId, models.length);
    ledger.complete(callId, { status: 'completed', observedCostUsd, upperBoundUsd, usage });
  };

  complete('warmup', ['gpt-5.6-terra'], 0.0001);
  complete('warmup', ['gpt-5.6-terra'], 0.0001);
  complete('warmup', ['gpt-5.6-luna'], 0.00001);
  complete('warmup', ['gpt-5.6-luna'], 0.00001);
  for (const trial of input.trials) {
    complete(
      'composition',
      trial.modelUsage.map((usage) => usage.model),
      trial.costUsd,
      trial.modelUsage,
    );
    if (trial.qualitySampled && trial.validatorPassed) {
      complete('judge', ['gpt-5.6-luna'], 0.0001);
    }
  }
  for (const trial of input.visionTrials) {
    complete(
      'vision_audit',
      [trial.conditionId === 'terra-low' ? 'gpt-5.6-terra' : 'gpt-5.6-luna'],
      trial.costUsd,
    );
  }
  for (const row of input.sketchRows) {
    complete(
      'sketch',
      [row.conditionId === 'terra-low' ? 'gpt-5.6-terra' : 'gpt-5.6-luna'],
      row.costUsd,
    );
  }
  return ledger.snapshot();
}
