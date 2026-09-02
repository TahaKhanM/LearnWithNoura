import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { parseDirectorStreamProposal } from '../directorStreamSchema.js';
import { loadDirectorEvalCorpus } from './corpus.js';
import { compileFirstPaintReplayEvidence } from './firstPaintReplay.js';
import { compileLiveLayoutRecoveryEvidence } from './layoutRecoveryEvidence.js';
import { compileM1PipelineStudyEvidence } from './m1PipelineStudyEvidence.js';
import manifestJson from './fixtures/m1-corrected-acceptance-manifest.json' with { type: 'json' };

const SourceTrialSchema = z.object({
  intentId: z.string(),
  conditionId: z.string(),
  cacheState: z.enum(['cold', 'warm']),
  trial: z.number().int(),
  strictSchemaValid: z.boolean(),
  storyboardCoverage: z.boolean(),
  proposalText: z.string(),
}).passthrough();
const SourceSchema = z.object({ trials: z.array(SourceTrialSchema) }).passthrough();
const ManifestSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  resultPath: z.string().min(1),
  resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
  accepted: z.literal(true),
  gates: z.tuple([z.literal('G1'), z.literal('G2'), z.literal('G3'), z.literal('G4'), z.literal('G5')]),
}).strict();
const manifest = ManifestSchema.parse(manifestJson);
const StoredAcceptanceSchema = z.object({
  generatedAt: z.string().datetime(),
  accepted: z.boolean(),
  evidence: z.object({
    verificationGates: z.array(z.object({ command: z.string().min(1), exitCode: z.number().int() }).strict()).length(19),
  }).passthrough(),
}).passthrough();

export interface CorrectedM1AcceptanceInput {
  sourceRawJson: string;
  browserObservationRawJson: string;
  m1ReportRawJson: string;
  recoveryRawJson: string;
  firstPaintRawJson: string;
  verificationGates: Array<{ command: string; exitCode: number }>;
  generatedAt: string;
}

export function computeCorrectedM1Acceptance(input: CorrectedM1AcceptanceInput) {
  const m1 = compileM1PipelineStudyEvidence(
    input.sourceRawJson,
    input.browserObservationRawJson,
    input.m1ReportRawJson,
  );
  const recovery = compileLiveLayoutRecoveryEvidence(input.recoveryRawJson);
  const firstPaint = compileFirstPaintReplayEvidence(input.firstPaintRawJson);
  const source = SourceSchema.parse(JSON.parse(input.sourceRawJson));
  const intents = new Map(loadDirectorEvalCorpus().map((intent) => [intent.id, intent]));
  const terraLow = source.trials.filter((row) => row.conditionId === 'terra-low');
  const structured = terraLow.filter((row) => {
    const intent = intents.get(row.intentId);
    if (!intent || !row.strictSchemaValid || !row.storyboardCoverage) return false;
    try {
      parseDirectorStreamProposal(row.proposalText, intent.density);
      return true;
    } catch {
      return false;
    }
  }).length;
  const g1Rate = round(structured / terraLow.length, 6);
  const g2Numerator = m1.report.summary.all.candidateAccepted;
  const g2Denominator = m1.report.summary.all.rows;
  const g2Rate = round(g2Numerator / g2Denominator, 6);
  const g3Numerator = recovery.medium.delivered;
  const g3Denominator = 360;
  const g3Rate = recovery.medium.deliveredValidity;
  const failedCommands = input.verificationGates.filter((gate) => gate.exitCode !== 0).map((gate) => gate.command);
  const gates = {
    G1: {
      name: 'structured_single_shot_validity',
      numerator: structured,
      denominator: terraLow.length,
      rate: g1Rate,
      threshold: 0.95,
      passed: terraLow.length === 360 && g1Rate >= 0.95,
    },
    G2: {
      name: 'production_authority_conjunctive_first_pass',
      numerator: g2Numerator,
      denominator: g2Denominator,
      rate: g2Rate,
      threshold: 0.9,
      passed: g2Denominator === 360 && g2Rate >= 0.9,
    },
    G3: {
      name: 'delivered_scene_recovery',
      numerator: g3Numerator,
      denominator: g3Denominator,
      rate: g3Rate,
      threshold: 0.97,
      recoveryDefault: recovery.winner,
      meanBlindGrade: recovery.medium.meanGrade,
      passed: g3Rate >= 0.97 && recovery.medium.qualifies && recovery.winner === 'medium_escalation',
    },
    G4: {
      name: 'actual_lesson_ops_presented_first_paint',
      pairedRows: firstPaint.pairedRows,
      streamingP50Ms: firstPaint.summary.streaming.p50FirstPaintMs,
      classicP50Ms: firstPaint.summary.classic.p50FirstPaintMs,
      p50Cut: firstPaint.summary.p50Cut,
      maximumStreamingP50Ms: 4_000,
      minimumP50Cut: 0.4,
      passed: firstPaint.summary.accepted,
    },
    G5: {
      name: 'permanence_replay_and_readme_gates',
      commands: input.verificationGates.length,
      failedCommands,
      passed: input.verificationGates.length === 19 && failedCommands.length === 0,
    },
  };
  return {
    schemaVersion: '1.0.0' as const,
    evidenceMode: 'corrected_layered_m1_acceptance' as const,
    correctedGateSource: 'docs/architecture/2026-09-01-drawing-vnext-m1-acceptance-and-continuation-prompt.md',
    generatedAt: input.generatedAt,
    accepted: Object.values(gates).every((gate) => gate.passed),
    gates,
    evidence: {
      m0SourceSha256: m1.sourceSha256,
      m1BrowserObservationSha256: m1.browserObservationSha256,
      m1PairedReportSha256: m1.resultSha256,
      f9RecoveryResultSha256: recovery.resultSha256,
      g4FirstPaintResultSha256: firstPaint.resultSha256,
      screenshots: firstPaint.screenshots,
      newProviderSpend: {
        authorizedCapUsd: 3.25,
        accountedCostUsd: recovery.accountedCostUsd,
        headroomUsd: recovery.headroomUsd,
        providerCalls: recovery.providerCalls,
      },
      verificationGates: input.verificationGates,
    },
  };
}

export function compileCorrectedM1AcceptanceEvidence(
  input: Omit<CorrectedM1AcceptanceInput, 'verificationGates' | 'generatedAt'> & { resultRawJson: string },
) {
  const resultSha256 = createHash('sha256').update(input.resultRawJson).digest('hex');
  if (resultSha256 !== manifest.resultSha256) {
    throw new Error('Corrected M1 acceptance SHA-256 does not match the evidence manifest.');
  }
  const stored = StoredAcceptanceSchema.parse(JSON.parse(input.resultRawJson));
  const recomputed = computeCorrectedM1Acceptance({
    sourceRawJson: input.sourceRawJson,
    browserObservationRawJson: input.browserObservationRawJson,
    m1ReportRawJson: input.m1ReportRawJson,
    recoveryRawJson: input.recoveryRawJson,
    firstPaintRawJson: input.firstPaintRawJson,
    verificationGates: stored.evidence.verificationGates,
    generatedAt: stored.generatedAt,
  });
  if (!isDeepStrictEqual(JSON.parse(input.resultRawJson), recomputed) || !recomputed.accepted) {
    throw new Error('Corrected M1 acceptance does not reproduce from immutable evidence.');
  }
  return { resultSha256, report: recomputed };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
