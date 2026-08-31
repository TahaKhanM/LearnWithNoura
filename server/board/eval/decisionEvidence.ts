import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import rubric from './fixtures/director-raster-rubric.json' with { type: 'json' };
import {
  DIRECTOR_MIN_WARM_CACHED_INPUT_TOKENS,
  plannedLiveBudget,
} from './budget.js';
import {
  DIRECTOR_EVAL_CONDITIONS,
  isDirectorQualitySampleIntent,
  loadDirectorEvalCorpus,
  loadDirectorQualitySampleIntentIds,
  loadSeededDefects,
  materializeSketchCorpus,
} from './corpus.js';
import { chooseCompositionWinner } from './decision.js';
import {
  cacheEvidenceSufficient,
  conditionDominatingByMoreThan2x,
  summarizeConditions,
  trialHitOutputCeiling,
} from './liveDirectorEval.js';
import {
  chooseVisionAuditDecision,
  pairedAssistDecision,
  type VisionAuditCandidateSummary,
} from './liveStudies.js';
import type { ConditionSummary, DirectorEvalTrial } from './types.js';
import { directorTrialKey, type DirectorResumeEvidenceMetadata } from './resumeEvidence.js';

const ConditionIdSchema = z.enum([
  'terra-low',
  'terra-med',
  'luna-low',
  'luna-med',
  'terra-low+luna-low',
]);
const AuditConditionIdSchema = z.enum(['terra-low', 'luna-low']);
const TextModelSchema = z.enum(['gpt-5.6-terra', 'gpt-5.6-luna']);
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const NonNegativeNumberSchema = z.number().nonnegative();
const RateSchema = z.number().min(0).max(1);
const FinishReasonSchema = z.enum(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']).nullable();
const SpendRunIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const LIVE_EVIDENCE_BOUNDARY = 'Synthetic checked-in intents and synthetic board/sketch rasters only; no child data. Provider latency and output quality are live for this run; browser validation is the configured local board harness.';
const LIVE_COST_SOURCE = 'official rate-card estimate from provider token usage; cache writes are 1.25x and aborted legs without final usage are charged their conservative reservation';
const LIVE_PRICING_SOURCE = 'https://developers.openai.com/api/docs/models/compare (checked 2026-08-30)';
const SKETCH_DECISION_REASON = 'This synthetic corpus measures sketch interpretation, not semantic check grading; it cannot authorize a grading assist.';

const ModelUsageSchema = z.object({
  model: TextModelSchema,
  inputTokens: NonNegativeIntegerSchema,
  cachedInputTokens: NonNegativeIntegerSchema,
  cacheWriteTokens: NonNegativeIntegerSchema,
  outputTokens: NonNegativeIntegerSchema,
  usageComplete: z.boolean(),
  finishReason: FinishReasonSchema,
  maxCompletionTokens: z.number().int().positive(),
}).strict();

const DirectorEvalTrialSchema = z.object({
  intentId: z.string().min(1).max(80),
  split: z.enum(['representative', 'holdout']),
  conditionId: ConditionIdSchema,
  cacheState: z.enum(['cold', 'warm']),
  trial: z.number().int().min(1).max(5),
  ttftMs: NonNegativeIntegerSchema,
  firstValidOpMs: NonNegativeIntegerSchema.nullable(),
  firstStepStatus: z.enum(['valid', 'invalid', 'missing']),
  completeSceneMs: NonNegativeIntegerSchema,
  strictSchemaValid: z.boolean(),
  validatorPassed: z.boolean(),
  storyboardCoverage: z.boolean(),
  qualitySampled: z.boolean(),
  qualityGrade: z.number().min(1).max(5).nullable(),
  qualityEvidenceComplete: z.boolean(),
  cacheExpectationMet: z.boolean(),
  inputTokens: NonNegativeIntegerSchema,
  cachedInputTokens: NonNegativeIntegerSchema,
  cacheWriteTokens: NonNegativeIntegerSchema,
  outputTokens: NonNegativeIntegerSchema,
  usageComplete: z.boolean(),
  finishReason: FinishReasonSchema,
  maxCompletionTokens: z.number().int().positive(),
  selectedLegIndex: NonNegativeIntegerSchema,
  modelUsage: z.array(ModelUsageSchema).min(1).max(2),
  costUsd: NonNegativeNumberSchema,
  costUpperBoundUsd: NonNegativeNumberSchema,
  proposalText: z.string(),
  validationReasons: z.array(z.string()),
  judgeReasons: z.array(z.string()),
  rasterHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
}).strict();

const ConditionSummarySchema = z.object({
  conditionId: ConditionIdSchema,
  firstPassValidity: RateSchema,
  qualityGrade: z.number().min(0).max(5),
  p50FirstValidOpMs: NonNegativeIntegerSchema,
  meanCostUsd: NonNegativeNumberSchema,
  p50TtftMs: NonNegativeIntegerSchema,
  p50CompleteSceneMs: NonNegativeIntegerSchema,
  strictSchemaValidity: RateSchema,
  validatorPassRate: RateSchema,
  storyboardCoverageRate: RateSchema,
  meanCostUpperBoundUsd: NonNegativeNumberSchema,
}).strict();

const CompositionDecisionSchema = z.object({
  status: z.literal('authorized_live_evidence'),
  winnerConditionId: ConditionIdSchema.nullable(),
  hedgeAdopted: z.boolean(),
  eligibleConditionIds: z.array(ConditionIdSchema),
  reasons: z.array(z.string().min(1)),
}).strict();

const VisionCandidateSchema = z.object({
  conditionId: AuditConditionIdSchema,
  model: TextModelSchema,
  catchRate: RateSchema,
  falseRejectRate: RateSchema,
  invalidReplyRate: RateSchema,
  p50LatencyMs: NonNegativeIntegerSchema,
  p95LatencyMs: NonNegativeIntegerSchema,
  costUsd: NonNegativeNumberSchema,
}).strict();

const VisionTrialSchema = z.object({
  defectId: z.string().min(1).max(80),
  defectKind: z.enum(['wrong_shading', 'mislabeled_value', 'reversed_arrow']),
  sample: z.enum(['defect', 'clean_control']),
  conditionId: AuditConditionIdSchema,
  latencyMs: NonNegativeIntegerSchema,
  expectedReject: z.boolean(),
  rejected: z.boolean(),
  caught: z.boolean(),
  falseRejected: z.boolean(),
  validReply: z.boolean(),
  costUsd: NonNegativeNumberSchema,
}).strict();

const VisionDecisionSchema = z.object({
  selectedConditionId: AuditConditionIdSchema.nullable(),
  selectedModel: TextModelSchema.nullable(),
  auditBudgetMs: NonNegativeIntegerSchema,
  revealGate: z.enum(['step1_budgeted', 'deterministic_only']),
  minimumCatchRate: RateSchema,
  maximumFalseRejectRate: RateSchema,
  maximumInvalidReplyRate: RateSchema,
  reason: z.string().min(1),
}).strict();

const VisionAuditSchema = z.object({
  seededDefectCount: NonNegativeIntegerSchema,
  cleanControlCount: NonNegativeIntegerSchema,
  deterministicCatchRate: RateSchema,
  deterministicFalseRejectRate: RateSchema,
  candidates: z.array(VisionCandidateSchema),
  trials: z.array(VisionTrialSchema),
  decision: VisionDecisionSchema,
  auditBudgetMs: NonNegativeIntegerSchema,
}).strict();

const SketchCandidateSchema = z.object({
  conditionId: AuditConditionIdSchema,
  accuracy: RateSchema,
  brierScore: RateSchema,
  invalidReplyRate: RateSchema,
  costUsd: NonNegativeNumberSchema,
}).strict();

const SketchRowSchema = z.object({
  sketchId: z.string().min(1),
  conditionId: AuditConditionIdSchema,
  interpretation: z.string().max(120),
  confidence: RateSchema,
  validReply: z.boolean(),
  correct: z.boolean(),
  costUsd: NonNegativeNumberSchema,
}).strict();

const SketchGroundingSchema = z.object({
  itemCount: NonNegativeIntegerSchema,
  candidates: z.array(SketchCandidateSchema),
  assistedAccuracy: RateSchema,
  cheaperModelAssistGain: z.number().min(-1).max(1),
  significantGainThreshold: RateSchema,
  pairedImprovementPValue: RateSchema,
  statisticallySignificant: z.boolean(),
  assistDecisionEligibleForCheckGrading: z.literal(false),
  cheaperModelAssistDefault: z.literal('off'),
  decisionReason: z.literal(SKETCH_DECISION_REASON),
  rows: z.array(SketchRowSchema),
}).strict();

const ConditionSchema = z.object({
  id: ConditionIdSchema,
  legs: z.array(z.object({
    model: TextModelSchema,
    reasoningEffort: z.enum(['low', 'medium']),
    maxCompletionTokens: z.number().int().positive(),
  }).strict()).min(1).max(2),
}).strict();

const BudgetPlanSchema = z.object({
  compositionCalls: NonNegativeIntegerSchema,
  judgeCalls: NonNegativeIntegerSchema,
  visionAuditCalls: NonNegativeIntegerSchema,
  sketchCalls: NonNegativeIntegerSchema,
  compositionLegCounts: z.object({
    'gpt-5.6-terra': z.object({ cold: NonNegativeIntegerSchema, warm: NonNegativeIntegerSchema }).strict(),
    'gpt-5.6-luna': z.object({ cold: NonNegativeIntegerSchema, warm: NonNegativeIntegerSchema }).strict(),
  }).strict(),
  componentsUsd: z.object({
    warmup: NonNegativeNumberSchema,
    composition: NonNegativeNumberSchema,
    judging: NonNegativeNumberSchema,
    visionAudit: NonNegativeNumberSchema,
    sketch: NonNegativeNumberSchema,
    hedgeWarmAbort: NonNegativeNumberSchema,
    cacheMissContingency: NonNegativeNumberSchema,
  }).strict(),
  conservativeTotalUsd: NonNegativeNumberSchema,
}).strict();

const SpendUsageEvidenceSchema = z.object({
  model: TextModelSchema,
  inputTokens: NonNegativeIntegerSchema,
  cachedInputTokens: NonNegativeIntegerSchema,
  cacheWriteTokens: NonNegativeIntegerSchema,
  outputTokens: NonNegativeIntegerSchema,
  usageComplete: z.boolean(),
}).strict();

const SpendLedgerEventSchema = z.object({
  sequence: z.number().int().positive(),
  runId: SpendRunIdSchema,
  callId: z.string().min(1).max(260),
  status: z.enum(['reserved', 'started', 'completed', 'failed']),
  phase: z.enum(['warmup', 'composition', 'judge', 'vision_audit', 'sketch']),
  models: z.array(TextModelSchema).min(1).max(2),
  reserveUsd: z.number().positive(),
  providerCallCount: NonNegativeIntegerSchema,
  observedCostUsd: NonNegativeNumberSchema,
  upperBoundUsd: NonNegativeNumberSchema,
  usage: z.array(SpendUsageEvidenceSchema).max(2),
  cumulativeProviderCalls: NonNegativeIntegerSchema,
  cumulativeObservedCostUsd: NonNegativeNumberSchema,
  cumulativeAccountedCostUsd: NonNegativeNumberSchema,
  openReservationUsd: NonNegativeNumberSchema,
}).strict();

const SpendLedgerSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  runId: SpendRunIdSchema,
  maxSpendUsd: z.number().positive().max(30),
  providerCalls: NonNegativeIntegerSchema,
  observedCostUsd: NonNegativeNumberSchema,
  accountedCostUsd: NonNegativeNumberSchema,
  openReservationUsd: NonNegativeNumberSchema,
  entries: z.array(SpendLedgerEventSchema).min(1),
}).strict();

const AuthorizationLedgerSchema = z.object({
  sessionHardCapUsd: z.literal(30),
  priorReservedUsd: NonNegativeNumberSchema,
  runMaxSpendUsd: NonNegativeNumberSchema,
  combinedMaximumUsd: NonNegativeNumberSchema,
}).strict();

const ResumedEvidenceSchema = z.object({
  sourcePath: z.string().min(1),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRunId: SpendRunIdSchema,
  sourceLiabilityUsd: NonNegativeNumberSchema,
  retainedTrialCount: NonNegativeIntegerSchema,
  discardedTrialCount: NonNegativeIntegerSchema,
  retainedTrialKeys: z.array(z.string().min(1)),
}).strict();

const CompletedLiveReportSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  pass: z.literal(true),
  evidenceMode: z.literal('authorized_live_synthetic'),
  evidenceBoundary: z.literal(LIVE_EVIDENCE_BOUNDARY),
  realChildData: z.literal(false),
  providerCalls: z.number().int().positive(),
  transportRetryProviderCalls: NonNegativeIntegerSchema,
  judgeInvalidResponseRetries: NonNegativeIntegerSchema,
  estimatedCostUsd: NonNegativeNumberSchema,
  accountedCostUsd: NonNegativeNumberSchema,
  maxSpendUsd: z.number().positive().max(30),
  costSource: z.literal(LIVE_COST_SOURCE),
  pricingSource: z.literal(LIVE_PRICING_SOURCE),
  stoppedEarly: z.string().nullable(),
  conservativePlanFitsRunCap: z.boolean(),
  resumedEvidence: z.array(ResumedEvidenceSchema).min(1).nullable(),
  authorizationLedger: AuthorizationLedgerSchema,
  spendLedger: SpendLedgerSchema,
  budgetPlan: BudgetPlanSchema,
  cacheEvidenceComplete: z.literal(true),
  qualityEvidenceComplete: z.literal(true),
  qualitySample: z.object({
    preregisteredTrial: z.literal(1),
    cacheState: z.literal('cold'),
    intentIds: z.array(z.string().min(1).max(80)).length(25),
    plannedRows: NonNegativeIntegerSchema,
    observedRows: NonNegativeIntegerSchema,
    eligibleRows: NonNegativeIntegerSchema,
    gradedRows: NonNegativeIntegerSchema,
  }).strict(),
  corpus: z.object({
    representative: z.literal(24),
    holdout: z.literal(12),
    total: z.literal(36),
  }).strict(),
  conditions: z.array(ConditionSchema),
  trials: z.array(DirectorEvalTrialSchema).min(1),
  conditionSummaries: z.array(ConditionSummarySchema),
  compositionDecision: CompositionDecisionSchema,
  visionAudit: VisionAuditSchema,
  sketchGrounding: SketchGroundingSchema,
  rasterRubric: z.record(z.string(), z.unknown()),
}).strict();

type CompletedLiveReport = z.infer<typeof CompletedLiveReportSchema>;

export interface DirectorBakeoffDecisionEvidence {
  rawEvidencePath: string | null;
  rawEvidenceSha256: string;
  trialRounds: number;
  report: {
    schemaVersion: '1.0.0';
    evidenceMode: 'authorized_live_synthetic';
    providerCalls: number;
    transportRetryProviderCalls: number;
    judgeInvalidResponseRetries: number;
    estimatedCostUsd: number;
    accountedCostUsd: number;
    maxSpendUsd: number;
    stoppedEarly: string | null;
    conservativePlanFitsRunCap: boolean;
    resumedEvidence: DirectorResumeEvidenceMetadata[] | null;
    representativeIntents: 24;
    holdoutIntents: 12;
    qualitySample: {
      preregisteredTrial: 1;
      cacheState: 'cold';
      intentIds: string[];
      plannedRows: number;
      observedRows: number;
      eligibleRows: number;
      gradedRows: number;
    };
    authorizationLedger: {
      sessionHardCapUsd: 30;
      priorReservedUsd: number;
      runMaxSpendUsd: number;
      combinedMaximumUsd: number;
    };
    spendLedger: {
      schemaVersion: '1.0.0';
      runId: string;
      entryCount: number;
      logicalCallCount: number;
      providerCalls: number;
      observedCostUsd: number;
      accountedCostUsd: number;
      openReservationUsd: 0;
    };
  };
  composition: {
    winnerConditionId: string | null;
    hedgeAdopted: boolean;
    eligibleConditionIds: string[];
    reasons: string[];
    conditions: ConditionSummary[];
  };
  cache: Array<{
    conditionId: string;
    cacheState: 'cold' | 'warm';
    trials: number;
    expectationPassRate: number;
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
  }>;
  visionAudit: {
    seededDefectCount: number;
    cleanControlCount: number;
    deterministicCatchRate: number;
    deterministicFalseRejectRate: number;
    selectedConditionId: string | null;
    selectedModel: string | null;
    auditBudgetMs: number;
    revealGate: 'step1_budgeted' | 'deterministic_only';
    candidates: VisionAuditCandidateSummary[];
    reason: string;
  };
  sketchGrounding: {
    candidates: Array<{
      conditionId: string;
      accuracy: number;
      brierScore: number;
      invalidReplyRate: number;
      costUsd: number;
    }>;
    assistedAccuracy: number;
    cheaperModelAssistGain: number;
    pairedImprovementPValue: number;
    statisticallySignificant: boolean;
    assistDecisionEligibleForCheckGrading: false;
    cheaperModelAssistDefault: 'off';
    decisionReason: string;
  };
  markdown: string;
}

/**
 * Converts the exact completed M0 raw JSON into independently checked,
 * copy-ready decision evidence. It deliberately rejects offline, partial,
 * failed, unbalanced, stale-decision, or policy-inconsistent reports.
 */
export function compileDirectorBakeoffDecisionEvidence(
  rawJson: string,
  options: { rawEvidencePath?: string } = {},
): DirectorBakeoffDecisionEvidence {
  const rawEvidenceSha256 = createHash('sha256').update(rawJson).digest('hex');
  let unknownReport: unknown;
  try {
    unknownReport = JSON.parse(rawJson);
  } catch {
    throw new DecisionEvidenceError('Raw evidence is not valid JSON.');
  }
  const parsed = CompletedLiveReportSchema.safeParse(unknownReport);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new DecisionEvidenceError(`Raw evidence is not a completed passing live report: ${issues}`);
  }
  const report = parsed.data;
  const resumedTrialKeys = verifyResumedEvidence(report);
  const trialRounds = verifyCompositionEvidence(report);
  const visionCandidates = verifyVisionEvidence(report);
  const sketchCandidates = verifySketchEvidence(report);
  verifyAuthorizationLedger(report);
  const reconstructedLedger = verifySpendLedger(report);
  verifyStudyBudget(report, reconstructedLedger, resumedTrialKeys);

  const winnerConditionId = report.compositionDecision.winnerConditionId;
  const cache = summarizeCacheEvidence(report.trials);
  const evidence: Omit<DirectorBakeoffDecisionEvidence, 'markdown'> = {
    rawEvidencePath: options.rawEvidencePath ?? null,
    rawEvidenceSha256,
    trialRounds,
    report: {
      schemaVersion: report.schemaVersion,
      evidenceMode: report.evidenceMode,
      providerCalls: report.providerCalls,
      transportRetryProviderCalls: report.transportRetryProviderCalls,
      judgeInvalidResponseRetries: report.judgeInvalidResponseRetries,
      estimatedCostUsd: report.estimatedCostUsd,
      accountedCostUsd: report.accountedCostUsd,
      maxSpendUsd: report.maxSpendUsd,
      stoppedEarly: report.stoppedEarly,
      conservativePlanFitsRunCap: report.conservativePlanFitsRunCap,
      resumedEvidence: report.resumedEvidence,
      representativeIntents: report.corpus.representative,
      holdoutIntents: report.corpus.holdout,
      qualitySample: report.qualitySample,
      authorizationLedger: report.authorizationLedger,
      spendLedger: {
        schemaVersion: report.spendLedger.schemaVersion,
        runId: report.spendLedger.runId,
        entryCount: report.spendLedger.entries.length,
        logicalCallCount: reconstructedLedger.logicalCallCount,
        providerCalls: report.spendLedger.providerCalls,
        observedCostUsd: report.spendLedger.observedCostUsd,
        accountedCostUsd: report.spendLedger.accountedCostUsd,
        openReservationUsd: 0,
      },
    },
    composition: {
      winnerConditionId,
      hedgeAdopted: report.compositionDecision.hedgeAdopted,
      eligibleConditionIds: report.compositionDecision.eligibleConditionIds,
      reasons: report.compositionDecision.reasons,
      conditions: report.conditionSummaries,
    },
    cache,
    visionAudit: {
      seededDefectCount: report.visionAudit.seededDefectCount,
      cleanControlCount: report.visionAudit.cleanControlCount,
      deterministicCatchRate: report.visionAudit.deterministicCatchRate,
      deterministicFalseRejectRate: report.visionAudit.deterministicFalseRejectRate,
      selectedConditionId: report.visionAudit.decision.selectedConditionId,
      selectedModel: report.visionAudit.decision.selectedModel,
      auditBudgetMs: report.visionAudit.auditBudgetMs,
      revealGate: report.visionAudit.decision.revealGate,
      candidates: visionCandidates,
      reason: report.visionAudit.decision.reason,
    },
    sketchGrounding: {
      candidates: sketchCandidates,
      assistedAccuracy: report.sketchGrounding.assistedAccuracy,
      cheaperModelAssistGain: report.sketchGrounding.cheaperModelAssistGain,
      pairedImprovementPValue: report.sketchGrounding.pairedImprovementPValue,
      statisticallySignificant: report.sketchGrounding.statisticallySignificant,
      assistDecisionEligibleForCheckGrading: false,
      cheaperModelAssistDefault: 'off',
      decisionReason: report.sketchGrounding.decisionReason,
    },
  };
  return { ...evidence, markdown: renderDecisionMarkdown(evidence) };
}

export class DecisionEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionEvidenceError';
  }
}

function verifyResumedEvidence(report: CompletedLiveReport): Set<string> {
  if (!report.resumedEvidence) return new Set();
  const allRetainedKeys = new Set<string>();
  const reportByKey = new Map(report.trials.map((trial) => [directorTrialKey(trial), trial]));
  for (const metadata of report.resumedEvidence) {
    requireEvidence(
      /^server\/board\/eval\/results\/[a-zA-Z0-9._-]+\.ndjson$/.test(metadata.sourcePath),
      'Resume evidence path is outside the checked-in evaluation-results directory.',
    );
    const sourcePath = resolve(metadata.sourcePath);
    let raw: string;
    try { raw = readFileSync(sourcePath, 'utf8'); }
    catch { throw new DecisionEvidenceError(`Resume evidence source is unreadable: ${metadata.sourcePath}.`); }
    requireEvidence(createHash('sha256').update(raw).digest('hex') === metadata.sourceSha256,
      'Resume evidence source hash does not match the completed report.');
    const records = raw.trimEnd().split('\n').map((line, index) => {
      try { return JSON.parse(line) as Record<string, unknown>; }
      catch { throw new DecisionEvidenceError(`Resume evidence has invalid NDJSON at line ${index + 1}.`); }
    });
    const header = records.find((record) => record.kind === 'run_started');
    requireEvidence(header?.runId === metadata.sourceRunId,
      'Resume evidence run identity does not match its source manifest.');
    const spendEvents = records.flatMap((record) =>
      record.kind === 'spend' ? [SpendLedgerEventSchema.parse(record.event)] : []);
    for (const [index, event] of spendEvents.entries()) {
      requireEvidence(event.sequence === index + 1 && event.runId === metadata.sourceRunId,
        `Resume evidence spend sequence is invalid at ${index + 1}.`);
    }
    const terminal = spendEvents.at(-1);
    requireEvidence(Boolean(terminal) && terminal?.openReservationUsd === 0,
      'Resume evidence source has an open provider reservation.');
    requireEvidence(
      money((terminal?.cumulativeAccountedCostUsd ?? 0) + (terminal?.openReservationUsd ?? 0)) ===
        metadata.sourceLiabilityUsd,
      'Resume evidence liability does not reproduce from its source ledger.',
    );
    const sourceTrials = records.flatMap((record) => {
      if (record.kind !== 'trial' || !record.checkpoint || typeof record.checkpoint !== 'object') return [];
      return [DirectorEvalTrialSchema.parse((record.checkpoint as { trial?: unknown }).trial)];
    });
    requireEvidence(
      metadata.retainedTrialCount + metadata.discardedTrialCount === sourceTrials.length,
      'Resume evidence retained/discarded counts do not match its source rows.',
    );
    const retainedKeys = new Set(metadata.retainedTrialKeys);
    requireEvidence(retainedKeys.size === metadata.retainedTrialCount,
      'Resume evidence retained keys are duplicated or miscounted.');
    const sourceByKey = new Map(sourceTrials.map((trial) => [directorTrialKey(trial), trial]));
    for (const key of retainedKeys) {
      requireEvidence(!allRetainedKeys.has(key), `Resume sources overlap on retained row ${key}.`);
      allRetainedKeys.add(key);
      requireEvidence(sourceByKey.has(key), `Resume evidence source is missing retained row ${key}.`);
      requireEvidence(
        isDeepStrictEqual(sourceByKey.get(key), reportByKey.get(key)),
        `Retained resume row ${key} differs from its hashed source.`,
      );
    }
  }
  return allRetainedKeys;
}

function verifyCompositionEvidence(report: CompletedLiveReport): number {
  requireEvidence(
    isDeepStrictEqual(report.conditions, DIRECTOR_EVAL_CONDITIONS),
    'The condition matrix differs from the pre-registered five conditions.',
  );
  requireEvidence(
    isDeepStrictEqual(report.rasterRubric, rubric),
    'The raster rubric differs from the checked-in blind rubric.',
  );
  const corpus = loadDirectorEvalCorpus();
  const intentById = new Map(corpus.map((intent) => [intent.id, intent]));
  const conditionById = new Map(DIRECTOR_EVAL_CONDITIONS.map((condition) => [condition.id, condition]));
  const trialNumbers = new Set<number>();
  const seen = new Set<string>();
  for (const trial of report.trials) {
    const intent = intentById.get(trial.intentId);
    requireEvidence(Boolean(intent), `Unknown composition intent ${trial.intentId}.`);
    requireEvidence(intent?.split === trial.split, `Split mismatch for composition intent ${trial.intentId}.`);
    const condition = conditionById.get(trial.conditionId);
    requireEvidence(Boolean(condition), `Unknown composition condition ${trial.conditionId}.`);
    const key = `${trial.intentId}:${trial.conditionId}:${trial.cacheState}:${trial.trial}`;
    requireEvidence(!seen.has(key), `Duplicate composition row ${key}.`);
    seen.add(key);
    trialNumbers.add(trial.trial);

    requireEvidence(trial.costUpperBoundUsd >= trial.costUsd, `Cost bound is below observed cost for ${key}.`);
    requireEvidence(
      (trial.firstStepStatus === 'valid') === (trial.firstValidOpMs !== null),
      `First-valid-op timing disagrees with first-step status for ${key}.`,
    );
    requireEvidence(trial.qualitySampled === (
      trial.trial === 1 && trial.cacheState === 'cold' && isDirectorQualitySampleIntent(trial.intentId)
    ),
      `Blind-quality sampling differs from pre-registered cold trial one for ${key}.`);
    if (trial.qualitySampled && trial.validatorPassed) {
      requireEvidence(
        trial.qualityEvidenceComplete && trial.qualityGrade !== null && trial.rasterHashes.length > 0,
        `Eligible sampled row lacks complete blind-raster evidence for ${key}.`,
      );
    } else {
      requireEvidence(
        !trial.qualityEvidenceComplete && trial.qualityGrade === null && trial.rasterHashes.length === 0,
        `Unsampled or ineligible row claims blind-raster evidence for ${key}.`,
      );
    }
    requireEvidence(
      trial.modelUsage.length === condition?.legs.length,
      `Model-usage leg count differs from condition ${trial.conditionId} for ${key}.`,
    );
    requireEvidence(
      trial.selectedLegIndex < trial.modelUsage.length,
      `Selected leg is out of range for ${key}.`,
    );
    for (let index = 0; index < trial.modelUsage.length; index += 1) {
      requireEvidence(
        trial.modelUsage[index]?.model === condition?.legs[index]?.model,
        `Model-usage order differs from condition ${trial.conditionId} for ${key}.`,
      );
      requireEvidence(
        trial.modelUsage[index]?.maxCompletionTokens === condition?.legs[index]?.maxCompletionTokens,
        `Model-usage output ceiling differs from condition ${trial.conditionId} for ${key}.`,
      );
      requireEvidence(
        !trial.modelUsage[index]?.usageComplete || trial.modelUsage[index]?.finishReason === 'stop',
        `Completed model leg has a non-stop finish reason for ${key}.`,
      );
    }
    const selectedUsage = trial.modelUsage[trial.selectedLegIndex];
    requireEvidence(Boolean(selectedUsage), `Selected usage is absent for ${key}.`);
    requireEvidence(trial.finishReason === selectedUsage?.finishReason,
      `Selected finish reason is inconsistent for ${key}.`);
    requireEvidence(trial.maxCompletionTokens === selectedUsage?.maxCompletionTokens,
      `Selected output ceiling is inconsistent for ${key}.`);
    requireEvidence(!trialHitOutputCeiling(trial),
      `Output-ceiling-censored evidence is present for ${key}.`);
    const cacheExpectationMet = trial.cacheState === 'warm'
      ? (selectedUsage?.cachedInputTokens ?? 0) >= DIRECTOR_MIN_WARM_CACHED_INPUT_TOKENS
      : (selectedUsage?.cachedInputTokens ?? 0) === 0;
    requireEvidence(
      trial.cacheExpectationMet === cacheExpectationMet,
      `Selected leg did not meet the ${trial.cacheState} cache expectation for ${key}.`,
    );
    requireEvidence(
      trial.usageComplete === trial.modelUsage.every((usage) => usage.usageComplete),
      `Aggregate usage-completeness flag is inconsistent for ${key}.`,
    );
    for (const field of ['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens'] as const) {
      const sum = trial.modelUsage.reduce((total, usage) => total + usage[field], 0);
      requireEvidence(trial[field] === sum, `Aggregate ${field} is inconsistent for ${key}.`);
    }
  }

  const trialRounds = Math.max(...trialNumbers);
  requireEvidence(
    isDeepStrictEqual([...trialNumbers].sort((left, right) => left - right),
      Array.from({ length: trialRounds }, (_, index) => index + 1)),
    'Composition trial numbers are not contiguous from one.',
  );
  if (report.stoppedEarly === null) {
    requireEvidence(trialRounds === 5, 'A non-early-stopped report must contain all five trials.');
  } else {
    const match = /^pre_registered_dominance:(.+)$/.exec(report.stoppedEarly);
    requireEvidence(Boolean(match), `Passing report has an unsupported early-stop reason: ${report.stoppedEarly}.`);
  }
  for (const intent of corpus) {
    for (const condition of DIRECTOR_EVAL_CONDITIONS) {
      for (const cacheState of ['cold', 'warm'] as const) {
        for (let trial = 1; trial <= trialRounds; trial += 1) {
          const key = `${intent.id}:${condition.id}:${cacheState}:${trial}`;
          requireEvidence(seen.has(key), `Composition matrix is missing ${key}.`);
        }
      }
    }
  }
  const expectedRowsPerCondition = corpus.length * 2 * trialRounds;
  requireEvidence(
    report.trials.length === expectedRowsPerCondition * DIRECTOR_EVAL_CONDITIONS.length,
    'Composition trial count does not match the balanced matrix.',
  );
  requireEvidence(cacheEvidenceSufficient(report.trials),
    'Warm/cold cache evidence does not meet the pre-registered sufficiency rule.');
  const typedTrials: DirectorEvalTrial[] = report.trials;
  const recomputedSummaries = summarizeConditions(typedTrials, expectedRowsPerCondition);
  requireEvidence(
    isDeepStrictEqual(report.conditionSummaries, recomputedSummaries),
    'Reported condition summaries do not reproduce from the raw trials.',
  );
  const sampled = report.trials.filter((trial) => trial.qualitySampled);
  const recomputedQualitySample = {
    preregisteredTrial: 1 as const,
    cacheState: 'cold' as const,
    intentIds: loadDirectorQualitySampleIntentIds(),
    plannedRows: report.budgetPlan.judgeCalls,
    observedRows: sampled.length,
    eligibleRows: sampled.filter((trial) => trial.validatorPassed).length,
    gradedRows: sampled.filter((trial) => trial.qualityEvidenceComplete).length,
  };
  requireEvidence(isDeepStrictEqual(report.qualitySample, recomputedQualitySample),
    'Reported blind-quality sample accounting does not reproduce from the raw trials.');
  const recomputedDecision = { status: 'authorized_live_evidence' as const, ...chooseCompositionWinner(recomputedSummaries) };
  requireEvidence(
    isDeepStrictEqual(report.compositionDecision, recomputedDecision),
    'Reported composition decision does not reproduce from the pre-registered rule.',
  );
  if (report.stoppedEarly !== null) {
    const declared = report.stoppedEarly.slice('pre_registered_dominance:'.length);
    requireEvidence(
      conditionDominatingByMoreThan2x(recomputedSummaries) === declared,
      'The declared early-stop winner does not reproduce from every pre-registered metric.',
    );
  }
  return trialRounds;
}

function verifyVisionEvidence(report: CompletedLiveReport): VisionAuditCandidateSummary[] {
  const defects = loadSeededDefects();
  const defectById = new Map(defects.map((defect) => [defect.id, defect]));
  requireEvidence(report.visionAudit.seededDefectCount === defects.length, 'Seeded-defect count differs from the checked-in corpus.');
  requireEvidence(report.visionAudit.cleanControlCount === defects.length, 'Clean-control count differs from the checked-in corpus.');
  requireEvidence(report.visionAudit.deterministicCatchRate === 0, 'Deterministic checks must not claim seeded semantic catches.');
  requireEvidence(report.visionAudit.deterministicFalseRejectRate === 0, 'Deterministic checks must not claim semantic false rejects.');
  const seen = new Set<string>();
  for (const trial of report.visionAudit.trials) {
    const defect = defectById.get(trial.defectId);
    requireEvidence(Boolean(defect), `Unknown vision-audit defect ${trial.defectId}.`);
    requireEvidence(defect?.defectKind === trial.defectKind, `Defect-kind mismatch for ${trial.defectId}.`);
    const key = `${trial.defectId}:${trial.sample}:${trial.conditionId}`;
    requireEvidence(!seen.has(key), `Duplicate vision-audit row ${key}.`);
    seen.add(key);
    const expectedReject = trial.sample === 'defect';
    requireEvidence(trial.expectedReject === expectedReject, `Expected verdict mismatch for ${key}.`);
    requireEvidence(trial.caught === (expectedReject && trial.rejected), `Catch flag mismatch for ${key}.`);
    requireEvidence(trial.falseRejected === (!expectedReject && trial.rejected), `False-reject flag mismatch for ${key}.`);
  }
  for (const defect of defects) {
    for (const sample of ['defect', 'clean_control'] as const) {
      for (const conditionId of ['terra-low', 'luna-low'] as const) {
        requireEvidence(seen.has(`${defect.id}:${sample}:${conditionId}`),
          `Vision-audit matrix is missing ${defect.id}:${sample}:${conditionId}.`);
      }
    }
  }
  const candidates: VisionAuditCandidateSummary[] = (['terra-low', 'luna-low'] as const).map((conditionId) => {
    const rows = report.visionAudit.trials.filter((trial) => trial.conditionId === conditionId);
    const defectRows = rows.filter((trial) => trial.sample === 'defect');
    const cleanRows = rows.filter((trial) => trial.sample === 'clean_control');
    return {
      conditionId,
      model: conditionId === 'terra-low' ? 'gpt-5.6-terra' : 'gpt-5.6-luna',
      catchRate: ratio(defectRows.filter((row) => row.caught).length, defectRows.length),
      falseRejectRate: ratio(cleanRows.filter((row) => row.falseRejected).length, cleanRows.length),
      invalidReplyRate: ratio(rows.filter((row) => !row.validReply).length, rows.length),
      p50LatencyMs: percentile(rows.map((row) => row.latencyMs), 0.5),
      p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 0.95),
      costUsd: sum(rows.map((row) => row.costUsd)),
    };
  });
  requireEvidence(
    isDeepStrictEqual(report.visionAudit.candidates, candidates),
    'Reported vision-audit summaries do not reproduce from the raw trials.',
  );
  const decision = chooseVisionAuditDecision(candidates);
  requireEvidence(
    isDeepStrictEqual(report.visionAudit.decision, decision),
    'Reported vision-audit decision does not reproduce from the pre-registered rule.',
  );
  requireEvidence(report.visionAudit.auditBudgetMs === decision.auditBudgetMs,
    'Top-level audit budget differs from the selected audit decision.');
  return candidates;
}

function verifySketchEvidence(report: CompletedLiveReport) {
  const sketches = materializeSketchCorpus();
  const sketchById = new Map(sketches.map((sketch) => [sketch.id, sketch]));
  requireEvidence(report.sketchGrounding.itemCount === sketches.length, 'Sketch count differs from the checked-in synthetic corpus.');
  const seen = new Set<string>();
  for (const row of report.sketchGrounding.rows) {
    const sketch = sketchById.get(row.sketchId);
    requireEvidence(Boolean(sketch), `Unknown synthetic sketch ${row.sketchId}.`);
    const key = `${row.sketchId}:${row.conditionId}`;
    requireEvidence(!seen.has(key), `Duplicate sketch row ${key}.`);
    seen.add(key);
    requireEvidence(
      row.correct === (normalize(row.interpretation) === normalize(sketch?.expectedInterpretation ?? '')),
      `Interpretation correctness flag does not reproduce for ${key}.`,
    );
    requireEvidence(
      row.validReply || (row.interpretation === '' && row.confidence === 0),
      `Invalid sketch reply was not represented fail-closed for ${key}.`,
    );
  }
  for (const sketch of sketches) {
    for (const conditionId of ['terra-low', 'luna-low'] as const) {
      requireEvidence(seen.has(`${sketch.id}:${conditionId}`),
        `Sketch matrix is missing ${sketch.id}:${conditionId}.`);
    }
  }
  const candidates = (['terra-low', 'luna-low'] as const).map((conditionId) => {
    const rows = report.sketchGrounding.rows.filter((row) => row.conditionId === conditionId);
    return {
      conditionId,
      accuracy: ratio(rows.filter((row) => row.correct).length, rows.length),
      brierScore: ratio(rows.reduce((total, row) =>
        total + (row.confidence - (row.correct ? 1 : 0)) ** 2, 0), rows.length),
      invalidReplyRate: ratio(rows.filter((row) => !row.validReply).length, rows.length),
      costUsd: sum(rows.map((row) => row.costUsd)),
    };
  });
  requireEvidence(
    isDeepStrictEqual(report.sketchGrounding.candidates, candidates),
    'Reported sketch summaries do not reproduce from the raw rows.',
  );
  const assisted = sketches.map((sketch) => {
    const terra = report.sketchGrounding.rows.find((row) =>
      row.sketchId === sketch.id && row.conditionId === 'terra-low');
    const luna = report.sketchGrounding.rows.find((row) =>
      row.sketchId === sketch.id && row.conditionId === 'luna-low');
    requireEvidence(Boolean(terra && luna), `Paired sketch rows are missing for ${sketch.id}.`);
    return (luna?.confidence ?? 0) >= (terra?.confidence ?? 0) + 0.15
      ? Boolean(luna?.correct)
      : Boolean(terra?.correct);
  });
  const terraCorrect = sketches.map((sketch) => report.sketchGrounding.rows.find((row) =>
    row.sketchId === sketch.id && row.conditionId === 'terra-low')?.correct ?? false);
  const assistDecision = pairedAssistDecision(terraCorrect, assisted);
  requireEvidence(report.sketchGrounding.assistedAccuracy === ratio(assisted.filter(Boolean).length, assisted.length),
    'Assisted sketch accuracy does not reproduce from paired rows.');
  requireEvidence(report.sketchGrounding.cheaperModelAssistGain === assistDecision.gain,
    'Cheaper-model assist gain does not reproduce from paired rows.');
  requireEvidence(report.sketchGrounding.pairedImprovementPValue === assistDecision.pValue,
    'Paired sketch p-value does not reproduce from paired rows.');
  requireEvidence(report.sketchGrounding.statisticallySignificant === assistDecision.statisticallySignificant,
    'Sketch significance flag does not reproduce from paired rows.');
  requireEvidence(report.sketchGrounding.significantGainThreshold === 0.05,
    'Sketch assist gain threshold differs from the pre-registered five-point bar.');
  return candidates;
}

type SpendPhase = CompletedLiveReport['spendLedger']['entries'][number]['phase'];

interface ReconstructedSpendLedger {
  logicalCallCount: number;
  providerCallsByPhase: Record<SpendPhase, number>;
  failedProviderCallsByPhase: Record<SpendPhase, number>;
  observedCostUsdByPhase: Record<SpendPhase, number>;
  upperBoundUsdByPhase: Record<SpendPhase, number>;
}

function verifyAuthorizationLedger(report: CompletedLiveReport): void {
  const authorization = report.authorizationLedger;
  requireEvidence(authorization.runMaxSpendUsd === report.maxSpendUsd,
    'Authorization-ledger run maximum differs from the report spend cap.');
  requireEvidence(
    authorization.combinedMaximumUsd === money(authorization.priorReservedUsd + authorization.runMaxSpendUsd),
    'Authorization-ledger combined maximum does not reproduce from prior reserve and run maximum.',
  );
  requireEvidence(authorization.combinedMaximumUsd <= authorization.sessionHardCapUsd,
    'Authorization-ledger combined maximum exceeds the session hard cap.');
}

function verifySpendLedger(report: CompletedLiveReport): ReconstructedSpendLedger {
  interface OpenCall {
    phase: SpendPhase;
    models: Array<'gpt-5.6-terra' | 'gpt-5.6-luna'>;
    reserveUsd: number;
    providerCallCount: number;
  }
  const openCalls = new Map<string, OpenCall>();
  const settledCalls = new Set<string>();
  const providerCallsByPhase: Record<SpendPhase, number> = {
    warmup: 0,
    composition: 0,
    judge: 0,
    vision_audit: 0,
    sketch: 0,
  };
  const failedProviderCallsByPhase: Record<SpendPhase, number> = {
    warmup: 0,
    composition: 0,
    judge: 0,
    vision_audit: 0,
    sketch: 0,
  };
  const observedCostUsdByPhase: Record<SpendPhase, number> = {
    warmup: 0,
    composition: 0,
    judge: 0,
    vision_audit: 0,
    sketch: 0,
  };
  const upperBoundUsdByPhase: Record<SpendPhase, number> = {
    warmup: 0,
    composition: 0,
    judge: 0,
    vision_audit: 0,
    sketch: 0,
  };
  let logicalCallCount = 0;
  let cumulativeProviderCalls = 0;
  let cumulativeObservedCostUsd = 0;
  let cumulativeAccountedCostUsd = 0;
  let openReservationUsd = 0;

  for (let index = 0; index < report.spendLedger.entries.length; index += 1) {
    const entry = report.spendLedger.entries[index];
    requireEvidence(entry.sequence === index + 1,
      `Spend-ledger event sequence is not contiguous at entry ${index + 1}.`);
    requireEvidence(entry.runId === report.spendLedger.runId,
      `Spend-ledger event ${entry.sequence} belongs to a different run.`);
    requireEvidence(new Set(entry.models).size === entry.models.length,
      `Spend-ledger call ${entry.callId} repeats a model.`);
    for (const value of [
      entry.reserveUsd,
      entry.observedCostUsd,
      entry.upperBoundUsd,
      entry.cumulativeObservedCostUsd,
      entry.cumulativeAccountedCostUsd,
      entry.openReservationUsd,
    ]) {
      requireEvidence(money(value) === value,
        `Spend-ledger event ${entry.sequence} has cost precision beyond ten decimal places.`);
    }
    const existing = openCalls.get(entry.callId);
    if (entry.status === 'reserved') {
      requireEvidence(!existing && !settledCalls.has(entry.callId),
        `Spend-ledger call ${entry.callId} was reserved more than once.`);
      logicalCallCount += 1;
      requireEvidence(entry.callId === `${report.spendLedger.runId}:call-${logicalCallCount}`,
        `Spend-ledger reservation ${entry.callId} is not the next call ID.`);
      requireEvidence(entry.providerCallCount === 0,
        `Reserved spend-ledger call ${entry.callId} already claims provider calls.`);
      requireEvidence(entry.observedCostUsd === 0 && entry.upperBoundUsd === entry.reserveUsd,
        `Reserved spend-ledger call ${entry.callId} has invalid cost fields.`);
      requireEvidence(entry.usage.length === 0,
        `Reserved spend-ledger call ${entry.callId} carries usage evidence.`);
      openCalls.set(entry.callId, {
        phase: entry.phase,
        models: entry.models,
        reserveUsd: entry.reserveUsd,
        providerCallCount: 0,
      });
      openReservationUsd = money(openReservationUsd + entry.reserveUsd);
    } else {
      requireEvidence(Boolean(existing),
        `Spend-ledger call ${entry.callId} has ${entry.status} without an open reservation.`);
      requireEvidence(existing?.phase === entry.phase &&
        isDeepStrictEqual(existing?.models, entry.models) &&
        existing?.reserveUsd === entry.reserveUsd,
      `Spend-ledger metadata changed during call ${entry.callId}.`);
      if (entry.status === 'started') {
        const previousCallCount = existing?.providerCallCount ?? 0;
        requireEvidence(previousCallCount === 0,
          `Spend-ledger call ${entry.callId} was started more than once.`);
        requireEvidence(entry.providerCallCount === entry.models.length,
          `Spend-ledger call ${entry.callId} did not start exactly one request per model.`);
        const delta = entry.providerCallCount - previousCallCount;
        cumulativeProviderCalls += delta;
        providerCallsByPhase[entry.phase] += delta;
        if (existing) existing.providerCallCount = entry.providerCallCount;
        requireEvidence(entry.observedCostUsd === 0 && entry.upperBoundUsd === entry.reserveUsd,
          `Started spend-ledger call ${entry.callId} has invalid cost fields.`);
        requireEvidence(entry.usage.length === 0,
          `Started spend-ledger call ${entry.callId} carries terminal usage evidence.`);
      } else {
        requireEvidence((existing?.providerCallCount ?? 0) > 0 &&
          entry.providerCallCount === existing?.providerCallCount,
        `Terminal spend-ledger call ${entry.callId} has an inconsistent provider-call count.`);
        requireEvidence(entry.providerCallCount === entry.models.length,
          `Terminal spend-ledger call ${entry.callId} is not balanced against its model legs.`);
        requireEvidence(entry.upperBoundUsd >= entry.observedCostUsd,
          `Terminal spend-ledger call ${entry.callId} has an upper bound below observed cost.`);
        requireEvidence(entry.upperBoundUsd <= entry.reserveUsd,
          `Terminal spend-ledger call ${entry.callId} exceeded its reservation.`);
        if (entry.status === 'failed') {
          requireEvidence(entry.upperBoundUsd === entry.reserveUsd,
            `Failed spend-ledger call ${entry.callId} did not charge its reservation.`);
          failedProviderCallsByPhase[entry.phase] += entry.providerCallCount;
          requireEvidence(entry.usage.length === 0 || entry.usage.every((usage) => !usage.usageComplete),
            `Failed spend-ledger call ${entry.callId} claims complete usage evidence.`);
        }
        const usageModels = new Set<string>();
        for (const usage of entry.usage) {
          requireEvidence(entry.models.includes(usage.model),
            `Spend-ledger call ${entry.callId} has usage for an undeclared model.`);
          requireEvidence(!usageModels.has(usage.model),
            `Spend-ledger call ${entry.callId} repeats usage for ${usage.model}.`);
          usageModels.add(usage.model);
          requireEvidence(usage.cachedInputTokens + usage.cacheWriteTokens <= usage.inputTokens,
            `Spend-ledger call ${entry.callId} has impossible input-token accounting.`);
        }
        cumulativeObservedCostUsd = money(cumulativeObservedCostUsd + entry.observedCostUsd);
        cumulativeAccountedCostUsd = money(cumulativeAccountedCostUsd + entry.upperBoundUsd);
        observedCostUsdByPhase[entry.phase] = money(
          observedCostUsdByPhase[entry.phase] + entry.observedCostUsd,
        );
        upperBoundUsdByPhase[entry.phase] = money(
          upperBoundUsdByPhase[entry.phase] + entry.upperBoundUsd,
        );
        openReservationUsd = money(openReservationUsd - (existing?.reserveUsd ?? 0));
        requireEvidence(openReservationUsd >= 0,
          `Spend-ledger call ${entry.callId} over-released reservations.`);
        openCalls.delete(entry.callId);
        settledCalls.add(entry.callId);
      }
    }
    requireEvidence(entry.cumulativeProviderCalls === cumulativeProviderCalls,
      `Spend-ledger provider-call cumulative is wrong at sequence ${entry.sequence}.`);
    requireEvidence(entry.cumulativeObservedCostUsd === cumulativeObservedCostUsd,
      `Spend-ledger observed-cost cumulative is wrong at sequence ${entry.sequence}.`);
    requireEvidence(entry.cumulativeAccountedCostUsd === cumulativeAccountedCostUsd,
      `Spend-ledger accounted-cost cumulative is wrong at sequence ${entry.sequence}.`);
    requireEvidence(entry.openReservationUsd === openReservationUsd,
      `Spend-ledger open-reservation balance is wrong at sequence ${entry.sequence}.`);
    requireEvidence(money(cumulativeAccountedCostUsd + openReservationUsd) <= report.spendLedger.maxSpendUsd,
      `Spend-ledger sequence ${entry.sequence} crosses its hard spend cap.`);
  }

  requireEvidence(openCalls.size === 0 && openReservationUsd === 0,
    'Completed spend ledger retains one or more open reservations.');
  requireEvidence(report.spendLedger.openReservationUsd === 0,
    'Completed spend-ledger summary has a non-zero open reservation.');
  requireEvidence(report.spendLedger.maxSpendUsd === report.maxSpendUsd,
    'Spend-ledger maximum differs from the report spend cap.');
  requireEvidence(report.spendLedger.providerCalls === cumulativeProviderCalls &&
    report.providerCalls === cumulativeProviderCalls,
  'Spend-ledger terminal provider calls differ from report totals.');
  requireEvidence(report.spendLedger.observedCostUsd === cumulativeObservedCostUsd &&
    report.estimatedCostUsd === cumulativeObservedCostUsd,
  'Spend-ledger terminal observed cost differs from report totals.');
  requireEvidence(report.spendLedger.accountedCostUsd === cumulativeAccountedCostUsd &&
    report.accountedCostUsd === cumulativeAccountedCostUsd,
  'Spend-ledger terminal accounted cost differs from report totals.');
  const terminal = report.spendLedger.entries.at(-1);
  requireEvidence(Boolean(terminal) && terminal?.status !== 'reserved' && terminal?.status !== 'started',
    'Completed spend ledger does not end with a terminal event.');
  return {
    logicalCallCount,
    providerCallsByPhase,
    failedProviderCallsByPhase,
    observedCostUsdByPhase,
    upperBoundUsdByPhase,
  };
}

function verifyStudyBudget(
  report: CompletedLiveReport,
  reconstructedLedger: ReconstructedSpendLedger,
  resumedTrialKeys: Set<string>,
): void {
  const corpus = loadDirectorEvalCorpus();
  const expectedBudget = plannedLiveBudget({
    intentCount: corpus.length,
    judgedIntentCount: loadDirectorQualitySampleIntentIds().length,
    trialsPerCacheState: 5,
    judgedTrialsPerCacheState: 1,
    judgedCacheStateCount: 1,
    conditions: DIRECTOR_EVAL_CONDITIONS,
    defectCount: loadSeededDefects().length,
    sketchCount: materializeSketchCorpus().length,
    contextRasterIntentCount: corpus.filter((intent) => (intent.existingBoardOps?.length ?? 0) > 0).length,
  });
  requireEvidence(isDeepStrictEqual(report.budgetPlan, expectedBudget),
    'Recorded budget plan differs from the checked-in conservative plan.');
  requireEvidence(
    report.conservativePlanFitsRunCap ===
      (report.budgetPlan.conservativeTotalUsd <= report.maxSpendUsd),
    'Conservative-plan fit flag does not reproduce from the run cap.',
  );
  requireEvidence(report.estimatedCostUsd <= report.accountedCostUsd,
    'Accounted cost is below the provider-usage estimate.');
  requireEvidence(report.accountedCostUsd <= report.maxSpendUsd,
    'Accounted cost exceeds the authorized spend cap.');
  const warmupCalls = new Set(DIRECTOR_EVAL_CONDITIONS.flatMap((condition) =>
    condition.legs.map((leg) => `${leg.model}:${leg.reasoningEffort}`))).size;
  const currentTrials = report.trials.filter((trial) => !resumedTrialKeys.has(directorTrialKey(trial)));
  const compositionCalls = currentTrials.reduce((total, trial) =>
    total + (DIRECTOR_EVAL_CONDITIONS.find((condition) => condition.id === trial.conditionId)?.legs.length ?? 0), 0);
  const judgeCalls = currentTrials.filter((trial) => trial.qualitySampled && trial.validatorPassed).length;
  const expectedCallsByPhase: Record<SpendPhase, number> = {
    warmup: warmupCalls + reconstructedLedger.failedProviderCallsByPhase.warmup,
    composition: compositionCalls + reconstructedLedger.failedProviderCallsByPhase.composition,
    judge: judgeCalls + reconstructedLedger.failedProviderCallsByPhase.judge +
      report.judgeInvalidResponseRetries,
    vision_audit: report.visionAudit.trials.length +
      reconstructedLedger.failedProviderCallsByPhase.vision_audit,
    sketch: report.sketchGrounding.rows.length + reconstructedLedger.failedProviderCallsByPhase.sketch,
  };
  requireEvidence(isDeepStrictEqual(reconstructedLedger.providerCallsByPhase, expectedCallsByPhase),
    'Spend-ledger provider calls by phase do not reconcile with raw study evidence.');
  requireEvidence(
    Object.values(reconstructedLedger.failedProviderCallsByPhase)
      .reduce((total, calls) => total + calls, 0) === report.transportRetryProviderCalls,
    'Transport retry count does not reconcile with failed provider calls.',
  );
  const expectedCalls = Object.values(expectedCallsByPhase).reduce((total, calls) => total + calls, 0);
  requireEvidence(report.providerCalls === expectedCalls,
    `Provider-call count does not reconcile with raw evidence (expected ${expectedCalls}).`);
  requireEvidence(
    reconstructedLedger.observedCostUsdByPhase.composition ===
      moneySum(currentTrials.map((trial) => trial.costUsd)),
    'Spend-ledger composition observed cost does not reconcile with raw trial evidence.',
  );
  requireEvidence(
    reconstructedLedger.upperBoundUsdByPhase.composition ===
      moneySum([
        ...currentTrials.map((trial) => trial.costUpperBoundUsd),
        ...report.spendLedger.entries
          .filter((entry) => entry.phase === 'composition' && entry.status === 'failed')
          .map((entry) => entry.upperBoundUsd),
      ]),
    'Spend-ledger composition upper-bound cost does not reconcile with raw trial evidence.',
  );
  requireEvidence(
    reconstructedLedger.observedCostUsdByPhase.vision_audit ===
      moneySum(report.visionAudit.trials.map((trial) => trial.costUsd)),
    'Spend-ledger vision-audit observed cost does not reconcile with raw trial evidence.',
  );
  requireEvidence(
    reconstructedLedger.observedCostUsdByPhase.sketch ===
      moneySum(report.sketchGrounding.rows.map((row) => row.costUsd)),
    'Spend-ledger sketch observed cost does not reconcile with raw row evidence.',
  );
}

function summarizeCacheEvidence(trials: CompletedLiveReport['trials']) {
  return DIRECTOR_EVAL_CONDITIONS.flatMap((condition) =>
    (['cold', 'warm'] as const).map((cacheState) => {
      const rows = trials.filter((trial) =>
        trial.conditionId === condition.id && trial.cacheState === cacheState);
      return {
        conditionId: condition.id,
        cacheState,
        trials: rows.length,
        expectationPassRate: ratio(rows.filter((row) => row.cacheExpectationMet).length, rows.length),
        inputTokens: rows.reduce((total, row) => total + row.inputTokens, 0),
        cachedInputTokens: rows.reduce((total, row) => total + row.cachedInputTokens, 0),
        cacheWriteTokens: rows.reduce((total, row) => total + row.cacheWriteTokens, 0),
      };
    }));
}

function renderDecisionMarkdown(
  evidence: Omit<DirectorBakeoffDecisionEvidence, 'markdown'>,
): string {
  const compositionRows = evidence.composition.conditions.map((condition) => [
    condition.conditionId,
    evidence.composition.eligibleConditionIds.includes(condition.conditionId) ? 'yes' : 'no',
    percent(condition.firstPassValidity),
    percent(condition.strictSchemaValidity ?? 0),
    percent(condition.validatorPassRate ?? 0),
    percent(condition.storyboardCoverageRate ?? 0),
    fixed(condition.qualityGrade, 2),
    milliseconds(condition.p50TtftMs ?? 0),
    milliseconds(condition.p50FirstValidOpMs),
    milliseconds(condition.p50CompleteSceneMs ?? 0),
    dollars(condition.meanCostUpperBoundUsd ?? condition.meanCostUsd),
  ]);
  const cacheRows = evidence.cache.map((row) => [
    row.conditionId,
    row.cacheState,
    String(row.trials),
    percent(row.expectationPassRate),
    String(row.inputTokens),
    String(row.cachedInputTokens),
    String(row.cacheWriteTokens),
  ]);
  const auditRows = evidence.visionAudit.candidates.map((candidate) => [
    candidate.conditionId,
    candidate.model,
    percent(candidate.catchRate),
    percent(candidate.falseRejectRate),
    percent(candidate.invalidReplyRate),
    milliseconds(candidate.p50LatencyMs),
    milliseconds(candidate.p95LatencyMs),
    dollars(candidate.costUsd),
  ]);
  auditRows.unshift([
    'deterministic checks',
    'n/a',
    percent(evidence.visionAudit.deterministicCatchRate),
    percent(evidence.visionAudit.deterministicFalseRejectRate),
    'n/a',
    'n/a',
    'n/a',
    '$0.000000',
  ]);
  const sketchRows = evidence.sketchGrounding.candidates.map((candidate) => [
    candidate.conditionId,
    percent(candidate.accuracy),
    fixed(candidate.brierScore, 4),
    percent(candidate.invalidReplyRate),
    dollars(candidate.costUsd),
  ]);
  const source = evidence.rawEvidencePath === null
    ? `SHA-256 ${inlineCode(evidence.rawEvidenceSha256)}`
    : `${inlineCode(evidence.rawEvidencePath)} (SHA-256 ${inlineCode(evidence.rawEvidenceSha256)})`;
  return [
    '## Authorized live evidence',
    '',
    `Raw evidence: ${source}.`,
    '',
    `${evidence.report.representativeIntents} representative and ${evidence.report.holdoutIntents} sealed holdout synthetic intents were run for ${evidence.trialRounds} warm and ${evidence.trialRounds} cold trial(s) per condition. The run made ${evidence.report.providerCalls} provider calls; estimated cost was ${dollars(evidence.report.estimatedCostUsd)}, accounted upper-bound cost was ${dollars(evidence.report.accountedCostUsd)}, and the hard cap was ${dollars(evidence.report.maxSpendUsd)}. Early stop: ${inlineCode(evidence.report.stoppedEarly ?? 'none')}.`,
    '',
    `Authorization accounting reserves ${dollars(evidence.report.authorizationLedger.priorReservedUsd)} for prior attempts and ${dollars(evidence.report.authorizationLedger.runMaxSpendUsd)} for this run, for a combined maximum of ${dollars(evidence.report.authorizationLedger.combinedMaximumUsd)} against the ${dollars(evidence.report.authorizationLedger.sessionHardCapUsd)} session cap.`,
    `The all-calls-at-reservation plan ${evidence.report.conservativePlanFitsRunCap ? 'fit' : 'did not fit'} this run cap; the append-only per-call ledger remained the hard enforcement boundary and the completed report reconciles its actual upper-bound cost.`,
    '',
    `The balanced spend ledger for run ${inlineCode(evidence.report.spendLedger.runId)} contains ${evidence.report.spendLedger.entryCount} ordered events across ${evidence.report.spendLedger.logicalCallCount} settled logical calls. Its terminal provider calls and observed/accounted costs reproduce the report totals, with ${dollars(evidence.report.spendLedger.openReservationUsd)} left reserved.`,
    '',
    `Blind raster quality was pre-registered on ${evidence.report.qualitySample.cacheState} trial ${evidence.report.qualitySample.preregisteredTrial}: ${evidence.report.qualitySample.observedRows}/${evidence.report.qualitySample.plannedRows} sample rows were observed, ${evidence.report.qualitySample.eligibleRows} passed deterministic/browser validation, and ${evidence.report.qualitySample.gradedRows} received a valid blind grade.`,
    '',
    '### Composition summary',
    '',
    markdownTable([
      'Condition', 'Eligible', 'First-pass validity', 'Strict schema',
      'Validator pass', 'Storyboard coverage', 'Quality grade', 'p50 TTFT',
      'p50 first valid op', 'p50 scene complete', 'Mean cost upper bound',
    ], compositionRows),
    '',
    evidence.composition.winnerConditionId === null
      ? `Decision: no composition condition cleared the pre-registered adoption bars; hedge adoption is off. ${evidence.composition.reasons.join(' ')}`
      : `Decision: ${inlineCode(evidence.composition.winnerConditionId)} is the composition winner; hedge adoption is ${evidence.composition.hedgeAdopted ? 'on' : 'off'}. ${evidence.composition.reasons.join(' ')}`,
    '',
    '### Cache evidence',
    '',
    markdownTable([
      'Condition', 'State', 'Trials', 'Expectation pass', 'Input tokens',
      'Cached input tokens', 'Cache-write tokens',
    ], cacheRows),
    '',
    '### Vision-audit summary',
    '',
    markdownTable([
      'Condition', 'Model', 'Catch rate', 'False-reject rate', 'Invalid-reply rate',
      'p50 latency', 'p95 latency', 'Total cost',
    ], auditRows),
    '',
    `The audit study used ${evidence.visionAudit.seededDefectCount} semantic defects and ${evidence.visionAudit.cleanControlCount} matched clean controls that had already passed deterministic validation.`,
    '',
    `Decision: ${evidence.visionAudit.selectedConditionId === null ? 'no model was adopted' : `${inlineCode(evidence.visionAudit.selectedConditionId)} (${inlineCode(evidence.visionAudit.selectedModel ?? '')}) was adopted`}; reveal gate ${inlineCode(evidence.visionAudit.revealGate)}, audit budget ${milliseconds(evidence.visionAudit.auditBudgetMs)}. ${evidence.visionAudit.reason}.`,
    '',
    '### Sketch-grounding summary',
    '',
    markdownTable(['Condition', 'Accuracy', 'Brier score', 'Invalid-reply rate', 'Total cost'], sketchRows),
    '',
    `Paired assist accuracy was ${percent(evidence.sketchGrounding.assistedAccuracy)}; gain ${signedPercent(evidence.sketchGrounding.cheaperModelAssistGain)}, one-sided p=${fixed(evidence.sketchGrounding.pairedImprovementPValue, 6)}. Check-grading eligibility is ${inlineCode(String(evidence.sketchGrounding.assistDecisionEligibleForCheckGrading))}; cheaper-model assist remains ${inlineCode(evidence.sketchGrounding.cheaperModelAssistDefault)}. ${evidence.sketchGrounding.decisionReason}`,
    '',
  ].join('\n');
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function inlineCode(value: string): string {
  return value.includes('`') ? `\`\` ${value} \`\`` : `\`${value}\``;
}

function percent(value: number): string { return `${fixed(value * 100, 1)}%`; }
function signedPercent(value: number): string { return `${value >= 0 ? '+' : ''}${fixed(value * 100, 1)} pp`; }
function milliseconds(value: number): string { return `${Math.round(value)} ms`; }
function dollars(value: number): string { return `$${fixed(value, 6)}`; }
function fixed(value: number, digits: number): string { return value.toFixed(digits); }
function normalize(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, ' '); }
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 10_000;
}
function sum(values: number[]): number {
  return Math.round(values.reduce((total, value) => total + value, 0) * 1e8) / 1e8;
}
function moneySum(values: number[]): number {
  return values.reduce((total, value) => money(total + value), 0);
}
function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] ?? 0;
}
function money(value: number): number { return Math.round(value * 1e10) / 1e10; }
function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DecisionEvidenceError(message);
}
