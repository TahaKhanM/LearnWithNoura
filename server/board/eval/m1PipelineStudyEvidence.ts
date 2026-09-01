import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { BoardOp } from '../../../shared/boardOps.js';
import { IncrementalDirectorStreamParser } from '../directorStreamParser.js';
import { parseDirectorStreamProposal } from '../directorStreamSchema.js';
import { loadDirectorEvalCorpus } from './corpus.js';
import {
  M1BrowserObservationArtifactSchema,
  M1_PIPELINE_STUDY_POLICY,
  M1PipelineStudyReportSchema,
  m1EvidenceSha256,
  runM1PipelineStudy,
} from './m1PipelineStudy.js';
import type { M1PipelineStudyReport } from './m1PipelineStudyTypes.js';

const SourceTrialSchema = z.object({
  intentId: z.string(),
  split: z.enum(['representative', 'holdout']),
  conditionId: z.string(),
  cacheState: z.enum(['cold', 'warm']),
  trial: z.number().int(),
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
const SourceSchema = z.object({ trials: z.array(SourceTrialSchema) }).passthrough();

export interface M1PipelineStudyEvidence {
  report: M1PipelineStudyReport;
  sourceSha256: string;
  browserObservationSha256: string;
  resultSha256: string;
}

/** Verifies two independent evidence layers: immutable raw browser facts and
 * a deterministic report derived from those facts plus the pinned M0 rows. */
export function compileM1PipelineStudyEvidence(
  sourceRawJson: string,
  browserObservationRawJson: string,
  resultRawJson: string,
): M1PipelineStudyEvidence {
  const sourceSha256 = m1EvidenceSha256(sourceRawJson);
  const browserObservationSha256 = m1EvidenceSha256(browserObservationRawJson);
  requireEvidence(sourceSha256 === M1_PIPELINE_STUDY_POLICY.sourceEvidenceSha256,
    'M1 source SHA-256 does not match the pinned M0 evidence.');
  requireEvidence(browserObservationSha256 === M1_PIPELINE_STUDY_POLICY.browserObservationSha256,
    'M1 raw browser-observation SHA-256 does not match the pinned policy.');

  const source = SourceSchema.parse(JSON.parse(sourceRawJson));
  const sourceTrials = source.trials.filter((trial) => trial.conditionId === 'terra-low');
  requireEvidence(sourceTrials.length === 360, 'Pinned M0 source no longer has 360 Terra-low rows.');
  const sourceByKey = uniqueByKey(sourceTrials, sourceKey, 'M0 source');
  const observations = M1BrowserObservationArtifactSchema.parse(
    JSON.parse(browserObservationRawJson),
  );
  requireEvidence(observations.providerCalls === 0 && observations.runtimeCostUsd === 0,
    'M1 browser observations must remain zero-provider and zero-cost.');
  requireEvidence(
    observations.source.path === M1_PIPELINE_STUDY_POLICY.sourceEvidencePath &&
      observations.source.sha256 === sourceSha256 && observations.source.conditionId === 'terra-low',
    'M1 browser observations are not bound to the pinned M0 source.');
  verifyLocalHarness(observations.browserHarness);

  const observationByKey = uniqueByKey(
    observations.rows, (row) => row.sourceKey, 'browser observations',
  );
  requireEvidence(observationByKey.size === sourceByKey.size &&
    [...sourceByKey.keys()].every((key) => observationByKey.has(key)),
  'M1 browser observations do not contain the complete source matrix.');
  const corpusById = new Map(loadDirectorEvalCorpus().map((intent) => [intent.id, intent]));
  let cumulativePreflights = 0;
  for (const [key, trial] of sourceByKey) {
    const observation = observationByKey.get(key)!;
    const intent = corpusById.get(trial.intentId);
    requireEvidence(Boolean(intent), `M1 evidence references unknown intent ${trial.intentId}.`);
    if (!intent) continue;
    requireEvidence(
      observation.intentId === trial.intentId && observation.split === trial.split &&
      observation.cacheState === trial.cacheState && observation.trial === trial.trial &&
      observation.category === intent.category,
      `Browser observation ${key} changed its source identity.`,
    );
    const expectedRoute = M1_PIPELINE_STUDY_POLICY.diagramCategories.includes(intent.category)
      ? 'streaming_diagram' as const
      : 'classic_illustration' as const;
    requireEvidence(observation.route === expectedRoute,
      `Browser observation ${key} uses the wrong delivery route.`);
    requireEvidence(observation.proposalSha256 === m1EvidenceSha256(trial.proposalText),
      `Browser observation ${key} proposal hash differs from M0.`);
    const proposal = parseDirectorStreamProposal(trial.proposalText, intent.density);
    const expectedRepresentation = expectedRoute === 'streaming_diagram' ? 'diagram' : 'illustration';
    requireEvidence(proposal.representation === expectedRepresentation,
      `Browser observation ${key} route disagrees with proposal representation.`);
    const existingOps = intent.existingBoardOps ?? [];
    const combined = [...existingOps, ...(proposal.ops as BoardOp[])];
    const fullOpsHash = opsHash(combined);
    requireEvidence(observation.atomic.opsSha256 === fullOpsHash &&
      observation.streamed.opsSha256 === fullOpsHash,
    `Browser observation ${key} final operation hashes are not source-reproducible.`);
    requireEvidence(observation.atomic.accepted === (observation.atomic.reasons.length === 0),
      `Browser observation ${key} atomic verdict/reasons disagree.`);
    if (expectedRoute === 'classic_illustration') {
      requireEvidence(
        observation.streamed.cumulativeVerdicts.length === 0 &&
        observation.streamed.accepted === observation.atomic.accepted &&
        isDeepStrictEqual(observation.streamed.reasons, observation.atomic.reasons),
        `Illustration observation ${key} did not remain on the paired atomic fallback.`,
      );
    } else {
      const visibleObjectIds = existingOps.flatMap((op) => op.op === 'add' ? [op.id] : []);
      const parser = new IncrementalDirectorStreamParser({ density: intent.density, visibleObjectIds });
      const parsedSteps = parser.push(trial.proposalText);
      parser.finish();
      requireEvidence(observation.streamed.cumulativeVerdicts.length === parsedSteps.length,
        `Browser observation ${key} omitted a cumulative step verdict.`);
      const cumulative: BoardOp[] = [];
      for (const [index, step] of parsedSteps.entries()) {
        cumulative.push(...step.ops);
        const verdict = observation.streamed.cumulativeVerdicts[index];
        requireEvidence(Boolean(verdict) && verdict?.stepIndex === index &&
          verdict.stepId === step.step.id &&
          verdict.opsSha256 === opsHash([...existingOps, ...cumulative]) &&
          verdict.accepted === (verdict.reasons.length === 0),
        `Browser observation ${key} cumulative verdict ${index} is inconsistent.`);
      }
      cumulativePreflights += parsedSteps.length;
      const expectedAccepted = observation.streamed.cumulativeVerdicts.length > 0 &&
        observation.streamed.cumulativeVerdicts.every((verdict) => verdict.accepted);
      const expectedReasons = observation.streamed.cumulativeVerdicts
        .flatMap((verdict) => verdict.accepted ? [] : verdict.reasons);
      requireEvidence(observation.streamed.accepted === expectedAccepted &&
        isDeepStrictEqual(observation.streamed.reasons, expectedReasons),
      `Browser observation ${key} streamed aggregate verdict is inconsistent.`);
    }
  }
  requireEvidence(
    observations.browserHarness.fullScenePreflights === 360 &&
      observations.browserHarness.cumulativePreflights === cumulativePreflights &&
      observations.browserHarness.rasterRenders === 720,
    'M1 raw browser observation counts do not reproduce from the row ledger.',
  );

  let unknownReport: unknown;
  try { unknownReport = JSON.parse(resultRawJson); }
  catch { throw new M1PipelineStudyEvidenceError('M1 report is not valid JSON.'); }
  const parsedReport = M1PipelineStudyReportSchema.safeParse(unknownReport);
  if (!parsedReport.success) {
    const issues = parsedReport.error.issues.slice(0, 6)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
    throw new M1PipelineStudyEvidenceError(`M1 report has an invalid schema: ${issues}`);
  }
  const report = parsedReport.data;
  requireEvidence(isDeepStrictEqual(report.policy, M1_PIPELINE_STUDY_POLICY),
    'M1 report policy differs from the pinned policy.');
  const recomputed = runM1PipelineStudy({
    sourceRawJson,
    browserObservationRawJson,
    generatedAt: report.generatedAt,
  });
  requireEvidence(isDeepStrictEqual(report, recomputed),
    'M1 report does not reproduce from pinned source and raw browser observations.');
  return {
    report,
    sourceSha256,
    browserObservationSha256,
    resultSha256: m1EvidenceSha256(resultRawJson),
  };
}

export class M1PipelineStudyEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'M1PipelineStudyEvidenceError';
  }
}

function verifyLocalHarness(harness: {
  origin: string; path: string; finalOrigin: string; finalPath: string;
  externalRequestCount: number;
}): void {
  const origin = new URL(harness.origin);
  requireEvidence(origin.protocol === 'http:' && isLoopback(origin.hostname),
    'M1 browser observations did not use a loopback HTTP harness.');
  requireEvidence(
    harness.path === '/dev/board' && harness.finalOrigin === harness.origin &&
      harness.finalPath === harness.path && harness.externalRequestCount === 0,
    'M1 browser isolation, final origin/path, or external-request evidence is invalid.',
  );
}

function uniqueByKey<T>(rows: T[], keyOf: (row: T) => string, label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    requireEvidence(!result.has(key), `${label} duplicates row ${key}.`);
    result.set(key, row);
  }
  return result;
}
function sourceKey(trial: Pick<SourceTrial, 'intentId' | 'cacheState' | 'trial'>): string {
  return `${trial.intentId}:terra-low:${trial.cacheState}:${trial.trial}`;
}
function opsHash(ops: BoardOp[]): string { return m1EvidenceSha256(JSON.stringify(ops)); }
function isLoopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}
function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new M1PipelineStudyEvidenceError(message);
}
