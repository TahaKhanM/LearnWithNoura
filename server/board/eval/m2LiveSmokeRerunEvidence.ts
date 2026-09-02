import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AnchorSceneSchema } from '../../../shared/compiledLesson.js';
import { estimateUsageCostUsd } from './budget.js';
import manifestJson from './fixtures/m2-live-smoke-rerun-evidence-manifest.json' with { type: 'json' };

const ShaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ScreenshotSchema = z.object({ path: z.string(), sha256: ShaSchema }).strict();
const ManifestSchema = z.object({
  schemaVersion: z.literal('1.0.0'), resultPath: z.string(), resultSha256: ShaSchema,
  scenePath: z.string(), sceneSha256: ShaSchema, liveStep2ScreenshotSha256: ShaSchema,
  liveStep3ScreenshotSha256: ShaSchema, fullTerminalScreenshotSha256: ShaSchema,
  accepted: z.literal(true),
}).strict();
const TextUsageSchema = z.object({
  model: z.enum(['gpt-5.6-terra', 'gpt-5.6-luna']),
  reasoningEffort: z.literal('low'), inputTokens: z.number().int(), cachedInputTokens: z.number().int(),
  outputTokens: z.number().int(), estimatedCostUsd: z.number().nonnegative(),
}).strict();
const ResultSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  evidenceMode: z.literal('authorized_live_synthetic_lesson_corrected_rerun'),
  generatedAt: z.string().datetime(), accepted: z.literal(true),
  acceptanceScope: z.literal('adopted_role_configuration_and_second_board_change'),
  authorization: z.object({ hardCapUsd: z.literal(0.85), maximumConservativeReserveUsd: z.literal(0.8) }).passthrough(),
  journey: z.object({
    secondBoardChangeObserved: z.literal(true), secondSectionOpened: z.literal(true),
    browserConsoleErrors: z.literal(0), tutorObjectDisappearances: z.literal(0), telemetryGaps: z.literal(0),
    auditDurationMs: z.number().nonnegative(), auditBudgetMs: z.literal(3000), auditOutcome: z.literal('approved'),
    recoveryUsed: z.literal(false), thirdRevealLiveStatus: z.literal('not_observed_before_smoke_end'),
  }).passthrough(),
  providerUsage: z.object({
    providerCalls: z.literal(3),
    counts: z.object({ realtime: z.literal(1), composition: z.literal(1), visionAudit: z.literal(1), recovery: z.literal(0), layoutCorrection: z.literal(0) }).strict(),
    realtime: z.object({
      model: z.literal('gpt-realtime-2.1'), inputTextTokens: z.number().int(), cachedTextTokens: z.number().int(),
      inputAudioTokens: z.number().int(), cachedAudioTokens: z.number().int(), inputImageTokens: z.number().int(),
      cachedImageTokens: z.number().int(), outputTextTokens: z.number().int(), outputAudioTokens: z.number().int(),
      estimatedCostUsd: z.number().nonnegative(),
    }).strict(),
    composition: TextUsageSchema,
    visionAudit: TextUsageSchema,
    estimatedObservedCostUsd: z.number().nonnegative(), accountedUpperBoundUsd: z.number().nonnegative(),
    hardCapHeadroomUsd: z.number().nonnegative(), providerBillingSurfaceCostUsd: z.null(),
    costClaim: z.literal('token_meter_estimate_plus_conservative_upper_bound'),
  }).strict(),
  pricingBasis: z.object({ source: z.string().url(), realtimePerMillionTokensUsd: z.record(z.string(), z.number()) }).strict(),
  quality: z.object({
    liveObservedFramesInspected: z.literal(true), liveObservedFramesPassed: z.literal(true),
    connectorLabelOverlapPresent: z.literal(false), fullTerminalSceneBrowserAcceptedOffline: z.literal(true),
    fullTerminalSceneInspectedOffline: z.literal(true), semanticContentPassed: z.literal(true),
    liveStep2Screenshot: ScreenshotSchema, liveStep3Screenshot: ScreenshotSchema,
    fullTerminalSceneScreenshot: ScreenshotSchema,
  }).strict(),
  directedScene: z.object({ path: z.string(), sha256: ShaSchema }).strict(),
  evidenceBoundary: z.object({ provenLive: z.array(z.string()), provenOfflineFromLiveOutput: z.array(z.string()), notProven: z.array(z.string()) }).strict(),
}).strict();
const SceneSchema = z.object({ schemaVersion: z.literal('1.0.0'), evidenceMode: z.literal('authorized_live_synthetic_provider_output'), scene: AnchorSceneSchema }).strict();
const manifest = ManifestSchema.parse(manifestJson);

export function compileM2LiveSmokeRerunEvidence(input: {
  resultRawJson: string;
  sceneRawJson: string;
  liveStep2Screenshot: Buffer;
  liveStep3Screenshot: Buffer;
  fullTerminalScreenshot: Buffer;
}) {
  const hashes = {
    result: sha(input.resultRawJson), scene: sha(input.sceneRawJson),
    step2: sha(input.liveStep2Screenshot), step3: sha(input.liveStep3Screenshot),
    full: sha(input.fullTerminalScreenshot),
  };
  if (
    hashes.result !== manifest.resultSha256 || hashes.scene !== manifest.sceneSha256 ||
    hashes.step2 !== manifest.liveStep2ScreenshotSha256 || hashes.step3 !== manifest.liveStep3ScreenshotSha256 ||
    hashes.full !== manifest.fullTerminalScreenshotSha256
  ) throw new Error('Corrected M2 smoke evidence hash mismatch.');
  const report = ResultSchema.parse(JSON.parse(input.resultRawJson));
  SceneSchema.parse(JSON.parse(input.sceneRawJson));
  const realtime = report.providerUsage.realtime;
  const rates = report.pricingBasis.realtimePerMillionTokensUsd;
  const realtimeCost = money((
    (realtime.inputTextTokens - realtime.cachedTextTokens) * rates.inputText + realtime.cachedTextTokens * rates.cachedInputText +
    (realtime.inputAudioTokens - realtime.cachedAudioTokens) * rates.inputAudio + realtime.cachedAudioTokens * rates.cachedInputAudio +
    (realtime.inputImageTokens - realtime.cachedImageTokens) * rates.inputImage + realtime.cachedImageTokens * rates.cachedInputImage +
    realtime.outputTextTokens * rates.outputText + realtime.outputAudioTokens * rates.outputAudio
  ) / 1_000_000);
  const compositionCost = textCost(report.providerUsage.composition);
  const auditCost = textCost(report.providerUsage.visionAudit);
  if (
    realtimeCost !== realtime.estimatedCostUsd || compositionCost !== report.providerUsage.composition.estimatedCostUsd ||
    auditCost !== report.providerUsage.visionAudit.estimatedCostUsd ||
    money(realtimeCost + compositionCost + auditCost) !== report.providerUsage.estimatedObservedCostUsd ||
    money(report.authorization.hardCapUsd - report.providerUsage.accountedUpperBoundUsd) !== report.providerUsage.hardCapHeadroomUsd ||
    report.providerUsage.estimatedObservedCostUsd > report.providerUsage.accountedUpperBoundUsd ||
    report.providerUsage.accountedUpperBoundUsd > report.authorization.hardCapUsd || report.journey.auditDurationMs > report.journey.auditBudgetMs ||
    report.quality.liveStep2Screenshot.sha256 !== hashes.step2 || report.quality.liveStep3Screenshot.sha256 !== hashes.step3 ||
    report.quality.fullTerminalSceneScreenshot.sha256 !== hashes.full || report.directedScene.path !== manifest.scenePath ||
    report.directedScene.sha256 !== hashes.scene
  ) throw new Error('Corrected M2 smoke evidence does not reproduce.');
  return { report, resultSha256: hashes.result, sceneSha256: hashes.scene };
}

function textCost(usage: z.infer<typeof TextUsageSchema>): number {
  return estimateUsageCostUsd(usage.model, {
    inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens,
    cacheWriteTokens: 0, outputTokens: usage.outputTokens,
  });
}
function sha(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function money(value: number): number { return Math.round(value * 1e10) / 1e10; }
