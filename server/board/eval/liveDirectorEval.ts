import type OpenAI from 'openai';
import { createHash, randomUUID } from 'node:crypto';
import rubric from './fixtures/director-raster-rubric.json' with { type: 'json' };
import { createHeadlessSceneValidator } from '../../lesson/headlessSceneValidator.js';
import type { HeadlessSceneValidatorHandle } from '../../lesson/headlessSceneValidator.js';
import { applyDirectorBoardPolicy, buildDirectedScene } from '../directorSchema.js';
import {
  DIRECTOR_EVAL_CONDITIONS,
  isDirectorQualitySampleIntent,
  loadDirectorEvalCorpus,
  loadDirectorQualitySampleIntentIds,
  loadSeededDefects,
  materializeSketchCorpus,
} from './corpus.js';
import { chooseCompositionWinner } from './decision.js';
import {
  runAccountedChatCompletion,
  runLiveSketchStudy,
  runLiveVisionAudit,
  StudyProviderError,
  type LiveStudySpend,
} from './liveStudies.js';
import { runStreamingProbe, type StreamingProbeResult } from './streamingProbe.js';
import type { ConditionSummary, DirectorEvalCondition, DirectorEvalIntent, DirectorEvalTrial } from './types.js';
import {
  directorTrialKey,
  type DirectorResumeEvidence,
} from './resumeEvidence.js';
import { parseVNextEvalDirectorProposal } from './vnextEvalSchema.js';
import {
  compositionCallReserveUsd,
  DIRECTOR_MIN_WARM_CACHED_INPUT_TOKENS,
  judgeCallReserveUsd,
  plannedLiveBudget,
} from './budget.js';
import {
  LiveSpendLedger,
  SpendCapError,
  type LiveEvalModel,
  type SpendLedgerEvent,
  type SpendUsageEvidence,
} from './spendLedger.js';

const LIVE_TRIALS = 5;
const BLIND_QUALITY_SAMPLE_TRIAL = 1;

export class SpendGuard extends LiveSpendLedger implements LiveStudySpend {
  judgeInvalidResponseRetries = 0;
}

class ProviderEvidenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderEvidenceError';
  }
}

class OutputCapEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputCapEvidenceError';
  }
}

export async function runLiveDirectorEval(input: {
  client: OpenAI;
  harnessUrl: string;
  maxSpendUsd: number;
  priorReservedUsd?: number;
  runId?: string;
  onProgress?: (message: string) => void;
  onCheckpoint?: (checkpoint: { trial: DirectorEvalTrial; providerCalls: number; accountedCostUsd: number }) => void;
  onSpendEvent?: (event: SpendLedgerEvent) => void;
  resumeEvidence?: DirectorResumeEvidence;
  /** Scripted tests inject the same narrow production harness port. */
  harness?: HeadlessSceneValidatorHandle;
}) {
  const priorReservedUsd = input.priorReservedUsd ?? 0;
  const sessionHardCapUsd = 30;
  if (!Number.isFinite(priorReservedUsd) || priorReservedUsd < 0) {
    throw new SpendCapError('Prior reserved spend must be a finite non-negative value. No provider call was made.');
  }
  const combinedMaximumUsd = round(priorReservedUsd + input.maxSpendUsd, 10);
  if (combinedMaximumUsd > sessionHardCapUsd) {
    throw new SpendCapError(
      `Prior liability plus this run's cap would cross the $${sessionHardCapUsd} session authorization. No provider call was made.`,
    );
  }
  const corpus = loadDirectorEvalCorpus();
  const qualitySampleIntentIds = loadDirectorQualitySampleIntentIds();
  const budgetPlan = plannedLiveBudget({
    intentCount: corpus.length,
    judgedIntentCount: qualitySampleIntentIds.length,
    trialsPerCacheState: LIVE_TRIALS,
    judgedTrialsPerCacheState: 1,
    judgedCacheStateCount: 1,
    conditions: DIRECTOR_EVAL_CONDITIONS,
    defectCount: loadSeededDefects().length,
    sketchCount: materializeSketchCorpus().length,
    contextRasterIntentCount: corpus.filter((intent) => (intent.existingBoardOps?.length ?? 0) > 0).length,
  });
  const conservativePlanFitsRunCap = budgetPlan.conservativeTotalUsd <= input.maxSpendUsd;
  const runId = input.runId ?? `director-eval-${randomUUID()}`;
  const spend = new SpendGuard(input.maxSpendUsd, input.onSpendEvent, runId);
  const harness = input.harness ?? createHeadlessSceneValidator({ harnessUrl: input.harnessUrl });
  const ownsHarness = !input.harness;
  const trials: DirectorEvalTrial[] = [...(input.resumeEvidence?.trials ?? [])];
  const completedTrialKeys = new Set(trials.map(directorTrialKey));
  if (completedTrialKeys.size !== trials.length) {
    throw new Error('Resume evidence contains duplicate Director trial rows.');
  }
  let visionAudit: Awaited<ReturnType<typeof runLiveVisionAudit>> | null = null;
  let sketchGrounding: Awaited<ReturnType<typeof runLiveSketchStudy>> | null = null;
  let stopReason: string | null = null;
  try {
    const warmed = new Set<string>();
    trialLoop:
    for (let trial = 1; trial <= LIVE_TRIALS; trial += 1) {
      for (const intent of corpus) {
        for (const cacheState of ['cold', 'warm'] as const) {
          if (cacheState === 'warm') {
            await ensureWarmConfigurations({ client: input.client, spend, warmed, intent });
          }
          for (const condition of DIRECTOR_EVAL_CONDITIONS) {
            const expectedKey = `${intent.id}:${condition.id}:${cacheState}:${trial}`;
            if (completedTrialKeys.has(expectedKey)) continue;
            input.onProgress?.(`[director-eval] ${condition.id} ${intent.id} ${cacheState} ${trial}/${LIVE_TRIALS}`);
            const completedTrial = await runCompositionTrial({
              client: input.client,
              harness,
              spend,
              condition,
              intent,
              cacheState,
              trial,
              runId,
            });
            trials.push(completedTrial);
            completedTrialKeys.add(directorTrialKey(completedTrial));
            input.onCheckpoint?.({
              trial: completedTrial,
              providerCalls: spend.providerCalls,
              accountedCostUsd: spend.accountedCostUsd,
            });
            if (trialHitOutputCeiling(completedTrial)) {
              throw new OutputCapEvidenceError(
                `A ${completedTrial.conditionId} leg hit its configured proposal ceiling for ${completedTrial.intentId}; the run stopped before collecting censored evidence.`,
              );
            }
          }
        }
      }
      const completed = summarizeConditions(trials, corpus.length * 2 * trial);
      const dominant = conditionDominatingByMoreThan2x(completed);
      if (dominant) {
        stopReason = `pre_registered_dominance:${dominant}`;
        break trialLoop;
      }
    }
    visionAudit = await runLiveVisionAudit({ client: input.client, harness, spend });
    sketchGrounding = await runLiveSketchStudy({ client: input.client, harness, spend });
  } catch (error) {
    if (error instanceof SpendCapError) stopReason = `spend_cap:${error.message}`;
    else throw error;
  } finally {
    if (ownsHarness) await harness.close();
  }

  const rowsPerCondition = trials.length / DIRECTOR_EVAL_CONDITIONS.length;
  const conditionSummaries = summarizeConditions(trials, rowsPerCondition);
  const completeComposition = conditionSummaries.length === DIRECTOR_EVAL_CONDITIONS.length || stopReason?.startsWith('pre_registered_dominance:');
  const cacheEvidenceComplete = cacheEvidenceSufficient(trials);
  const qualitySampleRows = trials.filter((trial) => trial.qualitySampled);
  const qualityEvidenceComplete = qualitySampleRows.length === budgetPlan.judgeCalls &&
    qualitySampleRows.every((trial) => !trial.validatorPassed || trial.qualityEvidenceComplete);
  const compositionDecision = chooseCompositionWinner(conditionSummaries);
  const transportRetryProviderCalls = spend.entries
    .filter((entry) => entry.status === 'failed')
    .reduce((total, entry) => total + entry.providerCallCount, 0);
  const pass = Boolean(
    completeComposition && cacheEvidenceComplete && qualityEvidenceComplete &&
    visionAudit && sketchGrounding &&
    !stopReason?.startsWith('spend_cap:'),
  );
  return {
    schemaVersion: '1.0.0' as const,
    pass,
    evidenceMode: 'authorized_live_synthetic' as const,
    evidenceBoundary: 'Synthetic checked-in intents and synthetic board/sketch rasters only; no child data. Provider latency and output quality are live for this run; browser validation is the configured local board harness.',
    realChildData: false as const,
    providerCalls: spend.providerCalls,
    transportRetryProviderCalls,
    judgeInvalidResponseRetries: spend.judgeInvalidResponseRetries,
    estimatedCostUsd: spend.estimatedCostUsd,
    accountedCostUsd: spend.accountedCostUsd,
    maxSpendUsd: spend.maxSpendUsd,
    authorizationLedger: {
      sessionHardCapUsd,
      priorReservedUsd,
      runMaxSpendUsd: spend.maxSpendUsd,
      combinedMaximumUsd,
    },
    spendLedger: spend.snapshot(),
    costSource: 'official rate-card estimate from provider token usage; cache writes are 1.25x and aborted legs without final usage are charged their conservative reservation' as const,
    pricingSource: 'https://developers.openai.com/api/docs/models/compare (checked 2026-08-30)',
    stoppedEarly: stopReason,
    resumedEvidence: input.resumeEvidence?.metadata ?? null,
    conservativePlanFitsRunCap,
    budgetPlan,
    cacheEvidenceComplete,
    qualityEvidenceComplete,
    qualitySample: {
      preregisteredTrial: BLIND_QUALITY_SAMPLE_TRIAL,
      cacheState: 'cold' as const,
      intentIds: qualitySampleIntentIds,
      plannedRows: budgetPlan.judgeCalls,
      observedRows: qualitySampleRows.length,
      eligibleRows: qualitySampleRows.filter((trial) => trial.validatorPassed).length,
      gradedRows: qualitySampleRows.filter((trial) => trial.qualityEvidenceComplete).length,
    },
    corpus: {
      representative: corpus.filter((entry) => entry.split === 'representative').length,
      holdout: corpus.filter((entry) => entry.split === 'holdout').length,
      total: corpus.length,
    },
    conditions: DIRECTOR_EVAL_CONDITIONS,
    trials,
    conditionSummaries,
    compositionDecision: {
      status: 'authorized_live_evidence' as const,
      ...compositionDecision,
    },
    visionAudit,
    sketchGrounding,
    rasterRubric: rubric,
  };
}

async function ensureWarmConfigurations(input: {
  client: OpenAI;
  spend: SpendGuard;
  warmed: Set<string>;
  intent: DirectorEvalIntent;
}): Promise<void> {
  const legs = DIRECTOR_EVAL_CONDITIONS.flatMap((condition) => condition.legs);
  for (const leg of legs) {
    const key = `${leg.model}:${leg.reasoningEffort}`;
    if (input.warmed.has(key)) continue;
    const reserve = compositionCallReserveUsd(
      leg.model, 'cold', false, leg.reasoningEffort, leg.maxCompletionTokens,
    );
    let probe: StreamingProbeResult | null = null;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3 && probe === null; attempt += 1) {
      if (attempt > 1) await defaultTransportRetryDelay(attempt as 2 | 3);
      const callId = input.spend.begin({ phase: 'warmup', models: [leg.model], reserveUsd: reserve });
      input.spend.noteProviderCalls(callId, 1);
      try {
        probe = await runStreamingProbe({
          client: input.client,
          intent: input.intent,
          model: leg.model,
          reasoningEffort: leg.reasoningEffort,
          maxCompletionTokens: leg.maxCompletionTokens,
          cacheState: 'warm',
          trialKey: `warmup:${key}:transport-${attempt}`,
        });
        input.spend.complete(callId, {
          status: 'completed',
          observedCostUsd: probe.estimatedCostUsd,
          upperBoundUsd: probe.costUpperBoundUsd,
          usage: probeSpendUsage(probe, [leg.model]),
        });
      } catch (error) {
        input.spend.complete(callId, {
          status: 'failed',
          observedCostUsd: 0,
          upperBoundUsd: reserve,
          usage: [],
        });
        lastError = error;
      }
    }
    if (!probe) {
      throw new ProviderEvidenceError('Warmup transport failed after two bounded retries.', {
        cause: lastError,
      });
    }
    input.warmed.add(key);
  }
}

export async function runCompositionTrial(input: {
  client: OpenAI;
  harness: ReturnType<typeof createHeadlessSceneValidator>;
  spend: SpendGuard;
  condition: DirectorEvalCondition;
  intent: DirectorEvalIntent;
  cacheState: 'cold' | 'warm';
  trial: number;
  runId?: string;
  transportRetryDelay?: (attempt: 2 | 3) => Promise<void>;
}): Promise<DirectorEvalTrial> {
  const trialKey = `${input.runId ?? 'scripted-test'}:${input.condition.id}:${input.intent.id}:${input.cacheState}:${input.trial}`;
  const existingOps = input.intent.existingBoardOps ?? [];
  const visibleObjectIds = existingOps.flatMap((op) => op.op === 'add' ? [op.id] : []);
  const currentBoardRaster = existingOps.length > 0
    ? await input.harness.render(existingOps, `existing-${input.intent.id}`)
    : null;
  if (existingOps.length > 0 && !currentBoardRaster) {
    throw new Error(`Could not render existing-board context for ${input.intent.id}.`);
  }
  const probe = await runConditionProbeWithTransportRetry(input, trialKey, {
    currentBoardRaster,
    existingOps,
    visibleObjectIds,
  });
  let strictSchemaValid = false;
  let validatorPassed = false;
  let storyboardCoverage = false;
  const qualitySampled = input.trial === BLIND_QUALITY_SAMPLE_TRIAL &&
    input.cacheState === 'cold' && isDirectorQualitySampleIntent(input.intent.id);
  let qualityGrade: number | null = null;
  let qualityEvidenceComplete = false;
  const validationReasons: string[] = [];
  let judgeReasons: string[] = [];
  let rasterHashes: string[] = [];
  try {
    const proposal = parseVNextEvalDirectorProposal(probe.text, input.intent.density);
    strictSchemaValid = true;
    const policy = applyDirectorBoardPolicy(proposal.ops, {
      density: input.intent.density,
      visibleObjectIds,
    });
    if (policy.ok) {
      const scene = buildDirectedScene({
        groupId: `eval-${input.intent.id}`.replace(/[^a-z0-9_-]/gi, '-').slice(0, 80),
        groupLabel: proposal.groupLabel,
        ops: policy.ops,
        storyboard: proposal.storyboard,
      });
      storyboardCoverage = true;
      const combinedOps = [...existingOps, ...scene.ops];
      const validation = await input.harness.validate(combinedOps);
      validatorPassed = validation.ok;
      if (!validation.ok) validationReasons.push(...validation.issues);
      if (validation.ok && qualitySampled) {
        const rasters = await renderStoryboardRasters(input.harness, input.intent, scene, existingOps);
        rasterHashes = rasters.map(hashRaster);
        if (rasters.length === scene.storyboard.length) {
          const judged = await blindRasterGrade(
            input.client,
            input.spend,
            input.intent,
            rasters,
            scene.storyboard.map((step) => ({ reveal: step.reveal, narration: step.narration })),
          );
          qualityGrade = judged.grade;
          judgeReasons = judged.reasons;
          qualityEvidenceComplete = judged.valid;
        } else {
          validationReasons.push('One or more ordered storyboard rasters could not be rendered.');
        }
      }
    } else validationReasons.push(...policy.reasons);
  } catch (error) {
    if (error instanceof SpendCapError || error instanceof ProviderEvidenceError ||
        error instanceof StudyProviderError) throw error;
    validationReasons.push(String(error instanceof Error ? error.message : error).slice(0, 500));
    // First-pass validity metrics deliberately retain malformed/rejected rows.
  }
  const selectedLegIndex = probe.selectedLegIndex ?? 0;
  const modelUsage = probe.legUsage ?? [{
    model: input.condition.legs[selectedLegIndex]?.model ?? input.condition.legs[0].model,
    usage: probe.usage,
    usageComplete: probe.usageComplete,
    finishReason: probe.finishReason,
    maxCompletionTokens: probe.maxCompletionTokens,
  }];
  const selectedUsage = modelUsage[selectedLegIndex]?.usage ?? probe.usage;
  const cacheExpectationMet = input.cacheState === 'warm'
    ? selectedUsage.cachedInputTokens >= DIRECTOR_MIN_WARM_CACHED_INPUT_TOKENS
    : selectedUsage.cachedInputTokens === 0;
  return {
    intentId: input.intent.id,
    split: input.intent.split,
    conditionId: input.condition.id,
    cacheState: input.cacheState,
    trial: input.trial,
    ttftMs: probe.ttftMs,
    firstValidOpMs: probe.firstValidOpMs,
    firstStepStatus: probe.firstStepStatus,
    completeSceneMs: probe.completeMs,
    strictSchemaValid,
    validatorPassed,
    storyboardCoverage,
    qualitySampled,
    qualityGrade,
    qualityEvidenceComplete,
    cacheExpectationMet,
    inputTokens: probe.usage.inputTokens,
    cachedInputTokens: probe.usage.cachedInputTokens,
    cacheWriteTokens: probe.usage.cacheWriteTokens,
    outputTokens: probe.usage.outputTokens,
    usageComplete: probe.usageComplete,
    finishReason: probe.finishReason,
    maxCompletionTokens: probe.maxCompletionTokens,
    selectedLegIndex,
    modelUsage: modelUsage.map((entry) => ({
      model: entry.model,
      ...entry.usage,
      usageComplete: entry.usageComplete,
      finishReason: entry.finishReason,
      maxCompletionTokens: entry.maxCompletionTokens,
    })),
    costUsd: probe.estimatedCostUsd,
    costUpperBoundUsd: probe.costUpperBoundUsd,
    proposalText: probe.text,
    validationReasons,
    judgeReasons,
    rasterHashes,
  };
}

async function runConditionProbeWithTransportRetry(
  input: Parameters<typeof runCompositionTrial>[0],
  trialKey: string,
  context: Parameters<typeof runConditionProbe>[2],
): Promise<StreamingProbeResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) {
      const retryAttempt = attempt as 2 | 3;
      await (input.transportRetryDelay ?? defaultTransportRetryDelay)(retryAttempt);
    }
    try {
      return await runConditionProbe(input, `${trialKey}:transport-${attempt}`, context);
    } catch (error) {
      if (error instanceof SpendCapError) throw error;
      lastError = error;
    }
  }
  throw new ProviderEvidenceError('Composition transport failed after two bounded retries.', {
    cause: lastError,
  });
}

function defaultTransportRetryDelay(attempt: 2 | 3): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, attempt === 2 ? 1_000 : 3_000));
}

export async function runConditionProbe(
  input: Parameters<typeof runCompositionTrial>[0],
  trialKey: string,
  context: {
    currentBoardRaster: string | null;
    existingOps: import('../../../shared/boardOps.js').BoardOp[];
    visibleObjectIds: string[];
  },
): Promise<StreamingProbeResult> {
  if (input.condition.legs.length === 1) {
    const leg = input.condition.legs[0];
    const reserve = compositionCallReserveUsd(
      leg.model, 'cold', Boolean(context.currentBoardRaster), leg.reasoningEffort,
      leg.maxCompletionTokens,
    );
    const callId = input.spend.begin({ phase: 'composition', models: [leg.model], reserveUsd: reserve });
    input.spend.noteProviderCalls(callId, 1);
    let result: StreamingProbeResult;
    try {
      result = await runStreamingProbe({
        client: input.client,
        intent: input.intent,
        model: leg.model,
        reasoningEffort: leg.reasoningEffort,
        maxCompletionTokens: leg.maxCompletionTokens,
        cacheState: input.cacheState,
        trialKey,
        currentBoardRaster: context.currentBoardRaster,
        visibleObjectIds: context.visibleObjectIds,
        validateFirstStep: async (ops) => (await input.harness.validate([...context.existingOps, ...ops])).ok,
      });
    } catch (error) {
      input.spend.complete(callId, {
        status: 'failed',
        observedCostUsd: 0,
        upperBoundUsd: reserve,
        usage: [],
      });
      throw error;
    }
    input.spend.complete(callId, {
      status: 'completed',
      observedCostUsd: result.estimatedCostUsd,
      upperBoundUsd: result.costUpperBoundUsd,
      usage: probeSpendUsage(result, [leg.model]),
    });
    return {
      ...result,
      selectedLegIndex: 0,
      legUsage: [{
        model: leg.model,
        usage: result.usage,
        usageComplete: result.usageComplete,
        finishReason: result.finishReason,
        maxCompletionTokens: result.maxCompletionTokens,
      }],
    };
  }
  const combinedReserve = input.condition.legs.reduce(
    (sum, leg) => sum + compositionCallReserveUsd(
      leg.model, 'cold', Boolean(context.currentBoardRaster), leg.reasoningEffort,
      leg.maxCompletionTokens,
    ),
    0,
  );
  const models = input.condition.legs.map((leg) => leg.model);
  const callId = input.spend.begin({ phase: 'composition', models, reserveUsd: combinedReserve });
  input.spend.noteProviderCalls(callId, input.condition.legs.length);
  const controllers = input.condition.legs.map(() => new AbortController());
  let winner = -1;
  const promises = input.condition.legs.map((leg, index) => {
    return runStreamingProbe({
      client: input.client,
      intent: input.intent,
      model: leg.model,
      reasoningEffort: leg.reasoningEffort,
      maxCompletionTokens: leg.maxCompletionTokens,
      cacheState: input.cacheState,
      trialKey: `${trialKey}:leg-${index}`,
      signal: controllers[index].signal,
      currentBoardRaster: context.currentBoardRaster,
      visibleObjectIds: context.visibleObjectIds,
      validateFirstStep: async (ops) => (await input.harness.validate([...context.existingOps, ...ops])).ok,
      onFirstValidStep: () => {
        if (winner >= 0) return;
        winner = index;
        controllers.forEach((controller, candidate) => { if (candidate !== index) controller.abort('hedge lost'); });
      },
    });
  });
  let results: StreamingProbeResult[];
  try {
    results = await Promise.all(promises);
  } catch (error) {
    controllers.forEach((controller) => controller.abort('hedge error'));
    input.spend.complete(callId, {
      status: 'failed',
      observedCostUsd: 0,
      upperBoundUsd: combinedReserve,
      usage: [],
    });
    throw error;
  }
  if (winner < 0) {
    const validResults = results.flatMap((result, index) => result.firstStepStatus === 'valid' && result.firstValidOpMs !== null
      ? [{ index, latency: result.firstValidOpMs }]
      : []);
    winner = validResults.sort((left, right) => left.latency - right.latency)[0]?.index ?? 0;
  }
  const chosen = results[Math.max(0, winner)];
  const combinedResult: StreamingProbeResult = {
    ...chosen,
    estimatedCostUsd: round(results.reduce((total, result) => total + result.estimatedCostUsd, 0), 8),
    costUpperBoundUsd: round(results.reduce((total, result) => total + result.costUpperBoundUsd, 0), 8),
    usageComplete: results.every((result) => result.usageComplete),
    selectedLegIndex: Math.max(0, winner),
    legUsage: results.map((result, index) => ({
      model: input.condition.legs[index].model,
      usage: result.usage,
      usageComplete: result.usageComplete,
      finishReason: result.finishReason,
      maxCompletionTokens: result.maxCompletionTokens,
    })),
    usage: {
      inputTokens: results.reduce((total, result) => total + result.usage.inputTokens, 0),
      cachedInputTokens: results.reduce((total, result) => total + result.usage.cachedInputTokens, 0),
      cacheWriteTokens: results.reduce((total, result) => total + result.usage.cacheWriteTokens, 0),
      outputTokens: results.reduce((total, result) => total + result.usage.outputTokens, 0),
    },
  };
  input.spend.complete(callId, {
    status: 'completed',
    observedCostUsd: combinedResult.estimatedCostUsd,
    upperBoundUsd: combinedResult.costUpperBoundUsd,
    usage: probeSpendUsage(combinedResult, models),
  });
  return combinedResult;
}

async function blindRasterGrade(
  client: OpenAI,
  spend: SpendGuard,
  intent: DirectorEvalIntent,
  rasters: string[],
  storyboard: Array<{ reveal: string; narration: string }>,
): Promise<{ grade: number; reasons: string[]; valid: boolean }> {
  const reserve = judgeCallReserveUsd();
  const judgeModel = rubric.judgeModel as 'gpt-5.6-luna';
  for (let semanticAttempt = 1; semanticAttempt <= 3; semanticAttempt += 1) {
    const { response } = await runAccountedChatCompletion({
    spend,
    phase: 'judge',
    model: judgeModel,
    reserveUsd: reserve,
    request: () => client.chat.completions.create({
    model: rubric.judgeModel,
    reasoning_effort: rubric.judgeReasoningEffort as 'low',
    max_completion_tokens: 1_000,
    prompt_cache_key: 'noura-director-raster-rubric-v1',
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'noura_director_raster_grade',
        strict: true,
        schema: {
          type: 'object', additionalProperties: false,
          properties: { grade: { type: 'number', minimum: 1, maximum: 5 }, reasons: { type: 'array', maxItems: 5, items: { type: 'string' } } },
          required: ['grade', 'reasons'],
        },
      },
    },
    messages: [
      { role: 'system', content: `Blindly grade an educational board raster from 1 to 5. Apply this fixed rubric: ${JSON.stringify(rubric.dimensions)}. Do not infer which model produced it. Return JSON only.` },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Requested idea: ${intent.intent}\nInspect these cumulative rasters in reveal order. Storyboard: ${JSON.stringify(storyboard)}` },
          ...rasters.flatMap((raster, index) => [
            { type: 'text' as const, text: `Cumulative reveal ${index + 1}` },
            { type: 'image_url' as const, image_url: { url: raster, detail: 'high' as const } },
          ]),
        ],
      },
    ],
    }),
    });
    const graded = parseJudgeGrade(response.choices[0]?.message?.content ?? '');
    if (graded.valid || semanticAttempt === 3) return graded;
    spend.judgeInvalidResponseRetries += 1;
  }
  return { grade: 1, reasons: ['Judge response was invalid JSON.'], valid: false };
}

function parseJudgeGrade(text: string): { grade: number; reasons: string[]; valid: boolean } {
  try {
    const parsed = JSON.parse(text) as { grade?: unknown; reasons?: unknown };
    return {
      grade: typeof parsed.grade === 'number' && Number.isFinite(parsed.grade)
        ? Math.max(1, Math.min(5, parsed.grade))
        : 1,
      reasons: Array.isArray(parsed.reasons)
        ? parsed.reasons.filter((reason): reason is string => typeof reason === 'string').slice(0, 5)
        : ['Judge returned no valid reasons.'],
      valid: typeof parsed.grade === 'number' && Number.isFinite(parsed.grade) && Array.isArray(parsed.reasons),
    };
  } catch {
    return { grade: 1, reasons: ['Judge response was invalid JSON.'], valid: false };
  }
}

async function renderStoryboardRasters(
  harness: ReturnType<typeof createHeadlessSceneValidator>,
  intent: DirectorEvalIntent,
  scene: ReturnType<typeof buildDirectedScene>,
  existingOps: import('../../../shared/boardOps.js').BoardOp[],
): Promise<string[]> {
  const opById = new Map(scene.ops.flatMap((op) => op.op === 'add' ? [[op.id, op] as const] : []));
  const cumulative = [...existingOps];
  const rasters: string[] = [];
  for (const step of scene.storyboard) {
    for (const objectId of step.objectIds) {
      const op = opById.get(objectId);
      if (op) cumulative.push(op);
    }
    const raster = await harness.render(cumulative, `eval-${intent.id}`);
    if (!raster) return rasters;
    rasters.push(raster);
  }
  return rasters;
}

function hashRaster(raster: string): string {
  return createHash('sha256').update(raster).digest('hex');
}

function probeSpendUsage(
  probe: StreamingProbeResult,
  models: LiveEvalModel[],
): SpendUsageEvidence[] {
  const legs = probe.legUsage ?? [{ model: models[0], usage: probe.usage, usageComplete: probe.usageComplete }];
  return legs.map((leg) => ({
    model: leg.model,
    ...leg.usage,
    usageComplete: leg.usageComplete,
  }));
}

export function trialHitOutputCeiling(trial: DirectorEvalTrial): boolean {
  return trial.modelUsage.some((usage) =>
    usage.finishReason === 'length' ||
    (usage.usageComplete && usage.outputTokens >= usage.maxCompletionTokens));
}

export function cacheEvidenceSufficient(trials: DirectorEvalTrial[]): boolean {
  if (trials.some((trial) => trial.cacheState === 'cold' && !trial.cacheExpectationMet)) return false;
  return DIRECTOR_EVAL_CONDITIONS.every((condition) => {
    const warm = trials.filter((trial) =>
      trial.conditionId === condition.id && trial.cacheState === 'warm');
    return warm.length > 0 && ratio(
      warm.filter((trial) => trial.cacheExpectationMet).length,
      warm.length,
    ) >= 0.8;
  });
}

export function summarizeConditions(trials: DirectorEvalTrial[], expected: number): ConditionSummary[] {
  return DIRECTOR_EVAL_CONDITIONS.flatMap((condition): ConditionSummary[] => {
    const rows = trials.filter((trial) => trial.conditionId === condition.id);
    if (rows.length !== expected) return [];
    const valid = rows.filter((row) => row.firstStepStatus === 'valid' && row.strictSchemaValid && row.validatorPassed && row.storyboardCoverage);
    const graded = valid.flatMap((row) => row.qualitySampled && row.qualityEvidenceComplete && row.qualityGrade !== null
      ? [row.qualityGrade]
      : []);
    return [{
      conditionId: condition.id,
      firstPassValidity: ratio(valid.length, rows.length),
      qualityGrade: round(mean(graded), 2),
      p50FirstValidOpMs: percentile(valid.flatMap((row) => row.firstValidOpMs === null ? [] : [row.firstValidOpMs]), 0.5),
      meanCostUsd: round(mean(rows.map((row) => row.costUpperBoundUsd)), 8),
      p50TtftMs: percentile(valid.map((row) => row.ttftMs), 0.5),
      p50CompleteSceneMs: percentile(valid.map((row) => row.completeSceneMs), 0.5),
      strictSchemaValidity: ratio(rows.filter((row) => row.strictSchemaValid).length, rows.length),
      validatorPassRate: ratio(rows.filter((row) => row.validatorPassed).length, rows.length),
      storyboardCoverageRate: ratio(rows.filter((row) => row.storyboardCoverage).length, rows.length),
      meanCostUpperBoundUsd: round(mean(rows.map((row) => row.costUpperBoundUsd)), 8),
    }];
  });
}

export function conditionDominatingByMoreThan2x(summaries: ConditionSummary[]): string | null {
  if (summaries.length < 2) return null;
  return summaries.find((candidate) => summaries.every((other) => candidate === other || (
    (candidate.p50TtftMs ?? Infinity) * 2 < (other.p50TtftMs ?? 0) &&
    candidate.p50FirstValidOpMs * 2 < other.p50FirstValidOpMs &&
    (candidate.p50CompleteSceneMs ?? Infinity) * 2 < (other.p50CompleteSceneMs ?? 0) &&
    (candidate.meanCostUpperBoundUsd ?? candidate.meanCostUsd) * 2 < (other.meanCostUpperBoundUsd ?? other.meanCostUsd) &&
    candidate.firstPassValidity > other.firstPassValidity * 2 &&
    (candidate.strictSchemaValidity ?? 0) > (other.strictSchemaValidity ?? 0) * 2 &&
    (candidate.validatorPassRate ?? 0) > (other.validatorPassRate ?? 0) * 2 &&
    (candidate.storyboardCoverageRate ?? 0) > (other.storyboardCoverageRate ?? 0) * 2 &&
    candidate.qualityGrade > other.qualityGrade * 2
  )))?.conditionId ?? null;
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] ?? 0;
}
function mean(values: number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function ratio(numerator: number, denominator: number): number { return denominator === 0 ? 0 : round(numerator / denominator, 4); }
function round(value: number, digits: number): number { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
