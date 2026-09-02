import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { summarizeFirstPaintReplay, type FirstPaintObservation } from './firstPaintReplay.js';
import { compileImageGroundingStudyEvidence } from './imageGroundingEvidence.js';
import { compileM7CurriculumEvidence } from './m7CurriculumEvidence.js';
import { compileM7RelationalEvidence } from './m7RelationalEvidence.js';
import g4ManifestJson from './fixtures/m7-g4-evidence-manifest.json' with { type: 'json' };
import acceptanceManifestJson from './fixtures/m7-acceptance-manifest.json' with { type: 'json' };

const ShaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const G4ManifestSchema = z.object({
  schemaVersion: z.literal('1.0.0'), m0Sha256: ShaSchema, m1Sha256: ShaSchema,
  resultSha256: ShaSchema, previousG4Sha256: ShaSchema, incidentSha256: ShaSchema,
  selectionStrategy: z.literal('deterministic_stratified_index'), sampleRows: z.literal(72), totalRows: z.literal(290),
  streamingP50FirstPaintMs: z.literal(2789), classicP50FirstPaintMs: z.literal(4754), p50Cut: z.literal(0.413336),
  streamingScreenshotSha256: ShaSchema, classicScreenshotSha256: ShaSchema,
  providerCalls: z.literal(0), actualLessonPage: z.literal(true), manuallyInspected: z.literal(true),
}).strict();
const AcceptanceManifestSchema = z.object({
  schemaVersion: z.literal('1.0.0'), resultSha256: ShaSchema, technicalAccepted: z.literal(true),
  accepted: z.literal(false), blocker: z.literal('provider_spend_process_violation'), curriculumRows: z.literal(39),
  relationalRows: z.literal(34), g4SampleRows: z.literal(72), groundingProviderCalls: z.literal(17),
}).strict();
const StoredAcceptanceSchema = z.object({ generatedAt: z.string().datetime(), technicalAccepted: z.literal(true), accepted: z.literal(false) }).passthrough();
const ObservationSchema = z.object({
  sourceKey: z.string(), lane: z.enum(['streaming', 'classic']), providerDelayMs: z.number().nonnegative(),
  uiCommitMs: z.number().nonnegative(), firstPaintMs: z.number().nonnegative(),
}).strict();
const G4Schema = z.object({
  schemaVersion: z.literal('1.0.0'), evidenceMode: z.literal('offline_actual_lesson_ops_presented_replay'),
  evidenceBoundary: z.string(), providerCalls: z.literal(0), runtimeCostUsd: z.literal(0), realChildData: z.literal(false),
  selection: z.object({ strategy: z.literal('deterministic_stratified_index'), sampleRows: z.literal(72), totalRows: z.literal(290) }).strict(),
  source: z.object({ m0Path: z.string(), m0Sha256: ShaSchema, m1Path: z.string(), m1Sha256: ShaSchema, pairedValidDiagramRows: z.literal(72) }).strict(),
  browserHarness: z.object({ origin: z.string().url(), finalOrigins: z.array(z.string().url()), engine: z.literal('chromium'), externalRequestCount: z.literal(0), fakeVoiceTransport: z.literal(true), actualLessonPage: z.literal(true) }).strict(),
  screenshots: z.object({
    sourceKey: z.string(),
    streaming: z.object({ path: z.string(), sha256: ShaSchema }).strict(),
    classic: z.object({ path: z.string(), sha256: ShaSchema }).strict(),
  }).strict(),
  summary: z.object({
    streaming: z.object({ rows: z.literal(72), p50ProviderDelayMs: z.number(), p50UiCommitMs: z.number(), p95UiCommitMs: z.number(), p50FirstPaintMs: z.number(), p95FirstPaintMs: z.number() }).strict(),
    classic: z.object({ rows: z.literal(72), p50ProviderDelayMs: z.number(), p50UiCommitMs: z.number(), p95UiCommitMs: z.number(), p50FirstPaintMs: z.number(), p95FirstPaintMs: z.number() }).strict(),
    p50Cut: z.number(), p50CutAtLeastFortyPercent: z.literal(true), streamingWithinFourSeconds: z.literal(true), streamingStretchWithinThreeSeconds: z.literal(true), accepted: z.literal(true),
  }).strict(),
  observations: z.array(ObservationSchema).length(144),
}).strict();
const PreviousG4Schema = z.object({ summary: z.object({ streaming: z.object({ p50FirstPaintMs: z.number(), p50UiCommitMs: z.number() }).passthrough() }).passthrough() }).passthrough();
const IncidentSchema = z.object({
  schemaVersion: z.literal('1.0.0'), incident: z.literal('g4_harness_started_without_fixture_compiler'),
  syntheticOnly: z.literal(true), realChildData: z.literal(false), itemizedAuthorization: z.literal(false),
  observedLocalState: z.object({ sessionsCreated: z.literal(6), compiledLessonsReady: z.literal(5), compiledLessonsPendingAtShutdown: z.literal(1) }).passthrough(),
  providerRequestAccounting: z.object({ minimumCompletedRequestsImpliedByState: z.literal(11), exactProviderCalls: z.null(), exactObservedCostUsd: z.null() }).passthrough(),
  containment: z.object({ serverStoppedImmediatelyAfterDiscovery: z.literal(true), evidenceExcludedFromG4: z.literal(true), replacementLessonCompiler: z.literal('fixture'), replacementDrawingProviderConstructed: z.literal(false) }).passthrough(),
  formalEffect: z.string(),
}).passthrough();
const g4Manifest = G4ManifestSchema.parse(g4ManifestJson);
const acceptanceManifest = AcceptanceManifestSchema.parse(acceptanceManifestJson);

export interface M7AcceptanceInput {
  curriculum: Parameters<typeof compileM7CurriculumEvidence>[0];
  m0RawJson: string;
  relationalResultRawJson: string;
  groundingFixtureRawJson: string;
  groundingResultRawJson: string;
  groundingLedgerRawJsonl: string;
  previousG4RawJson: string;
  m7G4RawJson: string;
  m7G4StreamingScreenshot: Buffer;
  m7G4ClassicScreenshot: Buffer;
  incidentRawJson: string;
  fastTierUnitSource: string;
  fastTierE2ESource: string;
  fastTierScreenshot: Buffer;
  generatedAt: string;
}

export function computeM7Acceptance(input: M7AcceptanceInput) {
  const curriculumEvidence = compileM7CurriculumEvidence(input.curriculum);
  const relationalEvidence = compileM7RelationalEvidence({ m0RawJson: input.m0RawJson, resultRawJson: input.relationalResultRawJson });
  const groundingEvidence = compileImageGroundingStudyEvidence({
    fixtureRawJson: input.groundingFixtureRawJson,
    resultRawJson: input.groundingResultRawJson,
    ledgerRawJsonl: input.groundingLedgerRawJsonl,
  });
  const g4 = compileM7G4(input);
  const incident = IncidentSchema.parse(JSON.parse(input.incidentRawJson));
  if (hash(input.incidentRawJson) !== g4Manifest.incidentSha256) throw new Error('M7 G4 incident hash mismatch.');
  const fastTier = {
    thresholdMs: 1000,
    thresholdAsserted: input.fastTierE2ESource.includes('toBeLessThan(1_000)'),
    zeroVisionCalls: input.fastTierUnitSource.includes('expect(inspect).not.toHaveBeenCalled()'),
    actualLessonE2E: input.fastTierE2ESource.includes('fast annotations resolve semantic sub-anchors and learner strokes without vision'),
    screenshotSha256: hash(input.fastTierScreenshot),
  };
  const curriculum = {
    totalRows: curriculumEvidence.summary.totalRows,
    supportedRows: curriculumEvidence.summary.supportedRows,
    composableRows: curriculumEvidence.summary.composableRows,
    missingRows: curriculumEvidence.summary.missingRows,
    browserAccepted: curriculumEvidence.summary.browserAccepted,
    maximumFirstPaintMs: curriculumEvidence.summary.maximumFirstPaintMs,
  };
  const relational = {
    rows: relationalEvidence.eligibleRelationalRows,
    originalAcceptedRows: relationalEvidence.originalValidatorAcceptedRows,
    recoveredRows: relationalEvidence.relationalRecoveredRows,
    acceptedRows: relationalEvidence.acceptedRows,
    validity: relationalEvidence.singleShotConjunctiveValidity,
    threshold: relationalEvidence.threshold,
  };
  const grounding = {
    pointingAccuracy: groundingEvidence.metrics.pointingAccuracy,
    correctSelfCheckFalseRejectRate: groundingEvidence.metrics.correctSelfCheckFalseRejectRate,
    seededDefectCatchRate: groundingEvidence.metrics.seededDefectCatchRate,
    tapFallbackRate: groundingEvidence.metrics.tapFallbackRate,
    malformedReplyRate: groundingEvidence.metrics.malformedReplyRate,
    providerCalls: groundingEvidence.spend.actualProviderCalls,
    observedCostUsd: groundingEvidence.spend.observedCostUsd,
    conservativeAccountedCostUsd: groundingEvidence.spend.conservativeAccountedCostUsd,
    authorizedHardCapUsd: groundingEvidence.spend.hardCapUsd,
  };
  const technicalAccepted = curriculumEvidence.accepted && relationalEvidence.accepted && groundingEvidence.accepted && g4.noRegression &&
    fastTier.thresholdAsserted && fastTier.zeroVisionCalls && fastTier.actualLessonE2E;
  return {
    schemaVersion: '1.0.0' as const,
    evidenceMode: 'm7_technical_and_process_acceptance_audit' as const,
    generatedAt: input.generatedAt,
    technicalAccepted,
    processCompliant: false,
    accepted: false,
    blockers: ['provider_spend_process_violation'] as const,
    curriculum,
    relational,
    grounding,
    g4: g4.report,
    fastTier,
    primitives: ['transform', 'panelGrid', 'regionFill', 'scatter', 'boxplot', 'histogram', 'isometricSolid', 'cubeNet', 'planView', 'paperFoldHolePunch', 'gridPaper', 'clock', 'protractor'],
    annotationStyles: ['circle', 'underline', 'arrow', 'tick', 'cross', 'bracket', 'callout', 'highlighter'],
    processIncident: {
      code: incident.incident,
      syntheticSessions: incident.observedLocalState.sessionsCreated,
      minimumCompletedProviderRequests: incident.providerRequestAccounting.minimumCompletedRequestsImpliedByState,
      exactProviderCalls: null,
      exactObservedCostUsd: null,
      evidenceExcluded: incident.containment.evidenceExcludedFromG4,
      formalEffect: 'M7 formal acceptance is blocked; the violation cannot be repaired retroactively.',
    },
    evidenceHashes: {
      curriculum: curriculumEvidence.resultSha256,
      relational: relationalEvidence.resultSha256,
      grounding: groundingEvidence.resultSha256,
      groundingLedger: groundingEvidence.ledgerSha256,
      g4: g4.resultSha256,
      incident: g4Manifest.incidentSha256,
      fastTierUnitSource: hash(input.fastTierUnitSource),
      fastTierE2ESource: hash(input.fastTierE2ESource),
    },
    unproven: ['target-device acoustics', 'real-child image grounding behavior', 'full 290-row post-M7 G4 replay'],
  };
}

export function compileM7AcceptanceEvidence(input: Omit<M7AcceptanceInput, 'generatedAt'> & { resultRawJson: string }) {
  const resultSha256 = hash(input.resultRawJson);
  if (resultSha256 !== acceptanceManifest.resultSha256) throw new Error('M7 acceptance result hash mismatch.');
  const stored = StoredAcceptanceSchema.parse(JSON.parse(input.resultRawJson));
  const recomputed = computeM7Acceptance({ ...input, generatedAt: stored.generatedAt });
  if (!isDeepStrictEqual(JSON.parse(input.resultRawJson), recomputed) ||
      recomputed.curriculum.totalRows !== acceptanceManifest.curriculumRows ||
      recomputed.relational.rows !== acceptanceManifest.relationalRows ||
      recomputed.g4.sampleRows !== acceptanceManifest.g4SampleRows ||
      recomputed.grounding.providerCalls !== acceptanceManifest.groundingProviderCalls) {
    throw new Error('M7 acceptance does not reproduce from retained evidence.');
  }
  return { resultSha256, report: recomputed };
}

function compileM7G4(input: Pick<M7AcceptanceInput, 'previousG4RawJson' | 'm7G4RawJson' | 'm7G4StreamingScreenshot' | 'm7G4ClassicScreenshot'>) {
  const resultSha256 = hash(input.m7G4RawJson);
  if (resultSha256 !== g4Manifest.resultSha256 || hash(input.previousG4RawJson) !== g4Manifest.previousG4Sha256) throw new Error('M7 G4 evidence hash mismatch.');
  const result = G4Schema.parse(JSON.parse(input.m7G4RawJson));
  const previous = PreviousG4Schema.parse(JSON.parse(input.previousG4RawJson));
  if (result.source.m0Sha256 !== g4Manifest.m0Sha256 || result.source.m1Sha256 !== g4Manifest.m1Sha256 ||
      hash(input.m7G4StreamingScreenshot) !== g4Manifest.streamingScreenshotSha256 || hash(input.m7G4ClassicScreenshot) !== g4Manifest.classicScreenshotSha256) {
    throw new Error('M7 G4 source or screenshot hash mismatch.');
  }
  const observations = result.observations as FirstPaintObservation[];
  const recomputed = summarizeFirstPaintReplay(observations);
  if (!isDeepStrictEqual(recomputed, result.summary)) throw new Error('M7 G4 summary does not reproduce from observations.');
  const noRegression = result.summary.accepted && result.summary.streaming.p50FirstPaintMs <= previous.summary.streaming.p50FirstPaintMs * 1.05 &&
    result.summary.streaming.p50UiCommitMs <= previous.summary.streaming.p50UiCommitMs * 1.2;
  return {
    resultSha256,
    noRegression,
    report: {
      sampleRows: result.selection.sampleRows,
      totalRows: result.selection.totalRows,
      streamingP50FirstPaintMs: result.summary.streaming.p50FirstPaintMs,
      classicP50FirstPaintMs: result.summary.classic.p50FirstPaintMs,
      streamingP50UiCommitMs: result.summary.streaming.p50UiCommitMs,
      previousStreamingP50FirstPaintMs: previous.summary.streaming.p50FirstPaintMs,
      previousStreamingP50UiCommitMs: previous.summary.streaming.p50UiCommitMs,
      p50Cut: result.summary.p50Cut,
      noRegression,
      actualLessonPage: result.browserHarness.actualLessonPage,
      providerCalls: result.providerCalls,
      screenshotsInspected: g4Manifest.manuallyInspected,
    },
  };
}
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
