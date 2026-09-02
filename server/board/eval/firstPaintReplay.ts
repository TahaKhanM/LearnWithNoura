import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { AddOp, BoardOp } from '../../../shared/boardOps.js';
import { IncrementalDirectorStreamParser } from '../directorStreamParser.js';
import { parseDirectorStreamProposal } from '../directorStreamSchema.js';
import { loadDirectorEvalCorpus } from './corpus.js';
import { M1PipelineStudyReportSchema } from './m1PipelineStudy.js';
import manifestJson from './fixtures/g4-first-paint-evidence-manifest.json' with { type: 'json' };

const M0_SOURCE_SHA256 = 'e02ccc9f240f72a7937fe192f30867434eb7f857fb6c45a5f8b52fa06507ae79';
const M1_REPORT_SHA256 = '44409bf22112a0e76ed95af0ccb605158f0f1fb01f16600acd5d79b67493d209';
const SourceTrialSchema = z.object({
  intentId: z.string(),
  conditionId: z.string(),
  cacheState: z.enum(['cold', 'warm']),
  trial: z.number().int(),
  proposalText: z.string(),
}).passthrough();
const SourceSchema = z.object({ trials: z.array(SourceTrialSchema) }).passthrough();
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ManifestSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  resultPath: z.string().min(1),
  resultSha256: HashSchema,
  m0SourceSha256: HashSchema,
  m1ReportSha256: HashSchema,
  pairedRows: z.literal(290),
  streamingScreenshotSha256: HashSchema,
  classicScreenshotSha256: HashSchema,
}).strict();
const manifest = ManifestSchema.parse(manifestJson);
const ObservationSchema = z.object({
  sourceKey: z.string().min(1),
  lane: z.enum(['streaming', 'classic']),
  providerDelayMs: z.number().int().nonnegative(),
  uiCommitMs: z.number().int().nonnegative(),
  firstPaintMs: z.number().int().nonnegative(),
}).strict();
const ArtifactSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  evidenceMode: z.literal('offline_actual_lesson_ops_presented_replay'),
  evidenceBoundary: z.string().min(1),
  providerCalls: z.literal(0),
  runtimeCostUsd: z.literal(0),
  realChildData: z.literal(false),
  source: z.object({
    m0Path: z.string().min(1),
    m0Sha256: HashSchema,
    m1Path: z.string().min(1),
    m1Sha256: HashSchema,
    pairedValidDiagramRows: z.literal(290),
  }).strict(),
  browserHarness: z.object({
    origin: z.string().url(),
    finalOrigins: z.array(z.string().url()).min(1),
    engine: z.literal('chromium'),
    externalRequestCount: z.literal(0),
    fakeVoiceTransport: z.literal(true),
    actualLessonPage: z.literal(true),
  }).strict(),
  screenshots: z.object({
    sourceKey: z.string().min(1),
    streaming: z.object({ path: z.string().min(1), sha256: HashSchema }).strict(),
    classic: z.object({ path: z.string().min(1), sha256: HashSchema }).strict(),
  }).strict(),
  summary: z.unknown(),
  observations: z.array(ObservationSchema).length(580),
}).strict();

export interface FirstPaintReplayRow {
  sourceKey: string;
  intentId: string;
  firstValidOpMs: number;
  completeSceneMs: number;
  existingOps: BoardOp[];
  streamingOps: AddOp[];
  classicOps: AddOp[];
  semanticGroupId: string;
  groupLabel: string;
}

export interface FirstPaintObservation {
  sourceKey: string;
  lane: 'streaming' | 'classic';
  providerDelayMs: number;
  uiCommitMs: number;
  firstPaintMs: number;
}

export function buildFirstPaintReplayRows(
  sourceRawJson: string,
  m1ReportRawJson: string,
): FirstPaintReplayRow[] {
  if (sha256(sourceRawJson) !== M0_SOURCE_SHA256) throw new Error('G4 M0 source SHA-256 changed.');
  if (sha256(m1ReportRawJson) !== M1_REPORT_SHA256) throw new Error('G4 M1 report SHA-256 changed.');
  const source = SourceSchema.parse(JSON.parse(sourceRawJson));
  const report = M1PipelineStudyReportSchema.parse(JSON.parse(m1ReportRawJson));
  const sourceByKey = new Map(source.trials
    .filter((row) => row.conditionId === 'terra-low')
    .map((row) => [`${row.intentId}:terra-low:${row.cacheState}:${row.trial}`, row]));
  const intents = new Map(loadDirectorEvalCorpus().map((intent) => [intent.id, intent]));
  return report.rows.filter((row) =>
    row.route === 'streaming_diagram' && row.atomicAccepted && row.candidateAccepted &&
    row.firstValidOpMs !== null).map((row) => {
    const sourceRow = sourceByKey.get(row.sourceKey);
    const intent = intents.get(row.intentId);
    if (!sourceRow || !intent || row.firstValidOpMs === null) {
      throw new Error(`G4 source data is incomplete for ${row.sourceKey}.`);
    }
    const visibleObjectIds = (intent.existingBoardOps ?? []).flatMap((op) => op.op === 'add' ? [op.id] : []);
    const parser = new IncrementalDirectorStreamParser({ density: intent.density, visibleObjectIds });
    const steps = parser.push(sourceRow.proposalText);
    parser.finish();
    const first = steps[0];
    if (!first) throw new Error(`G4 proposal has no first step for ${row.sourceKey}.`);
    const proposal = parseDirectorStreamProposal(sourceRow.proposalText, intent.density);
    return {
      sourceKey: row.sourceKey,
      intentId: row.intentId,
      firstValidOpMs: row.firstValidOpMs,
      completeSceneMs: row.completeSceneMs,
      existingOps: intent.existingBoardOps ?? [],
      streamingOps: first.ops,
      classicOps: proposal.ops as AddOp[],
      semanticGroupId: `g4-${row.intentId}`.replace(/[^a-z0-9_-]/gi, '-').slice(0, 80),
      groupLabel: proposal.groupLabel,
    };
  }).sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}

export function summarizeFirstPaintReplay(observations: FirstPaintObservation[]) {
  const streaming = laneSummary(observations.filter((row) => row.lane === 'streaming'));
  const classic = laneSummary(observations.filter((row) => row.lane === 'classic'));
  const streamingKeys = new Set(observations.filter((row) => row.lane === 'streaming').map((row) => row.sourceKey));
  const classicKeys = new Set(observations.filter((row) => row.lane === 'classic').map((row) => row.sourceKey));
  if (streaming.rows === 0 || streaming.rows !== classic.rows ||
      [...streamingKeys].some((key) => !classicKeys.has(key))) {
    throw new Error('G4 requires complete paired streaming/classic observations.');
  }
  const p50Cut = classic.p50FirstPaintMs === 0
    ? 0
    : round(1 - streaming.p50FirstPaintMs / classic.p50FirstPaintMs, 6);
  const streamingWithinFourSeconds = streaming.p50FirstPaintMs <= 4_000;
  return {
    streaming,
    classic,
    p50Cut,
    p50CutAtLeastFortyPercent: p50Cut >= 0.4,
    streamingWithinFourSeconds,
    streamingStretchWithinThreeSeconds: streaming.p50FirstPaintMs <= 3_000,
    accepted: p50Cut >= 0.4 && streamingWithinFourSeconds,
  };
}

export function compileFirstPaintReplayEvidence(rawJson: string) {
  const resultSha256 = sha256(rawJson);
  if (resultSha256 !== manifest.resultSha256) {
    throw new Error('G4 result SHA-256 does not match the evidence manifest.');
  }
  const artifact = ArtifactSchema.parse(JSON.parse(rawJson));
  if (artifact.source.m0Sha256 !== M0_SOURCE_SHA256 || artifact.source.m0Sha256 !== manifest.m0SourceSha256 ||
      artifact.source.m1Sha256 !== M1_REPORT_SHA256 || artifact.source.m1Sha256 !== manifest.m1ReportSha256) {
    throw new Error('G4 source hashes do not match immutable M0/M1 evidence.');
  }
  if (artifact.browserHarness.origin !== 'http://localhost:5180' ||
      artifact.browserHarness.finalOrigins.some((origin) => origin !== artifact.browserHarness.origin)) {
    throw new Error('G4 browser left the isolated Lesson origin.');
  }
  if (artifact.screenshots.streaming.sha256 !== manifest.streamingScreenshotSha256 ||
      artifact.screenshots.classic.sha256 !== manifest.classicScreenshotSha256) {
    throw new Error('G4 screenshot hashes do not match the evidence manifest.');
  }
  const sourceKeys = new Map<string, Set<string>>();
  for (const row of artifact.observations) {
    if (row.firstPaintMs !== row.providerDelayMs + row.uiCommitMs) {
      throw new Error(`G4 timing arithmetic is invalid for ${row.sourceKey}.`);
    }
    sourceKeys.set(row.sourceKey, new Set([...(sourceKeys.get(row.sourceKey) ?? []), row.lane]));
  }
  if (sourceKeys.size !== manifest.pairedRows ||
      [...sourceKeys.values()].some((lanes) => lanes.size !== 2)) {
    throw new Error('G4 observations are not a complete paired cohort.');
  }
  const summary = summarizeFirstPaintReplay(artifact.observations);
  if (!isDeepStrictEqual(summary, artifact.summary)) {
    throw new Error('G4 summary does not reconstruct from observation rows.');
  }
  return {
    resultSha256,
    providerCalls: artifact.providerCalls,
    externalRequestCount: artifact.browserHarness.externalRequestCount,
    pairedRows: sourceKeys.size,
    summary,
    screenshots: artifact.screenshots,
  };
}

function laneSummary(rows: FirstPaintObservation[]) {
  return {
    rows: rows.length,
    p50ProviderDelayMs: percentile(rows.map((row) => row.providerDelayMs), 0.5),
    p50UiCommitMs: percentile(rows.map((row) => row.uiCommitMs), 0.5),
    p95UiCommitMs: percentile(rows.map((row) => row.uiCommitMs), 0.95),
    p50FirstPaintMs: percentile(rows.map((row) => row.firstPaintMs), 0.5),
    p95FirstPaintMs: percentile(rows.map((row) => row.firstPaintMs), 0.95),
  };
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] ?? 0;
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
