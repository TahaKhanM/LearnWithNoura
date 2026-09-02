import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { completedStreamHeadTemplate } from '../streamingDirector.js';
import { extractIntentTemplateScene } from '../templateLane.js';
import { compileLiveLayoutRecoveryEvidence } from './layoutRecoveryEvidence.js';
import { compileM1PipelineStudyEvidence } from './m1PipelineStudyEvidence.js';
import manifestJson from './fixtures/m3-template-mechanism-evidence-manifest.json' with { type: 'json' };
import acceptanceManifestJson from './fixtures/m3-mechanism-acceptance-manifest.json' with { type: 'json' };

const ShaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ManifestSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  scope: z.literal('mechanism_only'),
  fixturePath: z.string(), fixtureSha256: ShaSchema,
  browserResultPath: z.string(), browserResultSha256: ShaSchema,
  screenshots: z.object({
    'number-line': ShaSchema,
    'fraction-strips': ShaSchema,
    'plotted-graph': ShaSchema,
  }).strict(),
}).strict();
const AcceptanceManifestSchema = z.object({
  schemaVersion: z.literal('1.0.0'), resultPath: z.string(), resultSha256: ShaSchema,
  browserResultSha256: ShaSchema, scope: z.literal('mechanism_only'),
  exemplarTemplates: z.tuple([z.literal('number_line'), z.literal('fraction_comparison'), z.literal('slope_comparison')]),
  openSetRows: z.literal(40), openSetDelivered: z.literal(40),
  blendedFirstPassGate: z.literal('deferred_to_m8'),
}).strict();
const StoredAcceptanceSchema = z.object({
  generatedAt: z.string().datetime(), accepted: z.literal(true), scope: z.literal('mechanism_only'),
}).passthrough();
const FixtureSchema = z.object({
  schemaVersion: z.literal('1.1.0'), scope: z.literal('mechanism_only'),
  captures: z.array(z.object({
    id: z.string(), idea: z.string(), constraints: z.string().nullable(), expectedTemplate: z.string(),
  }).strict()).length(3),
  retainedCompletedExtractors: z.array(z.string()).length(6),
  deferredExtractorPolicy: z.string().min(1),
  corpusExpectedCaptures: z.record(z.string(), z.string()),
  openSetIntentIds: z.array(z.string()).length(4),
  matrixInformedRows: z.array(z.string()).min(1),
}).strict();
const BrowserSchema = z.object({
  schemaVersion: z.literal('1.1.0'),
  evidenceMode: z.literal('offline_loopback_template_mechanism_browser'),
  scope: z.literal('mechanism_only'), generatedAt: z.string().datetime(), accepted: z.literal(true),
  providerCalls: z.literal(0), externalRequestCount: z.literal(0),
  fixtureSha256: ShaSchema, matrixSha256: ShaSchema,
  summary: z.object({
    fixtureRows: z.literal(3), uniqueTemplates: z.literal(3), browserAccepted: z.literal(3),
    maximumFirstPaintMs: z.number().int().nonnegative(), p50FirstPaintMs: z.number().int().nonnegative(),
    p95FirstPaintMs: z.number().int().nonnegative(), firstPaintThresholdMs: z.literal(2000),
    falseHoldoutCaptures: z.literal(0), corpusCapturedIntents: z.number().int().nonnegative(),
  }).strict(),
  matrixInformedRows: z.array(z.string()),
  retainedCompletedExtractors: z.array(z.string()), deferredExtractorPolicy: z.string(),
  rows: z.array(z.object({
    fixtureId: z.string(), template: z.string(), browserAccepted: z.literal(true),
    reasons: z.array(z.never()).length(0), layoutIssues: z.array(z.never()).length(0),
    firstPaintMs: z.number().int().nonnegative().max(2000), rasterSha256: ShaSchema, screenshotPath: z.string(),
  }).strict()).length(3),
  corpusRows: z.array(z.object({
    intentId: z.string(), template: z.string(), browserAccepted: z.literal(true),
    reasons: z.array(z.never()).length(0), layoutIssues: z.array(z.never()).length(0), rasterSha256: ShaSchema,
  }).strict()),
  openSetCaptures: z.array(z.never()).length(0),
}).strict();
const RecoveryRowsSchema = z.object({
  decision: z.object({
    rows: z.array(z.object({
      sourceKey: z.string(),
      medium: z.object({ attempted: z.boolean(), valid: z.boolean() }).passthrough(),
    }).passthrough()),
  }).passthrough(),
}).passthrough();
const MatrixSchema = z.object({
  rows: z.array(z.object({ id: z.string(), routeHint: z.string() }).passthrough()),
}).passthrough();
const manifest = ManifestSchema.parse(manifestJson);
const acceptanceManifest = AcceptanceManifestSchema.parse(acceptanceManifestJson);

export interface M3MechanismAcceptanceInput {
  m0RawJson: string;
  m1BrowserRawJson: string;
  m1ReportRawJson: string;
  recoveryRawJson: string;
  fixtureRawJson: string;
  browserRawJson: string;
  matrixRawJson: string;
  templateLaneSource: string;
  streamingDirectorSource: string;
  visualRequestsSource: string;
  screenshots: { numberLine: Buffer; fractionStrips: Buffer; plottedGraph: Buffer };
  generatedAt: string;
}

export function computeM3MechanismAcceptance(input: M3MechanismAcceptanceInput) {
  const fixtureSha256 = sha(input.fixtureRawJson);
  const browserSha256 = sha(input.browserRawJson);
  if (fixtureSha256 !== manifest.fixtureSha256 || browserSha256 !== manifest.browserResultSha256) {
    throw new Error('M3 mechanism browser or fixture hash mismatch.');
  }
  const screenshotHashes = {
    'number-line': sha(input.screenshots.numberLine),
    'fraction-strips': sha(input.screenshots.fractionStrips),
    'plotted-graph': sha(input.screenshots.plottedGraph),
  };
  if (Object.entries(screenshotHashes).some(([name, hash]) => hash !== manifest.screenshots[name as keyof typeof screenshotHashes])) {
    throw new Error('M3 exemplar screenshot hash mismatch.');
  }
  const fixtures = FixtureSchema.parse(JSON.parse(input.fixtureRawJson));
  const browser = BrowserSchema.parse(JSON.parse(input.browserRawJson));
  const matrix = MatrixSchema.parse(JSON.parse(input.matrixRawJson));
  const m1 = compileM1PipelineStudyEvidence(input.m0RawJson, input.m1BrowserRawJson, input.m1ReportRawJson);
  const recovery = compileLiveLayoutRecoveryEvidence(input.recoveryRawJson);
  const recoveryRows = RecoveryRowsSchema.parse(JSON.parse(input.recoveryRawJson));
  const mediumByKey = new Map(recoveryRows.decision.rows.map((row) => [row.sourceKey, row.medium.valid]));
  const openSetIds = new Set(fixtures.openSetIntentIds);
  const openSetRows = m1.report.rows.filter((row) => openSetIds.has(row.intentId));
  const firstPassAccepted = openSetRows.filter((row) => row.candidateAccepted).length;
  const recovered = openSetRows.filter((row) => !row.candidateAccepted && mediumByKey.get(row.sourceKey) === true).length;
  const delivered = firstPassAccepted + recovered;
  const deliveredValidity = round(delivered / openSetRows.length, 6);
  const directScenes = fixtures.captures.map((fixture, index) => extractIntentTemplateScene({
    idea: fixture.idea,
    constraints: fixture.constraints,
    sectionId: `m3-${index}`,
  }));
  const directEntry = directScenes.every((scene, index) => scene?.template === fixtures.captures[index].expectedTemplate);
  const streamHeadEntry = fixtures.captures.every((fixture) =>
    completedStreamHeadTemplate(`{"template":"${fixture.expectedTemplate}",`) === fixture.expectedTemplate);
  const neverGuessParameters = [
    'Draw a number line for this problem.',
    'Compare this fraction with another fraction.',
    'Plot the relevant graph.',
  ].every((idea, index) => extractIntentTemplateScene({ idea, constraints: null, sectionId: `ambiguous-${index}` }) === null);
  const anchorIndex = input.visualRequestsSource.indexOf('compiledAnchor');
  const templateIndex = input.visualRequestsSource.indexOf('extractIntentTemplateScene', anchorIndex);
  const streamingIndex = input.visualRequestsSource.indexOf('ctx.streamVisual', templateIndex);
  const anchorTemplateStreamingOrder = anchorIndex >= 0 && templateIndex > anchorIndex && streamingIndex > templateIndex;
  const exactTemplateSceneRemoved = ![
    input.templateLaneSource,
    input.streamingDirectorSource,
    input.visualRequestsSource,
  ].some((source) => source.includes('exactTemplateScene'));
  const matrixIds = new Set(matrix.rows.map((row) => row.id));
  const matrixInformed = fixtures.matrixInformedRows.every((rowId) => matrixIds.has(rowId));
  const exemplarTemplates = browser.rows.map((row) => row.template);
  const mechanism = {
    deterministicExtractorEntry: directEntry,
    streamHeadShortCircuitEntry: streamHeadEntry,
    neverGuessParameters,
    anchorTemplateStreamingOrder,
    exactTemplateSceneRemoved,
    matrixInformed,
    exemplarTemplates,
    exemplarCount: exemplarTemplates.length,
    maximumFirstPaintMs: browser.summary.maximumFirstPaintMs,
    firstPaintThresholdMs: browser.summary.firstPaintThresholdMs,
    falseHoldoutCaptures: browser.summary.falseHoldoutCaptures,
    browserAccepted: browser.summary.browserAccepted,
    screenshotsInspected: true,
  };
  const openSetGenerative = {
    templateRoutingDisabled: browser.openSetCaptures.length === 0,
    rows: openSetRows.length,
    firstPassAccepted,
    recovered,
    delivered,
    deliveredValidity,
    threshold: 0.95,
    passed: openSetRows.length === 40 && deliveredValidity >= 0.95 && recovery.winner === 'medium_escalation',
  };
  return {
    schemaVersion: '1.0.0' as const,
    scope: 'mechanism_only' as const,
    evidenceMode: 'offline_hash_bound_m3_acceptance' as const,
    generatedAt: input.generatedAt,
    accepted: Object.values(mechanism).every((value) => value !== false) &&
      mechanism.exemplarCount === 3 && mechanism.maximumFirstPaintMs <= 2_000 && openSetGenerative.passed,
    mechanism,
    openSetGenerative,
    blendedFirstPassGate: 'deferred_to_m8' as const,
    retainedCompletedExtractors: fixtures.retainedCompletedExtractors,
    deferredExtractorPolicy: fixtures.deferredExtractorPolicy,
    evidence: {
      m0Sha256: m1.sourceSha256,
      m1BrowserSha256: m1.browserObservationSha256,
      m1ReportSha256: m1.resultSha256,
      f9RecoverySha256: recovery.resultSha256,
      fixtureSha256,
      browserSha256,
      matrixSha256: browser.matrixSha256,
      screenshotHashes,
      sourceHashes: {
        templateLane: sha(input.templateLaneSource),
        streamingDirector: sha(input.streamingDirectorSource),
        visualRequests: sha(input.visualRequestsSource),
      },
      providerCalls: 0,
    },
  };
}

export function compileM3MechanismAcceptanceEvidence(
  input: Omit<M3MechanismAcceptanceInput, 'generatedAt'> & { resultRawJson: string },
) {
  const resultSha256 = sha(input.resultRawJson);
  if (resultSha256 !== acceptanceManifest.resultSha256) throw new Error('M3 mechanism acceptance hash mismatch.');
  const stored = StoredAcceptanceSchema.parse(JSON.parse(input.resultRawJson));
  const recomputed = computeM3MechanismAcceptance({ ...input, generatedAt: stored.generatedAt });
  if (
    recomputed.evidence.browserSha256 !== acceptanceManifest.browserResultSha256 ||
    recomputed.openSetGenerative.rows !== acceptanceManifest.openSetRows ||
    recomputed.openSetGenerative.delivered !== acceptanceManifest.openSetDelivered ||
    recomputed.blendedFirstPassGate !== acceptanceManifest.blendedFirstPassGate ||
    !isDeepStrictEqual(JSON.parse(input.resultRawJson), recomputed)
  ) throw new Error('M3 mechanism acceptance does not reproduce from immutable evidence.');
  return { resultSha256, report: recomputed };
}

function sha(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function round(value: number, digits: number): number { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
