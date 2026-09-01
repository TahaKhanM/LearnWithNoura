import rubric from './fixtures/director-raster-rubric.json' with { type: 'json' };
import { applyDirectorBoardPolicy, buildDirectedScene } from '../directorSchema.js';
import {
  DIRECTOR_EVAL_CONDITIONS,
  isDirectorQualitySampleIntent,
  loadDirectorEvalCorpus,
  loadSeededDefects,
  materializeSketchCorpus,
} from './corpus.js';
import { chooseCompositionWinner } from './decision.js';
import type {
  ConditionSummary,
  DirectorEvalConditionId,
  DirectorEvalIntent,
  DirectorEvalTrial,
} from './types.js';
import { parseVNextEvalDirectorProposal } from './vnextEvalSchema.js';
import { chooseVisionAuditDecision } from './liveStudies.js';

const TRIALS_PER_CACHE_STATE = 5;

const PROFILES: Record<DirectorEvalConditionId, {
  validity: number;
  ttftMs: number;
  firstValidOpMs: number;
  completeSceneMs: number;
  qualityGrade: number;
  costUsd: number;
}> = {
  'terra-low': { validity: 0.98, ttftMs: 5_900, firstValidOpMs: 7_000, completeSceneMs: 13_500, qualityGrade: 3.7, costUsd: 0.021 },
  'terra-med': { validity: 0.995, ttftMs: 8_100, firstValidOpMs: 10_500, completeSceneMs: 18_000, qualityGrade: 4.3, costUsd: 0.032 },
  'luna-low': { validity: 0.965, ttftMs: 5_100, firstValidOpMs: 6_000, completeSceneMs: 11_800, qualityGrade: 3.5, costUsd: 0.004 },
  'luna-med': { validity: 0.985, ttftMs: 6_900, firstValidOpMs: 8_000, completeSceneMs: 14_200, qualityGrade: 3.8, costUsd: 0.007 },
  'terra-low+luna-low': { validity: 0.985, ttftMs: 4_300, firstValidOpMs: 4_900, completeSceneMs: 12_600, qualityGrade: 3.6, costUsd: 0.026 },
};

export interface OfflineDirectorEvalReport {
  schemaVersion: '1.0.0';
  pass: boolean;
  evidenceMode: 'deterministic_offline_fixture';
  evidenceBoundary: string;
  realChildData: false;
  providerCalls: 0;
  runtimeCostUsd: 0;
  corpus: { representative: number; holdout: number; total: number };
  conditions: typeof DIRECTOR_EVAL_CONDITIONS;
  trials: DirectorEvalTrial[];
  conditionSummaries: ConditionSummary[];
  compositionDecision: ReturnType<typeof chooseCompositionWinner> & { status: 'offline_fixture_only' };
  visionAudit: ReturnType<typeof offlineVisionAudit>;
  sketchGrounding: ReturnType<typeof offlineSketchGrounding>;
  rasterRubric: typeof rubric;
}

export function runOfflineDirectorEval(): OfflineDirectorEvalReport {
  const corpus = loadDirectorEvalCorpus();
  const trials = corpus.flatMap((intent) => DIRECTOR_EVAL_CONDITIONS.flatMap((condition) =>
    (['cold', 'warm'] as const).flatMap((cacheState) =>
      Array.from({ length: TRIALS_PER_CACHE_STATE }, (_, trial) =>
        offlineTrial(intent, condition.id, cacheState, trial + 1)))));
  const conditionSummaries = DIRECTOR_EVAL_CONDITIONS.map((condition) => summarizeCondition(
    condition.id,
    trials.filter((trial) => trial.conditionId === condition.id),
  ));
  const representative = corpus.filter((entry) => entry.split === 'representative').length;
  const holdout = corpus.filter((entry) => entry.split === 'holdout').length;
  const pass = representative === 24 && holdout === 12 &&
    trials.length === corpus.length * DIRECTOR_EVAL_CONDITIONS.length * 2 * TRIALS_PER_CACHE_STATE &&
    trials.every((trial) => !trial.strictSchemaValid || (trial.validatorPassed && trial.storyboardCoverage));
  return {
    schemaVersion: '1.0.0',
    pass,
    evidenceMode: 'deterministic_offline_fixture',
    evidenceBoundary: 'Synthetic timings, scripted validity, production proposal/policy/scene validators, fixed blind-rubric fixture grades, and synthetic sketch vectors only; no provider latency or model-quality claim.',
    realChildData: false,
    providerCalls: 0,
    runtimeCostUsd: 0,
    corpus: { representative, holdout, total: corpus.length },
    conditions: DIRECTOR_EVAL_CONDITIONS,
    trials,
    conditionSummaries,
    compositionDecision: { status: 'offline_fixture_only', ...chooseCompositionWinner(conditionSummaries) },
    visionAudit: offlineVisionAudit(),
    sketchGrounding: offlineSketchGrounding(),
    rasterRubric: rubric,
  };
}

function offlineTrial(
  intent: DirectorEvalIntent,
  conditionId: DirectorEvalConditionId,
  cacheState: 'cold' | 'warm',
  trial: number,
): DirectorEvalTrial {
  const profile = PROFILES[conditionId];
  const condition = DIRECTOR_EVAL_CONDITIONS.find((candidate) => candidate.id === conditionId);
  if (!condition) throw new Error(`Unknown offline evaluation condition ${conditionId}.`);
  const seed = stableUnit(`${intent.id}:${conditionId}:${cacheState}:${trial}`);
  const strictSchemaValid = seed < profile.validity;
  const productionContract = strictSchemaValid
    ? validateFixtureProposal(intent)
    : { validatorPassed: false, storyboardCoverage: false, proposalText: '{"invalid":true}' };
  const cacheFactor = cacheState === 'warm' ? 0.88 : 1;
  const difficultyFactor = 1 + (intent.difficulty - 1) * 0.08;
  const jitter = 0.9 + stableUnit(`latency:${intent.id}:${conditionId}:${cacheState}:${trial}`) * 0.2;
  const latencyFactor = cacheFactor * difficultyFactor * jitter;
  const qualityJitter = (stableUnit(`quality:${intent.id}:${conditionId}:${trial}`) - 0.5) * 0.3;
  const qualitySampled = trial === 1 && cacheState === 'cold' &&
    isDirectorQualitySampleIntent(intent.id);
  const qualityEvidenceComplete = qualitySampled && productionContract.validatorPassed;
  return {
    intentId: intent.id,
    split: intent.split,
    conditionId,
    cacheState,
    trial,
    ttftMs: Math.round(profile.ttftMs * latencyFactor),
    firstValidOpMs: strictSchemaValid ? Math.round(profile.firstValidOpMs * latencyFactor) : null,
    firstStepStatus: strictSchemaValid ? 'valid' : 'invalid',
    completeSceneMs: Math.round(profile.completeSceneMs * latencyFactor),
    strictSchemaValid,
    validatorPassed: productionContract.validatorPassed,
    storyboardCoverage: productionContract.storyboardCoverage,
    qualitySampled,
    qualityGrade: qualityEvidenceComplete
      ? round(Math.max(1, Math.min(5, profile.qualityGrade - (intent.difficulty - 1) * 0.12 + qualityJitter)), 2)
      : null,
    qualityEvidenceComplete,
    cacheExpectationMet: true,
    inputTokens: cacheState === 'warm' ? 5_000 : 4_800,
    cachedInputTokens: cacheState === 'warm' ? 4_096 + Math.floor(seed * 512) : 0,
    cacheWriteTokens: cacheState === 'cold' ? 4_096 : 0,
    outputTokens: 600 + Math.floor(seed * 180),
    usageComplete: true,
    finishReason: 'stop',
    maxCompletionTokens: condition.legs[0].maxCompletionTokens,
    selectedLegIndex: 0,
    modelUsage: condition.legs
      .map((leg) => ({
        model: leg.model,
        inputTokens: cacheState === 'warm' ? 5_000 : 4_800,
        cachedInputTokens: cacheState === 'warm' ? 4_096 + Math.floor(seed * 512) : 0,
        cacheWriteTokens: cacheState === 'cold' ? 4_096 : 0,
        outputTokens: 600 + Math.floor(seed * 180),
        usageComplete: true,
        finishReason: 'stop' as const,
        maxCompletionTokens: leg.maxCompletionTokens,
      })),
    costUsd: round(profile.costUsd * (0.94 + seed * 0.12), 6),
    costUpperBoundUsd: round(profile.costUsd * (0.94 + seed * 0.12), 6),
    proposalText: productionContract.proposalText,
    validationReasons: [],
    judgeReasons: qualityEvidenceComplete ? ['Fixed offline blind-rubric fixture grade.'] : [],
    rasterHashes: [],
  };
}

function validateFixtureProposal(intent: DirectorEvalIntent): { validatorPassed: boolean; storyboardCoverage: boolean; proposalText: string } {
  let proposalText = '';
  try {
    const objectId = `eval-${intent.id}`.replace(/[^a-z0-9_-]/gi, '-').slice(0, 40);
    proposalText = JSON.stringify({
      template: null,
      groupLabel: intent.intent.slice(0, 80),
      representation: 'diagram',
      illustration: null,
      steps: [{
        id: `${objectId}-step`,
        reveal: 'outline',
        narration: intent.purpose.slice(0, 200),
        ops: [{ op: 'add', id: objectId, color: 'blue', spec: { kind: 'box', at: [500, 300], w: 520, h: 180, text: intent.purpose.slice(0, 100) } }],
      }],
    });
    const proposal = parseVNextEvalDirectorProposal(proposalText, intent.density);
    const visibleObjectIds = (intent.existingBoardOps ?? []).flatMap((op) => op.op === 'add' ? [op.id] : []);
    const policy = applyDirectorBoardPolicy(proposal.ops, { density: intent.density, visibleObjectIds });
    if (!policy.ok) return { validatorPassed: false, storyboardCoverage: false, proposalText };
    const scene = buildDirectedScene({
      groupId: `group-${intent.id}`.replace(/[^a-z0-9_-]/gi, '-').slice(0, 80),
      groupLabel: proposal.groupLabel,
      ops: policy.ops,
      storyboard: proposal.storyboard,
    });
    return { validatorPassed: true, storyboardCoverage: scene.storyboard[0]?.objectIds[0] === objectId, proposalText };
  } catch {
    return { validatorPassed: false, storyboardCoverage: false, proposalText };
  }
}

function summarizeCondition(conditionId: DirectorEvalConditionId, trials: DirectorEvalTrial[]): ConditionSummary {
  const valid = trials.filter((trial) => trial.firstStepStatus === 'valid' && trial.strictSchemaValid && trial.validatorPassed && trial.storyboardCoverage);
  const qualityGrades = valid.flatMap((trial) =>
    trial.qualitySampled && trial.qualityEvidenceComplete && trial.qualityGrade !== null
      ? [trial.qualityGrade]
      : []);
  return {
    conditionId,
    firstPassValidity: round(valid.length / trials.length, 4),
    qualityGrade: round(mean(qualityGrades), 2),
    p50FirstValidOpMs: percentile(valid.flatMap((trial) => trial.firstValidOpMs === null ? [] : [trial.firstValidOpMs]), 0.5),
    meanCostUsd: round(mean(trials.map((trial) => trial.costUsd)), 6),
    p50TtftMs: percentile(valid.map((trial) => trial.ttftMs), 0.5),
    p50CompleteSceneMs: percentile(valid.map((trial) => trial.completeSceneMs), 0.5),
    strictSchemaValidity: round(trials.filter((trial) => trial.strictSchemaValid).length / trials.length, 4),
    validatorPassRate: round(trials.filter((trial) => trial.validatorPassed).length / trials.length, 4),
    storyboardCoverageRate: round(trials.filter((trial) => trial.storyboardCoverage).length / trials.length, 4),
    meanCostUpperBoundUsd: round(mean(trials.map((trial) => trial.costUpperBoundUsd)), 6),
  };
}

function offlineVisionAudit() {
  const defects = loadSeededDefects();
  const candidates = [
    { conditionId: 'terra-low', model: 'gpt-5.6-terra' as const, caught: defects.length - 1, falseRejectRate: 0.0833, invalidReplyRate: 0, p50LatencyMs: 2_200, p95LatencyMs: 3_180, costUsd: 0.2 },
    { conditionId: 'luna-low', model: 'gpt-5.6-luna' as const, caught: defects.length - 2, falseRejectRate: 0, invalidReplyRate: 0, p50LatencyMs: 1_420, p95LatencyMs: 2_960, costUsd: 0.04 },
  ].map((entry) => ({ ...entry, catchRate: round(entry.caught / defects.length, 4) }));
  const decision = chooseVisionAuditDecision(candidates);
  return {
    evidenceMode: 'scripted_seeded_defects' as const,
    seededDefectCount: defects.length,
    defectKinds: [...new Set(defects.map((entry) => entry.defectKind))],
    deterministicCatchRate: 0,
    deterministicFalseRejectRate: 0,
    candidates,
    decision,
    revealGateDraft: {
      auditBudgetMs: decision.auditBudgetMs,
      rule: 'Step 1 waits up to the budget; timeout releases on deterministic checks and gates step 2; hard rejection abandons only unrevealed work.',
    },
  };
}

function offlineSketchGrounding() {
  const sketches = materializeSketchCorpus();
  return {
    evidenceMode: 'synthetic_board_vectors' as const,
    itemCount: sketches.length,
    candidates: [
      { conditionId: 'terra-low', accuracy: 0.9, expectedCalibrationError: 0.07 },
      { conditionId: 'terra-low+luna-low-assist', accuracy: 0.93, expectedCalibrationError: 0.06 },
    ],
    cheaperModelAssistGain: 0.03,
    significantGainThreshold: 0.05,
    cheaperModelAssistDefault: 'off' as const,
  };
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))];
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stableUnit(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
