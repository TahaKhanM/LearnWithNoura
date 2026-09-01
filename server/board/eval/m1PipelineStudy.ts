import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BoardOp } from '../../../shared/boardOps.js';
import { IncrementalDirectorStreamParser } from '../directorStreamParser.js';
import { parseDirectorStreamProposal } from '../directorStreamSchema.js';
import { loadDirectorEvalCorpus } from './corpus.js';
import {
  M1BrowserObservationArtifactSchema,
  M1_PIPELINE_STUDY_POLICY,
  M1PipelineStudyPolicySchema,
  M1PipelineStudyReportSchema,
  type M1BrowserObservationArtifact,
  type M1BrowserObservationRow,
  type M1PipelineStudyHarness,
  type M1PipelineStudyPolicy,
  type M1PipelineStudyReport,
  type M1PipelineStudyRow,
  type M1PipelineStudySummary,
} from './m1PipelineStudyTypes.js';
export {
  M1BrowserObservationArtifactSchema,
  M1_PIPELINE_STUDY_POLICY,
  M1PipelineStudyPolicySchema,
  M1PipelineStudyReportSchema,
} from './m1PipelineStudyTypes.js';

const SourceTrialSchema = z.object({
  intentId: z.string().min(1).max(80),
  split: z.enum(['representative', 'holdout']),
  conditionId: z.string(),
  cacheState: z.enum(['cold', 'warm']),
  trial: z.number().int().min(1).max(5),
  firstValidOpMs: z.number().int().nonnegative().nullable(),
  firstStepStatus: z.enum(['valid', 'invalid', 'missing']),
  completeSceneMs: z.number().int().nonnegative(),
  strictSchemaValid: z.boolean(),
  validatorPassed: z.boolean(),
  storyboardCoverage: z.boolean(),
  qualitySampled: z.boolean(),
  qualityGrade: z.number().min(1).max(5).nullable(),
  qualityEvidenceComplete: z.boolean(),
  proposalText: z.string(),
}).passthrough();
type SourceTrial = z.infer<typeof SourceTrialSchema>;
const SourceReportSchema = z.object({
  evidenceMode: z.literal('authorized_live_synthetic'),
  corpus: z.object({
    representative: z.literal(24), holdout: z.literal(12), total: z.literal(36),
  }).passthrough(),
  trials: z.array(SourceTrialSchema),
}).passthrough();

/** Collects raw browser facts only. Both arms receive the exact same proposal;
 * this is a paired delivery-path comparison, never a generator/model A/B. */
export async function collectM1BrowserObservations(input: {
  sourceRawJson: string;
  harness: M1PipelineStudyHarness;
  policy?: M1PipelineStudyPolicy;
}): Promise<M1BrowserObservationArtifact> {
  const policy = M1PipelineStudyPolicySchema.parse(input.policy ?? M1_PIPELINE_STUDY_POLICY);
  const { selected, intentById } = verifiedSource(input.sourceRawJson, policy);
  let fullScenePreflights = 0;
  let cumulativePreflights = 0;
  let rasterRenders = 0;
  const rows: M1BrowserObservationRow[] = [];
  for (const trial of selected) {
    const intent = intentById.get(trial.intentId)!;
    const route = policy.diagramCategories.includes(intent.category)
      ? 'streaming_diagram' as const
      : 'classic_illustration' as const;
    const existingOps = intent.existingBoardOps ?? [];
    const visibleObjectIds = existingOps.flatMap((op) => op.op === 'add' ? [op.id] : []);
    const atomicProposal = parseDirectorStreamProposal(trial.proposalText, intent.density);
    const expectedRepresentation = route === 'streaming_diagram' ? 'diagram' : 'illustration';
    if (atomicProposal.representation !== expectedRepresentation) {
      throw new Error(`M1 route for ${trial.intentId} expected ${expectedRepresentation}.`);
    }
    const atomicOps = atomicProposal.ops as BoardOp[];
    fullScenePreflights += 1;
    const atomicVerdict = await input.harness.validate([...existingOps, ...atomicOps]);

    let streamedOps = atomicOps;
    const cumulativeVerdicts: M1BrowserObservationRow['streamed']['cumulativeVerdicts'] = [];
    if (route === 'streaming_diagram') {
      const parser = new IncrementalDirectorStreamParser({ density: intent.density, visibleObjectIds });
      const cumulative: BoardOp[] = [];
      for (const chunk of deterministicChunks(trial.proposalText, sourceKey(trial))) {
        for (const step of parser.push(chunk)) {
          cumulative.push(...step.ops);
          cumulativePreflights += 1;
          const verdict = await input.harness.validate([...existingOps, ...cumulative]);
          cumulativeVerdicts.push({
            stepIndex: step.index,
            stepId: step.step.id,
            accepted: verdict.ok,
            reasons: verdict.ok ? [] : verdict.issues,
            opsSha256: opsHash([...existingOps, ...cumulative]),
          });
        }
      }
      streamedOps = parser.finish().ops as BoardOp[];
    }
    const semanticGroupId = `m1-eval-${trial.intentId}`;
    rasterRenders += 2;
    const [atomicRaster, streamedRaster] = await Promise.all([
      input.harness.render([...existingOps, ...atomicOps], semanticGroupId),
      input.harness.render([...existingOps, ...streamedOps], semanticGroupId),
    ]);
    if (!atomicRaster || !streamedRaster) {
      throw new Error(`Browser rasterization failed for paired row ${sourceKey(trial)}.`);
    }
    const streamedAccepted = route === 'classic_illustration'
      ? atomicVerdict.ok
      : cumulativeVerdicts.length > 0 && cumulativeVerdicts.every((verdict) => verdict.accepted);
    rows.push({
      sourceKey: sourceKey(trial),
      intentId: trial.intentId,
      split: trial.split,
      category: intent.category,
      cacheState: trial.cacheState,
      trial: trial.trial,
      route,
      proposalSha256: sha256(trial.proposalText),
      atomic: {
        accepted: atomicVerdict.ok,
        reasons: atomicVerdict.ok ? [] : atomicVerdict.issues,
        opsSha256: opsHash([...existingOps, ...atomicOps]),
        rasterSha256: sha256(atomicRaster),
      },
      streamed: {
        accepted: streamedAccepted,
        reasons: route === 'classic_illustration'
          ? atomicVerdict.ok ? [] : atomicVerdict.issues
          : cumulativeVerdicts.flatMap((verdict) => verdict.accepted ? [] : verdict.reasons),
        opsSha256: opsHash([...existingOps, ...streamedOps]),
        rasterSha256: sha256(streamedRaster),
        cumulativeVerdicts,
      },
    });
  }
  rows.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
  const browserState = input.harness.browserState();
  if (browserState.externalRequestCount !== 0 ||
      browserState.finalOrigin !== input.harness.origin ||
      browserState.finalPath !== input.harness.path) {
    throw new Error('Local browser isolation or final harness location changed during M1 replay.');
  }
  return M1BrowserObservationArtifactSchema.parse({
    schemaVersion: '1.0.0',
    evidenceMode: 'offline_local_browser_delivery_path_observations',
    studyKind: 'paired_delivery_path_same_proposal',
    providerCalls: 0,
    runtimeCostUsd: 0,
    source: {
      path: policy.sourceEvidencePath,
      sha256: policy.sourceEvidenceSha256,
      conditionId: policy.conditionId,
      rows: 360,
    },
    browserHarness: {
      origin: input.harness.origin,
      path: input.harness.path,
      finalOrigin: browserState.finalOrigin,
      finalPath: browserState.finalPath,
      engine: 'chromium',
      externalRequestCount: 0,
      fullScenePreflights,
      cumulativePreflights,
      rasterRenders,
    },
    rows,
  });
}

export function runM1PipelineStudy(input: {
  sourceRawJson: string;
  browserObservationRawJson: string;
  generatedAt?: string;
  policy?: M1PipelineStudyPolicy;
}): M1PipelineStudyReport {
  const policy = M1PipelineStudyPolicySchema.parse(input.policy ?? M1_PIPELINE_STUDY_POLICY);
  const { selected } = verifiedSource(input.sourceRawJson, policy);
  const observationSha256 = sha256(input.browserObservationRawJson);
  if (observationSha256 !== policy.browserObservationSha256) {
    throw new Error('M1 browser-observation SHA-256 does not match the pinned policy.');
  }
  const observations = M1BrowserObservationArtifactSchema.parse(
    JSON.parse(input.browserObservationRawJson),
  );
  if (observations.source.sha256 !== policy.sourceEvidenceSha256 ||
      observations.browserHarness.externalRequestCount !== 0) {
    throw new Error('M1 browser observations do not bind to the isolated pinned source.');
  }
  const observationByKey = new Map(observations.rows.map((row) => [row.sourceKey, row]));
  const rows = selected.map((trial): M1PipelineStudyRow => {
    const observation = observationByKey.get(sourceKey(trial));
    if (!observation) throw new Error(`M1 browser observations omit ${sourceKey(trial)}.`);
    const exactOpsParity = observation.atomic.opsSha256 === observation.streamed.opsSha256;
    const exactRasterParity = observation.atomic.rasterSha256 === observation.streamed.rasterSha256;
    const qualityEvidenceReused = trial.qualityEvidenceComplete && trial.qualityGrade !== null &&
      exactOpsParity && exactRasterParity;
    return {
      sourceKey: sourceKey(trial),
      intentId: trial.intentId,
      split: trial.split,
      category: observation.category,
      cacheState: trial.cacheState,
      trial: trial.trial,
      route: observation.route,
      sourceFirstPassAccepted: sourceAccepted(trial),
      atomicAccepted: observation.atomic.accepted,
      candidateAccepted: observation.streamed.accepted,
      cumulativeVerdictCount: observation.streamed.cumulativeVerdicts.length,
      exactOpsParity,
      exactRasterParity,
      firstValidOpMs: trial.firstValidOpMs,
      completeSceneMs: trial.completeSceneMs,
      qualitySampled: trial.qualitySampled,
      qualityGrade: trial.qualityGrade,
      sourceQualityEvidenceComplete: trial.qualityEvidenceComplete,
      qualityEvidenceReused,
    };
  }).sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
  const summary = summarizeM1PipelineStudyRows(rows, policy);
  return M1PipelineStudyReportSchema.parse({
    schemaVersion: '1.1.0',
    pass: summary.m1AcceptancePass,
    evidenceMode: 'offline_paired_delivery_path_ab',
    studyKind: 'paired_delivery_path_same_proposal',
    generatorModelComparison: false,
    evidenceBoundary: 'This paired A/B replays each identical M0 proposal through atomic and streamed delivery. It measures delivery-path validity, final parity, and conservative provider-critical-path readiness only; it does not compare generators/models and does not prove ops_presented UI first paint.',
    realChildData: false,
    providerCalls: 0,
    runtimeCostUsd: 0,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    source: {
      path: policy.sourceEvidencePath,
      sha256: policy.sourceEvidenceSha256,
      conditionId: policy.conditionId,
      rows: 360,
    },
    browserObservations: {
      path: policy.browserObservationPath,
      sha256: observationSha256,
      rows: 360,
      externalRequestCount: observations.browserHarness.externalRequestCount,
    },
    policy,
    summary,
    rows,
  });
}

export function summarizeM1PipelineStudyRows(
  rows: M1PipelineStudyRow[],
  policy: M1PipelineStudyPolicy = M1_PIPELINE_STUDY_POLICY,
): M1PipelineStudySummary {
  const diagrams = rows.filter((row) => row.route === 'streaming_diagram');
  const illustrations = rows.filter((row) => row.route === 'classic_illustration');
  const representativeDiagrams = diagrams.filter((row) => row.split === 'representative');
  const holdoutDiagrams = diagrams.filter((row) => row.split === 'holdout');
  const sourceQualityRows = rows.filter((row) => row.sourceQualityEvidenceComplete);
  const reusedQualityRows = sourceQualityRows.filter((row) => row.qualityEvidenceReused);
  const qualityMean = round(mean(reusedQualityRows.map((row) => row.qualityGrade!)), 4);
  const diagramSummary = cohort(diagrams);
  const quality = {
    expectedSourceRows: policy.expectedSourceQualityEvidenceCompleteRows,
    sourceRows: sourceQualityRows.length,
    reusedRows: reusedQualityRows.length,
    atomicMeanGrade: qualityMean,
    candidateMeanGrade: qualityMean,
    absoluteGradeDelta: 0,
    completeNonAttritingReuse: sourceQualityRows.length === policy.expectedSourceQualityEvidenceCompleteRows &&
      reusedQualityRows.length === sourceQualityRows.length,
  };
  const diagramValidityWithinTolerance = diagramSummary.validityDropPercentagePoints <=
    policy.maximumDiagramValidityDropPercentagePoints;
  const qualityWithinTolerance = quality.completeNonAttritingReuse &&
    quality.absoluteGradeDelta <= policy.maximumAbsoluteQualityGradeDelta;
  const readiness = readinessCohort(diagrams);
  const providerCriticalPathReadinessCutMet = readiness.rows > 0 &&
    readiness.providerCriticalPathReadinessCut >= policy.minimumProviderCriticalPathReadinessCut;
  const selectedRevealPolicy = diagramValidityWithinTolerance && qualityWithinTolerance
    ? 'each_validated_step' as const
    : 'reveal_after_2_steps_requires_readiness_evidence' as const;
  return {
    all: cohort(rows),
    diagrams: diagramSummary,
    illustrations: cohort(illustrations),
    representativeDiagrams: cohort(representativeDiagrams),
    holdoutDiagrams: cohort(holdoutDiagrams),
    readiness,
    representativeReadiness: readinessCohort(representativeDiagrams),
    holdoutReadiness: readinessCohort(holdoutDiagrams),
    quality,
    diagramValidityWithinTolerance,
    absoluteFirstPassValidityGateMet: cohort(rows).candidateValidity >=
      policy.minimumAbsoluteFirstPassValidity,
    qualityWithinTolerance,
    providerCriticalPathReadinessCutMet,
    selectedRevealPolicy,
    actualUiFirstPaintAcceptance: 'requires_separate_ops_presented_evidence',
    deliveryPathStudyPass: selectedRevealPolicy === 'each_validated_step' &&
      providerCriticalPathReadinessCutMet,
    m1AcceptancePass: selectedRevealPolicy === 'each_validated_step' &&
      providerCriticalPathReadinessCutMet &&
      cohort(rows).candidateValidity >= policy.minimumAbsoluteFirstPassValidity,
  };
}

function verifiedSource(raw: string, policy: M1PipelineStudyPolicy) {
  if (sha256(raw) !== policy.sourceEvidenceSha256) {
    throw new Error('M1 study source SHA-256 does not match the pinned M0 evidence.');
  }
  const source = SourceReportSchema.parse(JSON.parse(raw));
  const corpus = loadDirectorEvalCorpus();
  const intentById = new Map(corpus.map((intent) => [intent.id, intent]));
  const selected = source.trials.filter((trial) => trial.conditionId === policy.conditionId);
  assertCompleteMatrix(selected, corpus.map((intent) => intent.id));
  return { selected, intentById };
}

function assertCompleteMatrix(trials: SourceTrial[], intentIds: string[]): void {
  if (trials.length !== 360) throw new Error(`M1 study requires 360 Terra-low rows; found ${trials.length}.`);
  const expected = new Set(intentIds.flatMap((intentId) =>
    (['cold', 'warm'] as const).flatMap((cacheState) =>
      Array.from({ length: 5 }, (_, index) => `${intentId}:terra-low:${cacheState}:${index + 1}`))));
  const actual = new Set(trials.map(sourceKey));
  if (actual.size !== 360 || [...expected].some((key) => !actual.has(key))) {
    throw new Error('M1 source is missing or duplicates a required corpus cell.');
  }
}

function cohort(rows: M1PipelineStudyRow[]) {
  const atomicAccepted = rows.filter((row) => row.atomicAccepted).length;
  const candidateAccepted = rows.filter((row) => row.candidateAccepted).length;
  const atomicValidity = ratio(atomicAccepted, rows.length);
  const candidateValidity = ratio(candidateAccepted, rows.length);
  return {
    rows: rows.length, atomicAccepted, candidateAccepted, atomicValidity, candidateValidity,
    validityDropPercentagePoints: round((atomicValidity - candidateValidity) * 100, 4),
  };
}

function readinessCohort(rows: M1PipelineStudyRow[]) {
  const paired = rows.filter((row) =>
    row.atomicAccepted && row.candidateAccepted && row.firstValidOpMs !== null);
  const streamed = percentile(paired.map((row) => row.firstValidOpMs!), 0.5);
  const atomic = percentile(paired.map((row) => row.completeSceneMs), 0.5);
  return {
    rows: paired.length,
    p50StreamedFirstValidatedStepReadyMs: streamed,
    p50AtomicProposalCompleteMs: atomic,
    providerCriticalPathReadinessCut: atomic === 0 ? 0 : round(1 - streamed / atomic, 6),
  };
}

function sourceAccepted(trial: SourceTrial): boolean {
  return trial.firstStepStatus === 'valid' && trial.strictSchemaValid &&
    trial.validatorPassed && trial.storyboardCoverage;
}
function sourceKey(trial: Pick<SourceTrial, 'intentId' | 'cacheState' | 'trial'>): string {
  return `${trial.intentId}:terra-low:${trial.cacheState}:${trial.trial}`;
}
function deterministicChunks(text: string, key: string): string[] {
  const chunks: string[] = [];
  let cursor = 0;
  let seed = Number.parseInt(sha256(key).slice(0, 8), 16);
  while (cursor < text.length) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const size = 1 + seed % 37;
    chunks.push(text.slice(cursor, cursor + size));
    cursor += size;
  }
  return chunks;
}
function opsHash(ops: BoardOp[]): string { return sha256(JSON.stringify(ops)); }
export function m1EvidenceSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
const sha256 = m1EvidenceSha256;
function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] ?? 0;
}
function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator, 6);
}
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
