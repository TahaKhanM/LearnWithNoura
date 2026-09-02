import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BoardOp } from '../../../shared/boardOps.js';
import { LayoutIssueSchema } from '../../../shared/layoutFeedback.js';
import { IncrementalDirectorStreamParser } from '../directorStreamParser.js';
import { loadDirectorEvalCorpus } from './corpus.js';
import { M1BrowserObservationArtifactSchema, M1_PIPELINE_STUDY_POLICY } from './m1PipelineStudy.js';
import type { M1PipelineStudyHarness } from './m1PipelineStudyTypes.js';
import policyJson from './fixtures/f9-layout-recovery-policy.json' with { type: 'json' };
import { compositionCallReserveUsd, estimateUsageCostUsd, judgeCallReserveUsd } from './budget.js';

const SourceTrialSchema = z.object({
  intentId: z.string().min(1).max(80),
  split: z.enum(['representative', 'holdout']),
  conditionId: z.string().min(1),
  cacheState: z.enum(['cold', 'warm']),
  trial: z.number().int().min(1).max(5),
  firstStepStatus: z.enum(['valid', 'invalid', 'missing']),
  strictSchemaValid: z.boolean(),
  validatorPassed: z.boolean(),
  storyboardCoverage: z.boolean(),
  proposalText: z.string(),
}).passthrough();
const SourceSchema = z.object({ trials: z.array(SourceTrialSchema) }).passthrough();

type SourceTrial = z.infer<typeof SourceTrialSchema>;

export interface LayoutFailureCohortRow {
  sourceKey: string;
  intentId: string;
  split: 'representative' | 'holdout';
  category: string;
  cacheState: 'cold' | 'warm';
  trial: number;
  proposalSha256: string;
  lowProposalText: string;
  lowStructuredValid: boolean;
  lowBrowserAccepted: false;
  reasons: string[];
  failingStepIndex: number | null;
  failingStepId: string | null;
  mediumProxyAccepted: boolean;
  mediumProxyProposalText: string;
}

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const F9LayoutRecoveryPolicySchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  ruleSourcePath: z.string().min(1),
  sourceEvidencePath: z.string().min(1),
  sourceEvidenceSha256: HashSchema,
  m1BrowserObservationPath: z.string().min(1),
  m1BrowserObservationSha256: HashSchema,
  layoutFeedbackPath: z.string().min(1),
  layoutFeedbackSha256: HashSchema,
  failureRows: z.literal(31),
  baseDelivered: z.literal(329),
  totalRows: z.literal(360),
  minimumDeliveredValidity: z.literal(0.97),
  minimumRecoveries: z.literal(21),
  maximumLiveSpendUsd: z.literal(5),
  maximumCanaryProviderCalls: z.literal(4),
  maximumFullProviderCalls: z.literal(90),
  qualityGradeTolerance: z.literal(1),
  earlyStopRule: z.string().min(1),
}).strict();
export const F9_LAYOUT_RECOVERY_POLICY = F9LayoutRecoveryPolicySchema.parse(policyJson);

export const LayoutFailureFeedbackArtifactSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  evidenceMode: z.literal('offline_local_browser_layout_failure_feedback'),
  providerCalls: z.literal(0),
  runtimeCostUsd: z.literal(0),
  source: z.object({
    m0Sha256: HashSchema,
    m1BrowserSha256: HashSchema,
    failureRows: z.literal(31),
  }).strict(),
  browserHarness: z.object({
    origin: z.string().url(),
    path: z.literal('/dev/board'),
    finalOrigin: z.string().url(),
    finalPath: z.literal('/dev/board'),
    externalRequestCount: z.literal(0),
  }).strict(),
  rows: z.array(z.object({
    sourceKey: z.string().min(1),
    intentId: z.string().min(1),
    proposalSha256: HashSchema,
    failingStepIndex: z.number().int().nonnegative(),
    failingStepId: z.string().min(1).max(120),
    priorOpsSha256: HashSchema,
    rejectedOpsSha256: HashSchema,
    cumulativeOpsSha256: HashSchema,
    reasons: z.array(z.string().min(1).max(200)).min(1).max(8),
    layoutIssues: z.array(LayoutIssueSchema).min(1).max(8),
  }).strict()).length(31),
}).strict();
export type LayoutFailureFeedbackArtifact = z.infer<typeof LayoutFailureFeedbackArtifactSchema>;

export const F9_QUALITY_SAMPLE_PER_ARM = 14;

export const LAYOUT_CORRECTION_CALL_RESERVE_USD = Math.ceil(estimateUsageCostUsd('gpt-5.6-terra', {
  inputTokens: 8_000,
  cachedInputTokens: 0,
  cacheWriteTokens: 8_000,
  outputTokens: 1_000,
}) * 10_000) / 10_000;

export function buildLayoutFailureCohort(
  sourceRawJson: string,
  observationsRawJson: string,
): LayoutFailureCohortRow[] {
  if (sha256(sourceRawJson) !== M1_PIPELINE_STUDY_POLICY.sourceEvidenceSha256) {
    throw new Error('F9 source SHA-256 does not match the immutable M0 evidence.');
  }
  if (sha256(observationsRawJson) !== M1_PIPELINE_STUDY_POLICY.browserObservationSha256) {
    throw new Error('F9 browser SHA-256 does not match the immutable M1 observations.');
  }
  const source = SourceSchema.parse(JSON.parse(sourceRawJson));
  const observations = M1BrowserObservationArtifactSchema.parse(JSON.parse(observationsRawJson));
  const sourceByKey = new Map(source.trials.map((row) => [trialKey(row), row]));
  const failures = observations.rows.filter((row) => !row.atomic.accepted);
  return failures.map((observation) => {
    const low = sourceByKey.get(observation.sourceKey);
    const medium = sourceByKey.get(`${observation.intentId}:terra-med:${observation.cacheState}:${observation.trial}`);
    if (!low || !medium) throw new Error(`F9 source rows are incomplete for ${observation.sourceKey}.`);
    const failedStep = observation.streamed.cumulativeVerdicts.find((verdict) => !verdict.accepted);
    return {
      sourceKey: observation.sourceKey,
      intentId: observation.intentId,
      split: observation.split,
      category: observation.category,
      cacheState: observation.cacheState,
      trial: observation.trial,
      proposalSha256: observation.proposalSha256,
      lowProposalText: low.proposalText,
      lowStructuredValid: structuredValid(low),
      lowBrowserAccepted: false as const,
      reasons: [...observation.atomic.reasons],
      failingStepIndex: failedStep?.stepIndex ?? null,
      failingStepId: failedStep?.stepId ?? null,
      mediumProxyAccepted: deliveredValid(medium),
      mediumProxyProposalText: medium.proposalText,
    };
  }).sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}

export async function collectLayoutFailureFeedback(input: {
  sourceRawJson: string;
  observationsRawJson: string;
  harness: M1PipelineStudyHarness;
}): Promise<LayoutFailureFeedbackArtifact> {
  const cohort = buildLayoutFailureCohort(input.sourceRawJson, input.observationsRawJson);
  const corpus = new Map(loadDirectorEvalCorpus().map((intent) => [intent.id, intent]));
  const rows: LayoutFailureFeedbackArtifact['rows'] = [];
  for (const failure of cohort) {
    const intent = corpus.get(failure.intentId);
    if (!intent) throw new Error(`F9 feedback references unknown intent ${failure.intentId}.`);
    const existingOps = intent.existingBoardOps ?? [];
    const visibleObjectIds = existingOps.flatMap((op) => op.op === 'add' ? [op.id] : []);
    const parser = new IncrementalDirectorStreamParser({ density: intent.density, visibleObjectIds });
    const steps = parser.push(failure.lowProposalText);
    parser.finish();
    const cumulativeOps: BoardOp[] = [];
    let recorded = false;
    for (const step of steps) {
      const priorOps = [...cumulativeOps];
      cumulativeOps.push(...step.ops);
      const verdict = await input.harness.validate([...existingOps, ...cumulativeOps]);
      if (verdict.ok) continue;
      const layoutIssues = z.array(LayoutIssueSchema).min(1).max(8).parse(verdict.layoutIssues ?? []);
      rows.push({
        sourceKey: failure.sourceKey,
        intentId: failure.intentId,
        proposalSha256: failure.proposalSha256,
        failingStepIndex: step.index,
        failingStepId: step.step.id,
        priorOpsSha256: opsSha256(priorOps),
        rejectedOpsSha256: opsSha256(step.ops),
        cumulativeOpsSha256: opsSha256(cumulativeOps),
        reasons: verdict.issues.slice(0, 8),
        layoutIssues,
      });
      recorded = true;
      break;
    }
    if (!recorded) throw new Error(`F9 browser replay no longer reproduces ${failure.sourceKey}.`);
  }
  const browserState = input.harness.browserState();
  if (browserState.externalRequestCount !== 0 ||
      browserState.finalOrigin !== input.harness.origin ||
      browserState.finalPath !== input.harness.path) {
    throw new Error('F9 browser feedback collection left the isolated loopback harness.');
  }
  return LayoutFailureFeedbackArtifactSchema.parse({
    schemaVersion: '1.0.0',
    evidenceMode: 'offline_local_browser_layout_failure_feedback',
    providerCalls: 0,
    runtimeCostUsd: 0,
    source: {
      m0Sha256: M1_PIPELINE_STUDY_POLICY.sourceEvidenceSha256,
      m1BrowserSha256: M1_PIPELINE_STUDY_POLICY.browserObservationSha256,
      failureRows: 31,
    },
    browserHarness: {
      origin: input.harness.origin,
      path: input.harness.path,
      finalOrigin: browserState.finalOrigin,
      finalPath: browserState.finalPath,
      externalRequestCount: browserState.externalRequestCount,
    },
    rows: rows.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey)),
  });
}

export function compileLayoutFailureFeedbackEvidence(
  sourceRawJson: string,
  observationsRawJson: string,
  feedbackRawJson: string,
): { artifact: LayoutFailureFeedbackArtifact; feedbackSha256: string } {
  if (sha256(sourceRawJson) !== F9_LAYOUT_RECOVERY_POLICY.sourceEvidenceSha256) {
    throw new Error('F9 source SHA-256 does not match policy.');
  }
  if (sha256(observationsRawJson) !== F9_LAYOUT_RECOVERY_POLICY.m1BrowserObservationSha256) {
    throw new Error('F9 M1 browser SHA-256 does not match policy.');
  }
  const feedbackSha256 = sha256(feedbackRawJson);
  if (feedbackSha256 !== F9_LAYOUT_RECOVERY_POLICY.layoutFeedbackSha256) {
    throw new Error('F9 layout-feedback SHA-256 does not match policy.');
  }
  const artifact = LayoutFailureFeedbackArtifactSchema.parse(JSON.parse(feedbackRawJson));
  if (artifact.source.m0Sha256 !== F9_LAYOUT_RECOVERY_POLICY.sourceEvidenceSha256 ||
      artifact.source.m1BrowserSha256 !== F9_LAYOUT_RECOVERY_POLICY.m1BrowserObservationSha256) {
    throw new Error('F9 layout feedback is not bound to the policy sources.');
  }
  const cohort = buildLayoutFailureCohort(sourceRawJson, observationsRawJson);
  const cohortByKey = new Map(cohort.map((row) => [row.sourceKey, row]));
  for (const row of artifact.rows) {
    const source = cohortByKey.get(row.sourceKey);
    if (!source || source.intentId !== row.intentId || source.proposalSha256 !== row.proposalSha256 ||
        (source.failingStepIndex !== null && source.failingStepIndex !== row.failingStepIndex) ||
        (source.failingStepId !== null && source.failingStepId !== row.failingStepId)) {
      throw new Error(`F9 layout feedback row ${row.sourceKey} diverges from immutable evidence.`);
    }
  }
  if (new Set(artifact.rows.map((row) => row.sourceKey)).size !== cohort.length) {
    throw new Error('F9 layout feedback duplicates or omits failure rows.');
  }
  return { artifact, feedbackSha256 };
}

export function summarizeProxyRecovery(rows: LayoutFailureCohortRow[]) {
  const mediumProxyRecovered = rows.filter((row) => row.mediumProxyAccepted).length;
  const postRecoveryDelivered = 360 - rows.length + mediumProxyRecovered;
  return {
    failures: rows.length,
    mediumProxyRecovered,
    postRecoveryDelivered,
    postRecoveryValidity: round(postRecoveryDelivered / 360, 6),
    minimumRecoveriesForGate: Math.max(0, Math.ceil(360 * 0.97) - (360 - rows.length)),
  };
}

export function layoutRecoveryBudgetPlan(input: {
  failureCount: number;
  gradeRecoverySample: boolean;
}) {
  const mediumReserve = compositionCallReserveUsd('gpt-5.6-terra', 'cold', true, 'medium');
  const correctionReserve = LAYOUT_CORRECTION_CALL_RESERVE_USD;
  const maximumCompositionCalls = input.failureCount * 2;
  const maximumJudgeCalls = input.gradeRecoverySample
    ? Math.min(input.failureCount, F9_QUALITY_SAMPLE_PER_ARM) * 2
    : 0;
  const conservativeTotalUsd = round(
    input.failureCount * mediumReserve +
    input.failureCount * correctionReserve +
    maximumJudgeCalls * judgeCallReserveUsd(),
    4,
  );
  return {
    canary: {
      intents: Math.min(3, input.failureCount),
      assignment: ['medium_escalation', 'targeted_correction', 'correction_then_escalation'],
      maximumProviderCalls: Math.min(4, input.failureCount + 1),
    },
    full: {
      failureRows: input.failureCount,
      maximumCompositionCalls,
      maximumJudgeCalls,
      maximumProviderCalls: maximumCompositionCalls + maximumJudgeCalls,
    },
    reservesUsd: {
      mediumPerCall: mediumReserve,
      correctionPerCall: correctionReserve,
      judgePerCall: judgeCallReserveUsd(),
    },
    conservativeTotalUsd,
    chainDerivedFromPairedArms: true,
  };
}

export interface RecoveryCandidate<T> {
  valid: boolean;
  value: T;
}

interface GradedRecovery<T> {
  candidate: RecoveryCandidate<T>;
  grade?: { valid: boolean; grade: number };
}

export function selectRecoveryCanaryRows(
  rows: LayoutFailureCohortRow[],
): [LayoutFailureCohortRow, LayoutFailureCohortRow, LayoutFailureCohortRow] {
  const selected: LayoutFailureCohortRow[] = [];
  const intentIds = new Set<string>();
  const categories = new Set<string>();
  for (const row of rows) {
    if (intentIds.has(row.intentId) || categories.has(row.category)) continue;
    selected.push(row);
    intentIds.add(row.intentId);
    categories.add(row.category);
    if (selected.length === 3) break;
  }
  for (const row of rows) {
    if (selected.length === 3) break;
    if (intentIds.has(row.intentId)) continue;
    selected.push(row);
    intentIds.add(row.intentId);
  }
  if (selected.length !== 3) throw new Error('F9 requires three distinct canary intents.');
  return selected as [LayoutFailureCohortRow, LayoutFailureCohortRow, LayoutFailureCohortRow];
}

export async function runStagedRecoveryDecision<T>(input: {
  rows: LayoutFailureCohortRow[];
  runMedium: (row: LayoutFailureCohortRow) => Promise<RecoveryCandidate<T>>;
  runCorrection: (row: LayoutFailureCohortRow) => Promise<RecoveryCandidate<T>>;
  grade: (value: T, row: LayoutFailureCohortRow, arm: 'medium_escalation' | 'targeted_correction') => Promise<{ valid: boolean; grade: number }>;
  qualitySamplePerArm?: number;
  stopAfterCanary?: boolean;
}) {
  if (input.rows.length < 3) throw new Error('F9 staged recovery requires at least three canary rows.');
  const medium = new Map<string, GradedRecovery<T>>();
  const correction = new Map<string, GradedRecovery<T>>();
  const qualitySamplePerArm = Math.max(1, Math.min(
    input.rows.length,
    input.qualitySamplePerArm ?? F9_QUALITY_SAMPLE_PER_ARM,
  ));
  let generationCalls = 0;
  let judgeCalls = 0;
  const runMedium = async (row: LayoutFailureCohortRow) => {
    if (medium.has(row.sourceKey)) return;
    medium.set(row.sourceKey, { candidate: await input.runMedium(row) });
    generationCalls += 1;
  };
  const runCorrection = async (row: LayoutFailureCohortRow) => {
    if (correction.has(row.sourceKey)) return;
    correction.set(row.sourceKey, { candidate: await input.runCorrection(row) });
    generationCalls += 1;
  };
  const gradeOutcome = async (
    row: LayoutFailureCohortRow,
    arm: 'medium_escalation' | 'targeted_correction',
    outcome: GradedRecovery<T> | undefined,
  ) => {
    if (!outcome?.candidate.valid || outcome.grade) return;
    const armOutcomes = arm === 'medium_escalation' ? medium : correction;
    const graded = [...armOutcomes.values()].filter((candidate) => candidate.grade).length;
    if (graded >= qualitySamplePerArm) return;
    outcome.grade = await input.grade(outcome.candidate.value, row, arm);
    judgeCalls += 1;
  };

  const canaryRows = selectRecoveryCanaryRows(input.rows);
  await runMedium(canaryRows[0]);
  await runCorrection(canaryRows[1]);
  await runCorrection(canaryRows[2]);
  await runMedium(canaryRows[2]);
  const canary = {
    passed: true,
    intents: 3,
    providerCalls: generationCalls,
    sourceKeys: canaryRows.map((row) => row.sourceKey),
  };
  if (generationCalls > F9_LAYOUT_RECOVERY_POLICY.maximumCanaryProviderCalls) {
    throw new Error('F9 canary exceeded its provider-call ceiling.');
  }
  if (input.stopAfterCanary) {
    return {
      stage: 'canary' as const,
      canary,
      winner: null,
      attempts: { medium_escalation: medium.size, targeted_correction: correction.size },
      judgeCalls,
      summaries: summarizeRecoveryMaps(input.rows, medium, correction, qualitySamplePerArm),
      rows: recoveryDecisionRows(input.rows, medium, correction),
    };
  }

  for (const row of canaryRows) {
    await gradeOutcome(row, 'medium_escalation', medium.get(row.sourceKey));
    await gradeOutcome(row, 'targeted_correction', correction.get(row.sourceKey));
  }
  let winner: 'medium_escalation' | 'targeted_correction' | 'correction_then_escalation' | null = null;
  for (const row of input.rows) {
    const summariesBefore = summarizeRecoveryMaps(input.rows, medium, correction, qualitySamplePerArm);
    if (!summariesBefore.targeted_correction.qualifies &&
        canStillReachGate(input.rows, correction)) {
      await runCorrection(row);
      await gradeOutcome(row, 'targeted_correction', correction.get(row.sourceKey));
    }
    let summaries = summarizeRecoveryMaps(input.rows, medium, correction, qualitySamplePerArm);
    if (summaries.targeted_correction.qualifies) {
      winner = 'targeted_correction';
      break;
    }
    const correctionPossible = canStillReachGate(input.rows, correction);
    if (!summaries.medium_escalation.qualifies &&
        (correctionPossible || canStillReachGate(input.rows, medium))) {
      await runMedium(row);
      await gradeOutcome(row, 'medium_escalation', medium.get(row.sourceKey));
    }
    summaries = summarizeRecoveryMaps(input.rows, medium, correction, qualitySamplePerArm);
    if (!correctionPossible && summaries.medium_escalation.qualifies) {
      winner = 'medium_escalation';
      break;
    }
    if (!correctionPossible && !canStillReachGate(input.rows, medium) &&
        summaries.correction_then_escalation.qualifies) {
      winner = 'correction_then_escalation';
      break;
    }
  }
  const summaries = summarizeRecoveryMaps(input.rows, medium, correction, qualitySamplePerArm);
  winner ??= summaries.targeted_correction.qualifies
    ? 'targeted_correction'
    : summaries.medium_escalation.qualifies
      ? 'medium_escalation'
      : summaries.correction_then_escalation.qualifies
        ? 'correction_then_escalation'
        : null;
  return {
    stage: 'complete' as const,
    canary,
    winner,
    attempts: { medium_escalation: medium.size, targeted_correction: correction.size },
    generationCalls,
    judgeCalls,
    summaries,
    rows: recoveryDecisionRows(input.rows, medium, correction),
  };
}

function summarizeRecoveryMaps<T>(
  rows: LayoutFailureCohortRow[],
  medium: Map<string, GradedRecovery<T>>,
  correction: Map<string, GradedRecovery<T>>,
  qualitySamplePerArm: number,
) {
  const summarize = (outcomes: Array<GradedRecovery<T> | undefined>) => {
    const recovered = outcomes.filter((outcome) => outcome?.candidate.valid).length;
    const grades = outcomes.flatMap((outcome) => outcome?.candidate.valid && outcome.grade?.valid ? [outcome.grade.grade] : []);
    const requiredGrades = Math.min(qualitySamplePerArm, recovered);
    const qualityEvidenceComplete = grades.length === requiredGrades;
    const meanGrade = round(mean(grades), 4);
    return {
      attempted: outcomes.filter(Boolean).length,
      recovered,
      delivered: F9_LAYOUT_RECOVERY_POLICY.baseDelivered + recovered,
      deliveredValidity: round((F9_LAYOUT_RECOVERY_POLICY.baseDelivered + recovered) / F9_LAYOUT_RECOVERY_POLICY.totalRows, 6),
      meanGrade,
      gradedRows: grades.length,
      requiredGradeRows: requiredGrades,
      qualityEvidenceComplete,
      qualifies: recovered >= F9_LAYOUT_RECOVERY_POLICY.minimumRecoveries &&
        qualityEvidenceComplete && meanGrade >= 3.7292 - F9_LAYOUT_RECOVERY_POLICY.qualityGradeTolerance,
    };
  };
  const mediumOutcomes = rows.map((row) => medium.get(row.sourceKey));
  const correctionOutcomes = rows.map((row) => correction.get(row.sourceKey));
  const chainOutcomes = correctionOutcomes.map((_, index) => {
    const corrected = correctionOutcomes[index];
    return corrected?.candidate.valid ? corrected : mediumOutcomes[index];
  });
  return {
    medium_escalation: summarize(mediumOutcomes),
    targeted_correction: summarize(correctionOutcomes),
    correction_then_escalation: summarize(chainOutcomes),
  };
}

function canStillReachGate<T>(
  rows: LayoutFailureCohortRow[],
  outcomes: Map<string, GradedRecovery<T>>,
): boolean {
  const recovered = [...outcomes.values()].filter((outcome) => outcome.candidate.valid).length;
  return recovered + (rows.length - outcomes.size) >= F9_LAYOUT_RECOVERY_POLICY.minimumRecoveries;
}

function recoveryDecisionRows<T>(
  rows: LayoutFailureCohortRow[],
  medium: Map<string, GradedRecovery<T>>,
  correction: Map<string, GradedRecovery<T>>,
) {
  return rows.map((row) => {
    const mediumOutcome = medium.get(row.sourceKey);
    const correctionOutcome = correction.get(row.sourceKey);
    return {
      sourceKey: row.sourceKey,
      medium: outcomeEvidence(mediumOutcome),
      correction: outcomeEvidence(correctionOutcome),
      chainRecovered: correctionOutcome?.candidate.valid === true || mediumOutcome?.candidate.valid === true,
    };
  });
}

function outcomeEvidence<T>(outcome: GradedRecovery<T> | undefined) {
  return outcome ? {
    attempted: true,
    valid: outcome.candidate.valid,
    grade: outcome.grade?.grade ?? null,
    gradeValid: outcome.grade?.valid ?? false,
  } : { attempted: false, valid: false, grade: null, gradeValid: false };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function structuredValid(row: SourceTrial): boolean {
  return row.strictSchemaValid && row.storyboardCoverage;
}

function deliveredValid(row: SourceTrial): boolean {
  return structuredValid(row) && row.validatorPassed;
}

function trialKey(row: SourceTrial): string {
  return `${row.intentId}:${row.conditionId}:${row.cacheState}:${row.trial}`;
}

function opsSha256(ops: BoardOp[]): string {
  return sha256(JSON.stringify(ops));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export type LayoutRecoveryBoardContext = {
  existingOps: BoardOp[];
  visibleObjectIds: string[];
};
