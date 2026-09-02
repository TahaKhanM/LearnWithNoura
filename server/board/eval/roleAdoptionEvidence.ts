import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readRuntimeConfig } from '../../runtimeConfig.js';
import { DEFAULT_STREAMING_RECOVERY_STRATEGY } from '../directorService.js';
import { directorStreamMessages, layoutCorrectionMessages } from '../directorStreamingService.js';
import { DIRECTOR_STREAM_RESPONSE_FORMAT } from '../directorStreamSchema.js';
import { visionAuditMessages } from '../visionAuditService.js';
import { VISION_AUDIT_BUDGET_MS, type VisionAuditInput } from '../visionAudit.js';
import { compileDirectorBakeoffDecisionEvidence } from './decisionEvidence.js';
import { compileLiveLayoutRecoveryEvidence } from './layoutRecoveryEvidence.js';
import manifestJson from './fixtures/m2-role-adoption-evidence-manifest.json' with { type: 'json' };

const ManifestSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  resultPath: z.string(),
  resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
  m0SourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  recoverySourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  liveSmoke: z.literal('requires_fresh_authorization'),
}).strict();
const StoredSchema = z.object({
  generatedAt: z.string().datetime(),
  contracts: z.object({
    strictProductionStepSchema: z.literal(true),
    productionStepSchemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
    piiSentinelEscaped: z.literal(false),
  }).passthrough(),
  liveSmoke: z.object({ status: z.literal('requires_fresh_authorization') }).passthrough(),
}).passthrough();
const manifest = ManifestSchema.parse(manifestJson);

export function buildM2RoleAdoptionEvidence(input: {
  m0RawJson: string;
  recoveryRawJson: string;
  generatedAt: string;
  historicalProductionStepSchemaSha256?: string;
}) {
  const m0 = compileDirectorBakeoffDecisionEvidence(input.m0RawJson, {
    rawEvidencePath: 'server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json',
  });
  const recovery = compileLiveLayoutRecoveryEvidence(input.recoveryRawJson);
  const config = readRuntimeConfig({});
  const selectedAudit = m0.visionAudit.candidates.find((candidate) => candidate.conditionId === 'luna-low');
  if (!selectedAudit || m0.visionAudit.selectedConditionId !== 'luna-low') {
    throw new Error('The immutable M0 evidence does not select Luna-low for vision audit.');
  }
  const privateSentinel = 'PRIVATE_LEARNER_IDENTITY_OR_TRANSCRIPT_MUST_NOT_ESCAPE';
  const request = {
    purpose: 'explain a synthetic relationship',
    idea: 'show two labelled quantities',
    constraints: 'preserve exact values',
    density: 'minimal' as const,
    targetObjectIds: [],
    sectionId: 'm2-evidence',
    sectionLabel: 'M2 evidence',
    boardSummary: 'one synthetic box',
    visibleObjectIds: ['box-a'],
    currentBoardOps: [],
    stageBrief: 'synthetic stage',
    learnerContext: privateSentinel,
  };
  const controller = new AbortController();
  const correctionMessages = layoutCorrectionMessages({
    request,
    priorOps: [],
    rejectedOps: [{ op: 'add', id: 'box-a', spec: { kind: 'box', at: [500, 300], text: 'A' } }],
    layoutIssues: [{ code: 'bounds', itemId: 'box-a', itemBounds: { x: 900, y: 300, w: 200, h: 80 } }],
    signal: controller.signal,
  });
  const auditMessages = visionAuditMessages({
    purpose: request.purpose,
    idea: request.idea,
    constraints: request.constraints,
    candidateImage: 'data:image/jpeg;base64,c3ludGhldGlj',
    learnerContext: privateSentinel,
  } as VisionAuditInput & { learnerContext: string });
  const payload = JSON.stringify([
    directorStreamMessages(request, 'data:image/jpeg;base64,c3ludGhldGlj'),
    correctionMessages,
    auditMessages,
  ]);
  const strictFormat = DIRECTOR_STREAM_RESPONSE_FORMAT.type === 'json_schema' &&
    DIRECTOR_STREAM_RESPONSE_FORMAT.json_schema.strict === true;

  return {
    schemaVersion: '1.0.0' as const,
    evidenceMode: 'offline_hash_bound_role_adoption' as const,
    generatedAt: input.generatedAt,
    defaults: {
      composition: { model: config.directorModel, reasoningEffort: config.directorReasoningEffort },
      visionAudit: {
        model: config.visionAuditModel,
        reasoningEffort: config.visionAuditReasoningEffort,
        budgetMs: VISION_AUDIT_BUDGET_MS,
      },
      recovery: DEFAULT_STREAMING_RECOVERY_STRATEGY,
      hedge: 'off' as const,
    },
    auditEvidence: {
      sourceSha256: m0.rawEvidenceSha256,
      selectedConditionId: selectedAudit.conditionId,
      deterministicCatchRate: selectedAudit.catchRate,
      deterministicFalseRejectRate: selectedAudit.falseRejectRate,
      invalidReplyRate: selectedAudit.invalidReplyRate,
      p50LatencyMs: selectedAudit.p50LatencyMs,
      p95LatencyMs: selectedAudit.p95LatencyMs,
    },
    recoveryEvidence: {
      sourceSha256: recovery.resultSha256,
      winner: recovery.winner,
      deliveredValidity: recovery.medium.deliveredValidity,
      meanBlindGrade: recovery.medium.meanGrade,
      evidenceLabel: 'corrected-gate evidence' as const,
    },
    contracts: {
      scenePort: 'SceneModelPort.streamPropose' as const,
      auditPort: 'VisionAuditPort.inspect' as const,
      strictProductionStepSchema: strictFormat,
      productionStepSchemaSha256: input.historicalProductionStepSchemaSha256 ?? createHash('sha256')
        .update(JSON.stringify(DIRECTOR_STREAM_RESPONSE_FORMAT.json_schema.schema))
        .digest('hex'),
      legacyTextModelDrivesDrawingRoles: readRuntimeConfig({ OPENAI_MODEL: 'legacy-text-model' }).directorModel !== 'gpt-5.6-terra',
      piiSentinelEscaped: payload.includes(privateSentinel),
    },
    liveSmoke: {
      status: 'requires_fresh_authorization' as const,
      providerCalls: 0,
      costUsd: 0,
      claim: 'not_live_verified' as const,
    },
  };
}

export function compileM2RoleAdoptionEvidence(input: {
  m0RawJson: string;
  recoveryRawJson: string;
  resultRawJson: string;
}) {
  const resultSha256 = createHash('sha256').update(input.resultRawJson).digest('hex');
  if (resultSha256 !== manifest.resultSha256) throw new Error('M2 role-adoption result hash does not match the manifest.');
  const stored = StoredSchema.parse(JSON.parse(input.resultRawJson));
  const recomputed = buildM2RoleAdoptionEvidence({
    m0RawJson: input.m0RawJson,
    recoveryRawJson: input.recoveryRawJson,
    generatedAt: stored.generatedAt,
    historicalProductionStepSchemaSha256: stored.contracts.productionStepSchemaSha256,
  });
  if (
    recomputed.auditEvidence.sourceSha256 !== manifest.m0SourceSha256 ||
    recomputed.recoveryEvidence.sourceSha256 !== manifest.recoverySourceSha256 ||
    !isDeepStrictEqual(JSON.parse(input.resultRawJson), recomputed)
  ) {
    throw new Error('M2 role-adoption evidence does not reproduce from immutable sources and runtime contracts.');
  }
  return { resultSha256, report: recomputed };
}
