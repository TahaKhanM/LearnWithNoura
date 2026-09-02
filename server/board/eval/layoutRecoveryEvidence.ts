import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  F9_LAYOUT_RECOVERY_POLICY,
  F9_QUALITY_SAMPLE_PER_ARM,
  layoutRecoveryBudgetPlan,
} from './layoutRecoveryStudy.js';
import manifestJson from './fixtures/f9-layout-recovery-evidence-manifest.json' with { type: 'json' };

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ManifestSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  resultPath: z.string().min(1),
  resultSha256: HashSchema,
  sourceEvidenceSha256: HashSchema,
  m1BrowserObservationSha256: HashSchema,
  layoutFeedbackSha256: HashSchema,
  providerCalls: z.literal(53),
  accountedCostUsd: z.literal(0.2692976),
  maxSpendUsd: z.literal(3.25),
  winner: z.literal('medium_escalation'),
  minimumRecoveries: z.literal(21),
  qualityFloor: z.literal(2.7292),
}).strict();
const manifest = ManifestSchema.parse(manifestJson);

const ArmOutcomeSchema = z.object({
  attempted: z.boolean(),
  valid: z.boolean(),
  grade: z.number().min(1).max(5).nullable(),
  gradeValid: z.boolean(),
}).strict();
const DecisionRowSchema = z.object({
  sourceKey: z.string().min(1),
  medium: ArmOutcomeSchema,
  correction: ArmOutcomeSchema,
  chainRecovered: z.boolean(),
}).strict();
const SummarySchema = z.object({
  attempted: z.number().int().nonnegative(),
  recovered: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  deliveredValidity: z.number().min(0).max(1),
  meanGrade: z.number().min(0).max(5),
  gradedRows: z.number().int().nonnegative(),
  requiredGradeRows: z.number().int().nonnegative(),
  qualityEvidenceComplete: z.boolean(),
  qualifies: z.boolean(),
}).strict();
const UsageSchema = z.object({
  model: z.enum(['gpt-5.6-terra', 'gpt-5.6-luna']),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  usageComplete: z.boolean(),
}).strict();
const SpendEventSchema = z.object({
  sequence: z.number().int().positive(),
  runId: z.string().min(1),
  callId: z.string().min(1),
  status: z.enum(['reserved', 'started', 'completed', 'failed']),
  phase: z.enum(['layout_correction', 'recovery_escalation', 'judge']),
  models: z.array(z.enum(['gpt-5.6-terra', 'gpt-5.6-luna'])).min(1),
  reserveUsd: z.number().positive(),
  providerCallCount: z.number().int().nonnegative(),
  observedCostUsd: z.number().nonnegative(),
  upperBoundUsd: z.number().nonnegative(),
  usage: z.array(UsageSchema),
  cumulativeProviderCalls: z.number().int().nonnegative(),
  cumulativeObservedCostUsd: z.number().nonnegative(),
  cumulativeAccountedCostUsd: z.number().nonnegative(),
  openReservationUsd: z.number().nonnegative(),
}).strict();
const ReportSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  evidenceMode: z.literal('authorized_live_synthetic_layout_recovery'),
  evidenceBoundary: z.string().min(1),
  realChildData: z.literal(false),
  generatedAt: z.string().datetime(),
  providerCalls: z.number().int().nonnegative(),
  observedCostUsd: z.number().nonnegative(),
  accountedCostUsd: z.number().nonnegative(),
  maxSpendUsd: z.number().positive().max(5),
  source: z.object({
    m0Sha256: HashSchema,
    m1BrowserSha256: HashSchema,
    layoutFeedbackSha256: HashSchema,
    failureRows: z.literal(31),
  }).strict(),
  budget: z.unknown(),
  decision: z.object({
    stage: z.literal('complete'),
    winner: z.enum(['medium_escalation', 'targeted_correction', 'correction_then_escalation']).nullable(),
    attempts: z.object({
      medium_escalation: z.number().int().nonnegative(),
      targeted_correction: z.number().int().nonnegative(),
    }).strict(),
    judgeCalls: z.number().int().nonnegative(),
    summaries: z.object({
      medium_escalation: SummarySchema,
      targeted_correction: SummarySchema,
      correction_then_escalation: SummarySchema,
    }).strict(),
    canary: z.object({
      passed: z.literal(true),
      intents: z.literal(3),
      providerCalls: z.number().int().max(4),
      sourceKeys: z.array(z.string().min(1)).length(3),
    }).strict(),
    rows: z.array(DecisionRowSchema).length(31),
  }).strict(),
  spendLedger: z.object({
    schemaVersion: z.literal('1.0.0'),
    runId: z.string().min(1),
    maxSpendUsd: z.number().positive(),
    providerCalls: z.number().int().nonnegative(),
    observedCostUsd: z.number().nonnegative(),
    accountedCostUsd: z.number().nonnegative(),
    openReservationUsd: z.literal(0),
    entries: z.array(SpendEventSchema),
  }).strict(),
}).strict();

export function compileLiveLayoutRecoveryEvidence(rawJson: string) {
  const resultSha256 = sha256(rawJson);
  if (resultSha256 !== manifest.resultSha256) {
    throw new Error('F9 live result SHA-256 does not match the evidence manifest.');
  }
  const report = ReportSchema.parse(JSON.parse(rawJson));
  requireEvidence(report.source.m0Sha256 === manifest.sourceEvidenceSha256 &&
    report.source.m0Sha256 === F9_LAYOUT_RECOVERY_POLICY.sourceEvidenceSha256,
  'F9 live result has the wrong M0 source hash.');
  requireEvidence(report.source.m1BrowserSha256 === manifest.m1BrowserObservationSha256 &&
    report.source.m1BrowserSha256 === F9_LAYOUT_RECOVERY_POLICY.m1BrowserObservationSha256,
  'F9 live result has the wrong M1 browser hash.');
  requireEvidence(report.source.layoutFeedbackSha256 === manifest.layoutFeedbackSha256 &&
    report.source.layoutFeedbackSha256 === F9_LAYOUT_RECOVERY_POLICY.layoutFeedbackSha256,
  'F9 live result has the wrong layout-feedback hash.');
  const expectedBudget = layoutRecoveryBudgetPlan({ failureCount: 31, gradeRecoverySample: true });
  requireEvidence(isDeepStrictEqual(report.budget, expectedBudget),
    'F9 live result changed its conservative budget plan.');
  requireEvidence(new Set(report.decision.rows.map((row) => row.sourceKey)).size === 31,
    'F9 live result duplicates a failure row.');
  requireEvidence(new Set(report.decision.canary.sourceKeys.map((key) => key.split(':', 1)[0])).size === 3,
    'F9 canary does not contain three distinct intents.');

  const medium = summarize(report.decision.rows.map((row) => row.medium));
  const correction = summarize(report.decision.rows.map((row) => row.correction));
  const chain = summarize(report.decision.rows.map((row) => row.correction.valid ? row.correction : row.medium));
  requireEvidence(isDeepStrictEqual(report.decision.summaries, {
    medium_escalation: medium,
    targeted_correction: correction,
    correction_then_escalation: chain,
  }), 'F9 live summaries do not reconstruct from row evidence.');
  const expectedWinner = correction.qualifies
    ? 'targeted_correction'
    : medium.qualifies
      ? 'medium_escalation'
      : chain.qualifies
        ? 'correction_then_escalation'
        : null;
  requireEvidence(report.decision.winner === expectedWinner && expectedWinner === manifest.winner,
    'F9 live winner does not follow the cheapest qualifying arm rule.');
  requireEvidence(report.decision.attempts.medium_escalation === medium.attempted &&
    report.decision.attempts.targeted_correction === correction.attempted,
  'F9 live attempt counts do not match rows.');
  requireEvidence(report.decision.rows.every((row) =>
    row.chainRecovered === (row.correction.valid || row.medium.valid)),
  'F9 chain outcomes do not reconstruct from paired arms.');

  verifySpendLedger(report.spendLedger);
  requireEvidence(report.providerCalls === report.spendLedger.providerCalls &&
    report.providerCalls === medium.attempted + correction.attempted + report.decision.judgeCalls &&
    report.providerCalls === manifest.providerCalls,
  'F9 provider-call totals do not reconcile.');
  requireEvidence(close(report.observedCostUsd, report.spendLedger.observedCostUsd) &&
    close(report.accountedCostUsd, report.spendLedger.accountedCostUsd) &&
    close(report.accountedCostUsd, manifest.accountedCostUsd) &&
    close(report.maxSpendUsd, manifest.maxSpendUsd),
  'F9 cost totals do not reconcile.');
  requireEvidence(report.accountedCostUsd < report.maxSpendUsd,
    'F9 spend has no headroom.');
  return {
    resultSha256,
    providerCalls: report.providerCalls,
    accountedCostUsd: report.accountedCostUsd,
    headroomUsd: round(report.maxSpendUsd - report.accountedCostUsd, 7),
    winner: report.decision.winner,
    medium,
    correction,
    chain,
  };
}

function summarize(outcomes: Array<z.infer<typeof ArmOutcomeSchema>>) {
  const attempted = outcomes.filter((outcome) => outcome.attempted).length;
  const recovered = outcomes.filter((outcome) => outcome.valid).length;
  const grades = outcomes.flatMap((outcome) => outcome.valid && outcome.gradeValid && outcome.grade !== null ? [outcome.grade] : []);
  const requiredGradeRows = Math.min(F9_QUALITY_SAMPLE_PER_ARM, recovered);
  const meanGrade = round(mean(grades), 4);
  return {
    attempted,
    recovered,
    delivered: F9_LAYOUT_RECOVERY_POLICY.baseDelivered + recovered,
    deliveredValidity: round((F9_LAYOUT_RECOVERY_POLICY.baseDelivered + recovered) / F9_LAYOUT_RECOVERY_POLICY.totalRows, 6),
    meanGrade,
    gradedRows: grades.length,
    requiredGradeRows,
    qualityEvidenceComplete: grades.length === requiredGradeRows,
    qualifies: recovered >= manifest.minimumRecoveries &&
      grades.length === requiredGradeRows && meanGrade >= manifest.qualityFloor,
  };
}

function verifySpendLedger(ledger: z.infer<typeof ReportSchema>['spendLedger']): void {
  const calls = new Map<string, z.infer<typeof SpendEventSchema>[] >();
  let startedCalls = 0;
  for (const [index, event] of ledger.entries.entries()) {
    requireEvidence(event.sequence === index + 1 && event.runId === ledger.runId,
      'F9 spend ledger sequence or run id is invalid.');
    calls.set(event.callId, [...(calls.get(event.callId) ?? []), event]);
    if (event.status === 'started') startedCalls += event.providerCallCount;
  }
  for (const events of calls.values()) {
    requireEvidence(events.length === 3 && events[0].status === 'reserved' &&
      events[1].status === 'started' && ['completed', 'failed'].includes(events[2].status),
    'F9 spend ledger has an invalid call transition.');
    requireEvidence(events[1].providerCallCount === 1 && events[2].providerCallCount === 1,
      'F9 spend ledger call count is invalid.');
    requireEvidence(events[2].upperBoundUsd <= events[0].reserveUsd + 1e-9,
      'F9 spend ledger exceeded a reservation.');
  }
  const final = ledger.entries.at(-1);
  requireEvidence(Boolean(final) && final?.openReservationUsd === 0 &&
    final?.cumulativeProviderCalls === ledger.providerCalls &&
    close(final?.cumulativeObservedCostUsd ?? -1, ledger.observedCostUsd) &&
    close(final?.cumulativeAccountedCostUsd ?? -1, ledger.accountedCostUsd),
  'F9 spend ledger final totals are invalid.');
  requireEvidence(startedCalls === ledger.providerCalls && ledger.providerCalls <= 90,
    'F9 spend ledger exceeds or miscounts the call ceiling.');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-8;
}
function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
