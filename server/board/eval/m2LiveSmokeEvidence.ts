import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AnchorSceneSchema } from '../../../shared/compiledLesson.js';
import { estimateUsageCostUsd } from './budget.js';
import manifestJson from './fixtures/m2-live-smoke-evidence-manifest.json' with { type: 'json' };

const ShaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ManifestSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  resultPath: z.string(),
  resultSha256: ShaSchema,
  scenePath: z.string(),
  sceneSha256: ShaSchema,
  correctedScreenshotPath: z.string(),
  correctedScreenshotSha256: ShaSchema,
  accepted: z.literal(false),
  requiresAuthorizedRerun: z.literal(true),
}).strict();
const UsageSchema = z.object({
  providerCalls: z.literal(3),
  counts: z.object({
    realtime: z.literal(1), composition: z.literal(1), visionAudit: z.literal(1),
    recovery: z.literal(0), layoutCorrection: z.literal(0),
  }).strict(),
  realtime: z.object({
    model: z.literal('gpt-realtime-2.1'),
    inputTextTokens: z.number().int().nonnegative(), cachedTextTokens: z.number().int().nonnegative(),
    inputAudioTokens: z.number().int().nonnegative(), cachedAudioTokens: z.number().int().nonnegative(),
    inputImageTokens: z.number().int().nonnegative(), cachedImageTokens: z.number().int().nonnegative(),
    outputTextTokens: z.number().int().nonnegative(), outputAudioTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
  }).strict(),
  composition: z.object({
    model: z.literal('gpt-5.6-terra'), reasoningEffort: z.literal('low'),
    inputTokens: z.number().int(), cachedInputTokens: z.number().int(), outputTokens: z.number().int(),
    estimatedCostUsd: z.number().nonnegative(),
  }).strict(),
  visionAudit: z.object({
    model: z.literal('gpt-5.6-luna'), reasoningEffort: z.literal('low'),
    inputTokens: z.number().int(), cachedInputTokens: z.number().int(), outputTokens: z.number().int(),
    estimatedCostUsd: z.number().nonnegative(),
  }).strict(),
  estimatedObservedCostUsd: z.number().nonnegative(),
  accountedUpperBoundUsd: z.number().nonnegative(),
  hardCapHeadroomUsd: z.number().nonnegative(),
  providerBillingSurfaceCostUsd: z.null(),
  costClaim: z.literal('token_meter_estimate_plus_conservative_upper_bound'),
}).strict();
const ResultSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  evidenceMode: z.literal('authorized_live_synthetic_lesson'),
  generatedAt: z.string().datetime(),
  accepted: z.literal(false),
  automatedSmokeGatePassed: z.literal(true),
  manualQualityGatePassed: z.literal(false),
  requiresAuthorizedRerun: z.literal(true),
  authorization: z.object({ hardCapUsd: z.literal(1.25) }).passthrough(),
  journey: z.object({
    firstBoardObserved: z.literal(true), secondBoardChangeObserved: z.literal(true),
    browserConsoleErrors: z.literal(0), tutorObjectDisappearances: z.literal(0), telemetryGaps: z.literal(0),
    auditOutcome: z.literal('approved'),
  }).passthrough(),
  providerUsage: UsageSchema,
  pricingBasis: z.object({
    source: z.literal('https://developers.openai.com/api/docs/models/gpt-realtime-2.1'),
    realtimePerMillionTokensUsd: z.object({
      inputText: z.literal(4), cachedInputText: z.literal(0.4), outputText: z.literal(24),
      inputAudio: z.literal(32), cachedInputAudio: z.literal(0.4), outputAudio: z.literal(64),
      inputImage: z.literal(5), cachedInputImage: z.literal(0.5),
    }).strict(),
  }).strict(),
  quality: z.object({
    originalBrowserPreflightAccepted: z.literal(true), originalVisionAuditApproved: z.literal(true),
    manualFinding: z.literal('connector_label_overlap'), originalScreenshotRetained: z.literal(false),
    correctedFailingTestAdded: z.literal(true), correctedOfflineBrowserAccepted: z.literal(true),
    correctedScreenshotInspected: z.literal(true), correctedScreenshotPath: z.string(), correctedScreenshotSha256: ShaSchema,
  }).passthrough(),
  directedScene: z.object({ path: z.string(), sha256: ShaSchema }).strict(),
  decision: z.string().min(1),
}).strict();
const SceneSourceSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  evidenceMode: z.literal('authorized_live_synthetic_provider_output'),
  scene: AnchorSceneSchema,
}).strict();
const manifest = ManifestSchema.parse(manifestJson);

export function compileM2LiveSmokeEvidence(input: {
  resultRawJson: string;
  sceneRawJson: string;
  correctedScreenshot: Buffer;
}) {
  const resultSha256 = sha256(input.resultRawJson);
  const sceneSha256 = sha256(input.sceneRawJson);
  const correctedScreenshotSha256 = sha256(input.correctedScreenshot);
  if (
    resultSha256 !== manifest.resultSha256 || sceneSha256 !== manifest.sceneSha256 ||
    correctedScreenshotSha256 !== manifest.correctedScreenshotSha256
  ) throw new Error('M2 live-smoke evidence hash does not match the manifest.');
  const report = ResultSchema.parse(JSON.parse(input.resultRawJson));
  SceneSourceSchema.parse(JSON.parse(input.sceneRawJson));
  const usage = report.providerUsage;
  const rates = report.pricingBasis.realtimePerMillionTokensUsd;
  const realtime = usage.realtime;
  const realtimeCost = money((
    (realtime.inputTextTokens - realtime.cachedTextTokens) * rates.inputText +
    realtime.cachedTextTokens * rates.cachedInputText +
    (realtime.inputAudioTokens - realtime.cachedAudioTokens) * rates.inputAudio +
    realtime.cachedAudioTokens * rates.cachedInputAudio +
    (realtime.inputImageTokens - realtime.cachedImageTokens) * rates.inputImage +
    realtime.cachedImageTokens * rates.cachedInputImage +
    realtime.outputTextTokens * rates.outputText +
    realtime.outputAudioTokens * rates.outputAudio
  ) / 1_000_000);
  const compositionCost = estimateUsageCostUsd('gpt-5.6-terra', {
    inputTokens: usage.composition.inputTokens,
    cachedInputTokens: usage.composition.cachedInputTokens,
    cacheWriteTokens: 0,
    outputTokens: usage.composition.outputTokens,
  });
  const auditCost = estimateUsageCostUsd('gpt-5.6-luna', {
    inputTokens: usage.visionAudit.inputTokens,
    cachedInputTokens: usage.visionAudit.cachedInputTokens,
    cacheWriteTokens: 0,
    outputTokens: usage.visionAudit.outputTokens,
  });
  if (
    realtimeCost !== realtime.estimatedCostUsd || compositionCost !== usage.composition.estimatedCostUsd ||
    auditCost !== usage.visionAudit.estimatedCostUsd ||
    money(realtimeCost + compositionCost + auditCost) !== usage.estimatedObservedCostUsd ||
    money(report.authorization.hardCapUsd - usage.accountedUpperBoundUsd) !== usage.hardCapHeadroomUsd ||
    usage.estimatedObservedCostUsd > usage.accountedUpperBoundUsd ||
    usage.accountedUpperBoundUsd > report.authorization.hardCapUsd ||
    report.quality.correctedScreenshotPath !== manifest.correctedScreenshotPath ||
    report.quality.correctedScreenshotSha256 !== correctedScreenshotSha256 ||
    report.directedScene.path !== manifest.scenePath || report.directedScene.sha256 !== sceneSha256
  ) throw new Error('M2 live-smoke usage or quality evidence does not reproduce.');
  return { report, resultSha256, sceneSha256, correctedScreenshotSha256 };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function money(value: number): number {
  return Math.round(value * 1e10) / 1e10;
}
