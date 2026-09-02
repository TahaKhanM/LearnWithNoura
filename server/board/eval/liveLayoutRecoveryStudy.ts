import type OpenAI from 'openai';
import type { AddOp, BoardOp } from '../../../shared/boardOps.js';
import { buildDirectedScene, applyDirectorBoardPolicy, type DirectedScene } from '../directorSchema.js';
import type { DirectorSceneRequest } from '../director.js';
import { IncrementalDirectorStreamParser } from '../directorStreamParser.js';
import { parseDirectorStreamProposal } from '../directorStreamSchema.js';
import { correctLayoutOnce } from '../layoutCorrection.js';
import { createOpenAIDirectorLayoutCorrectionPort, type DirectorStreamUsage } from '../directorStreamingService.js';
import type { HeadlessSceneValidatorHandle } from '../../lesson/headlessSceneValidator.js';
import { loadDirectorEvalCorpus } from './corpus.js';
import {
  compositionCallReserveUsd,
  DIRECTOR_PROPOSAL_MAX_COMPLETION_TOKENS,
  estimateUsageCostUsd,
} from './budget.js';
import { blindRasterGrade, renderStoryboardRasters, SpendGuard } from './liveDirectorEval.js';
import {
  buildLayoutFailureCohort,
  compileLayoutFailureFeedbackEvidence,
  F9_LAYOUT_RECOVERY_POLICY,
  LAYOUT_CORRECTION_CALL_RESERVE_USD,
  layoutRecoveryBudgetPlan,
  runStagedRecoveryDecision,
  type LayoutFailureCohortRow,
  type RecoveryCandidate,
} from './layoutRecoveryStudy.js';
import { runStreamingProbe } from './streamingProbe.js';
import type { DirectorEvalIntent } from './types.js';
import type { SpendLedgerEvent, SpendUsageEvidence } from './spendLedger.js';

interface LiveRecoveryCandidate {
  scene: DirectedScene | null;
  intent: DirectorEvalIntent;
  existingOps: BoardOp[];
  code: string;
}

export async function runAuthorizedLayoutRecoveryStudy(input: {
  client: OpenAI;
  harness: HeadlessSceneValidatorHandle;
  sourceRawJson: string;
  observationsRawJson: string;
  feedbackRawJson: string;
  maxSpendUsd: number;
  onProgress?: (message: string) => void;
  onSpendEvent?: (event: SpendLedgerEvent) => void;
}) {
  if (!Number.isFinite(input.maxSpendUsd) || input.maxSpendUsd <= 0 ||
      input.maxSpendUsd > F9_LAYOUT_RECOVERY_POLICY.maximumLiveSpendUsd) {
    throw new Error(`F9 live spend cap must be positive and no greater than $${F9_LAYOUT_RECOVERY_POLICY.maximumLiveSpendUsd}.`);
  }
  const cohort = buildLayoutFailureCohort(input.sourceRawJson, input.observationsRawJson);
  const feedbackEvidence = compileLayoutFailureFeedbackEvidence(
    input.sourceRawJson,
    input.observationsRawJson,
    input.feedbackRawJson,
  );
  const budget = layoutRecoveryBudgetPlan({ failureCount: cohort.length, gradeRecoverySample: true });
  if (budget.conservativeTotalUsd > input.maxSpendUsd) {
    throw new Error(`F9 conservative plan $${budget.conservativeTotalUsd} exceeds the authorized $${input.maxSpendUsd} cap.`);
  }
  const intents = new Map(loadDirectorEvalCorpus().map((intent) => [intent.id, intent]));
  const feedback = new Map(feedbackEvidence.artifact.rows.map((row) => [row.sourceKey, row]));
  const runId = `drawing-f9-${new Date().toISOString().replace(/[^0-9A-Za-z]/g, '-')}`;
  const spend = new SpendGuard(input.maxSpendUsd, input.onSpendEvent, runId);

  const decision = await runStagedRecoveryDecision<LiveRecoveryCandidate>({
    rows: cohort,
    runMedium: async (row) => {
      input.onProgress?.(`[drawing-f9] medium ${row.sourceKey}`);
      return runMediumArm(input.client, input.harness, spend, row, requireIntent(intents, row));
    },
    runCorrection: async (row) => {
      input.onProgress?.(`[drawing-f9] correction ${row.sourceKey}`);
      const rowFeedback = feedback.get(row.sourceKey);
      if (!rowFeedback) throw new Error(`F9 feedback omits ${row.sourceKey}.`);
      return runCorrectionArm(input.client, input.harness, spend, row, requireIntent(intents, row), rowFeedback);
    },
    grade: async (candidate) => {
      if (!candidate.scene) return { valid: false, grade: 1 };
      const rasters = await renderStoryboardRasters(
        input.harness,
        candidate.intent,
        candidate.scene,
        candidate.existingOps,
      );
      if (rasters.length !== candidate.scene.storyboard.length) {
        throw new Error(`F9 could not render every cumulative reveal for ${candidate.intent.id}.`);
      }
      const grade = await blindRasterGrade(
        input.client,
        spend,
        candidate.intent,
        rasters,
        candidate.scene.storyboard.map((step) => ({ reveal: step.reveal, narration: step.narration })),
        1,
        1,
      );
      return { valid: grade.valid, grade: grade.grade };
    },
  });
  const ledger = spend.snapshot();
  if (ledger.openReservationUsd !== 0) throw new Error('F9 study ended with an open spend reservation.');
  if (ledger.providerCalls > F9_LAYOUT_RECOVERY_POLICY.maximumFullProviderCalls) {
    throw new Error('F9 study exceeded its provider-call ceiling.');
  }
  return {
    schemaVersion: '1.0.0' as const,
    evidenceMode: 'authorized_live_synthetic_layout_recovery' as const,
    evidenceBoundary: 'Fresh provider recovery calls over the 31 immutable synthetic Terra-low layout failures; local connected-browser validation and blind grading; no child data.',
    realChildData: false as const,
    generatedAt: new Date().toISOString(),
    providerCalls: ledger.providerCalls,
    observedCostUsd: ledger.observedCostUsd,
    accountedCostUsd: ledger.accountedCostUsd,
    maxSpendUsd: ledger.maxSpendUsd,
    source: {
      m0Sha256: F9_LAYOUT_RECOVERY_POLICY.sourceEvidenceSha256,
      m1BrowserSha256: F9_LAYOUT_RECOVERY_POLICY.m1BrowserObservationSha256,
      layoutFeedbackSha256: feedbackEvidence.feedbackSha256,
      failureRows: cohort.length,
    },
    budget,
    decision: {
      stage: decision.stage,
      winner: decision.winner,
      attempts: decision.attempts,
      judgeCalls: decision.judgeCalls,
      summaries: decision.summaries,
      canary: decision.canary,
      rows: decision.rows,
    },
    spendLedger: ledger,
  };
}

async function runMediumArm(
  client: OpenAI,
  harness: HeadlessSceneValidatorHandle,
  spend: SpendGuard,
  row: LayoutFailureCohortRow,
  intent: DirectorEvalIntent,
): Promise<RecoveryCandidate<LiveRecoveryCandidate>> {
  const existingOps = intent.existingBoardOps ?? [];
  const visibleObjectIds = existingOps.flatMap((op) => op.op === 'add' ? [op.id] : []);
  const boardRaster = existingOps.length > 0
    ? await harness.render(existingOps, `existing-${intent.id}`)
    : null;
  if (existingOps.length > 0 && !boardRaster) throw new Error(`F9 could not render existing context for ${row.sourceKey}.`);
  const maxCompletionTokens = DIRECTOR_PROPOSAL_MAX_COMPLETION_TOKENS['gpt-5.6-terra'].medium;
  const reserve = compositionCallReserveUsd('gpt-5.6-terra', 'cold', Boolean(boardRaster), 'medium', maxCompletionTokens);
  const callId = spend.begin({ phase: 'recovery_escalation', models: ['gpt-5.6-terra'], reserveUsd: reserve });
  spend.noteProviderCalls(callId, 1);
  let probe: Awaited<ReturnType<typeof runStreamingProbe>>;
  try {
    probe = await runStreamingProbe({
      client,
      intent,
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      maxCompletionTokens,
      cacheState: 'warm',
      trialKey: `f9-medium:${row.sourceKey}`,
      currentBoardRaster: boardRaster,
      visibleObjectIds,
      validateFirstStep: async (ops) => (await harness.validate([...existingOps, ...ops])).ok,
    });
  } catch (error) {
    spend.complete(callId, { status: 'failed', observedCostUsd: 0, upperBoundUsd: reserve, usage: [] });
    throw error;
  }
  settleProbeSpend(spend, callId, reserve, probe);
  if (!probe.usageComplete) throw new Error(`F9 medium call lacks usage evidence for ${row.sourceKey}.`);
  const scene = await sceneFromProposal(harness, intent, probe.text, existingOps, visibleObjectIds);
  return {
    valid: scene !== null,
    value: { scene, intent, existingOps, code: scene ? 'accepted' : 'rejected' },
  };
}

async function runCorrectionArm(
  client: OpenAI,
  harness: HeadlessSceneValidatorHandle,
  spend: SpendGuard,
  row: LayoutFailureCohortRow,
  intent: DirectorEvalIntent,
  feedback: {
    failingStepIndex: number;
    layoutIssues: Parameters<typeof correctLayoutOnce>[1]['layoutIssues'];
  },
): Promise<RecoveryCandidate<LiveRecoveryCandidate>> {
  const existingOps = intent.existingBoardOps ?? [];
  const visibleObjectIds = existingOps.flatMap((op) => op.op === 'add' ? [op.id] : []);
  const parser = new IncrementalDirectorStreamParser({ density: intent.density, visibleObjectIds });
  const steps = parser.push(row.lowProposalText);
  const proposal = parser.finish();
  const failed = steps[feedback.failingStepIndex];
  if (!failed) throw new Error(`F9 correction step is missing for ${row.sourceKey}.`);
  let usage: DirectorStreamUsage | null = null;
  const reserve = LAYOUT_CORRECTION_CALL_RESERVE_USD;
  const callId = spend.begin({ phase: 'layout_correction', models: ['gpt-5.6-terra'], reserveUsd: reserve });
  spend.noteProviderCalls(callId, 1);
  const request = sceneRequest(intent, existingOps, visibleObjectIds);
  let corrected: Awaited<ReturnType<typeof correctLayoutOnce>>;
  try {
    const port = createOpenAIDirectorLayoutCorrectionPort({
      client,
      model: 'gpt-5.6-terra',
      reasoningEffort: 'low',
      maxCompletionTokens: 1_000,
      onUsage: (value) => { usage = value; },
    });
    corrected = await correctLayoutOnce(port, {
      request,
      priorOps: failed.priorOps,
      rejectedOps: failed.ops,
      layoutIssues: feedback.layoutIssues,
      signal: new AbortController().signal,
    });
  } catch (error) {
    spend.complete(callId, { status: 'failed', observedCostUsd: 0, upperBoundUsd: reserve, usage: [] });
    throw error;
  }
  settleCorrectionSpend(spend, callId, reserve, usage);
  if (!usage) throw new Error(`F9 correction call lacks usage evidence for ${row.sourceKey}.`);
  if (!corrected.ok) {
    return { valid: false, value: { scene: null, intent, existingOps, code: corrected.code } };
  }
  const stepOps = steps.map((step, index) => index === feedback.failingStepIndex ? corrected.ops : step.ops);
  const allOps = stepOps.flat();
  const policy = applyDirectorBoardPolicy(allOps, { density: intent.density, visibleObjectIds });
  if (!policy.ok) return { valid: false, value: { scene: null, intent, existingOps, code: 'policy_rejected' } };
  const scene = buildDirectedScene({
    groupId: `eval-${intent.id}`.replace(/[^a-z0-9_-]/gi, '-').slice(0, 80),
    groupLabel: proposal.groupLabel,
    ops: policy.ops,
    storyboard: steps.map((step, index) => ({
      id: step.step.id,
      reveal: step.step.reveal,
      narration: step.step.narration,
      objectIds: stepOps[index].map((op) => op.id),
    })),
  });
  const accepted = await validateCumulativeScene(harness, existingOps, scene);
  return {
    valid: accepted,
    value: { scene: accepted ? scene : null, intent, existingOps, code: accepted ? 'accepted' : 'browser_rejected' },
  };
}

async function sceneFromProposal(
  harness: HeadlessSceneValidatorHandle,
  intent: DirectorEvalIntent,
  proposalText: string,
  existingOps: BoardOp[],
  visibleObjectIds: string[],
): Promise<DirectedScene | null> {
  try {
    const proposal = parseDirectorStreamProposal(proposalText, intent.density);
    const policy = applyDirectorBoardPolicy(proposal.ops, { density: intent.density, visibleObjectIds });
    if (!policy.ok) return null;
    const scene = buildDirectedScene({
      groupId: `eval-${intent.id}`.replace(/[^a-z0-9_-]/gi, '-').slice(0, 80),
      groupLabel: proposal.groupLabel,
      ops: policy.ops,
      storyboard: proposal.storyboard,
    });
    return await validateCumulativeScene(harness, existingOps, scene) ? scene : null;
  } catch {
    return null;
  }
}

async function validateCumulativeScene(
  harness: HeadlessSceneValidatorHandle,
  existingOps: BoardOp[],
  scene: DirectedScene,
): Promise<boolean> {
  const byId = new Map(scene.ops.flatMap((op) => op.op === 'add' ? [[op.id, op] as const] : []));
  const cumulative: AddOp[] = [];
  for (const step of scene.storyboard) {
    for (const id of step.objectIds) {
      const op = byId.get(id);
      if (op) cumulative.push(op);
    }
    if (!(await harness.validate([...existingOps, ...cumulative])).ok) return false;
  }
  return cumulative.length === scene.ops.length;
}

function sceneRequest(
  intent: DirectorEvalIntent,
  existingOps: BoardOp[],
  visibleObjectIds: string[],
): DirectorSceneRequest {
  return {
    purpose: intent.purpose,
    idea: intent.intent,
    constraints: null,
    density: intent.density,
    targetObjectIds: [],
    sectionId: `eval-${intent.id}`.replace(/[^a-z0-9_-]/gi, '-').slice(0, 80),
    sectionLabel: intent.intent.slice(0, 160),
    boardSummary: intent.existingBoardDescription ?? 'empty',
    visibleObjectIds,
    currentBoardOps: existingOps,
    stageBrief: 'Synthetic F9 recovery study.',
    learnerContext: 'Synthetic evaluation intent; no learner data is present.',
  };
}

function settleProbeSpend(
  spend: SpendGuard,
  callId: string,
  reserve: number,
  probe: Awaited<ReturnType<typeof runStreamingProbe>>,
): void {
  spend.complete(callId, {
    status: 'completed',
    observedCostUsd: probe.estimatedCostUsd,
    upperBoundUsd: probe.usageComplete ? probe.costUpperBoundUsd : reserve,
    usage: probe.usageComplete ? [{ model: 'gpt-5.6-terra', ...probe.usage, usageComplete: true }] : [],
  });
}

function settleCorrectionSpend(
  spend: SpendGuard,
  callId: string,
  reserve: number,
  usage: DirectorStreamUsage | null,
): void {
  const observedCostUsd = usage ? estimateUsageCostUsd('gpt-5.6-terra', usage) : 0;
  const evidence: SpendUsageEvidence[] = usage
    ? [{ model: 'gpt-5.6-terra', ...usage, usageComplete: true }]
    : [];
  spend.complete(callId, {
    status: 'completed',
    observedCostUsd,
    upperBoundUsd: usage ? observedCostUsd : reserve,
    usage: evidence,
  });
}

function requireIntent(
  intents: Map<string, DirectorEvalIntent>,
  row: LayoutFailureCohortRow,
): DirectorEvalIntent {
  const intent = intents.get(row.intentId);
  if (!intent) throw new Error(`F9 corpus omits ${row.intentId}.`);
  return intent;
}
