import { randomUUID } from 'node:crypto';
import type OpenAI from 'openai';
import { createHeadlessSceneValidator, type HeadlessSceneValidatorHandle } from '../../lesson/headlessSceneValidator.js';
import { DIRECTOR_EVAL_CONDITIONS, loadDirectorEvalCorpus } from './corpus.js';
import { compositionCallReserveUsd, DIRECTOR_PROPOSAL_MAX_COMPLETION_TOKENS } from './budget.js';
import {
  SpendGuard,
  runCompositionTrial,
  trialHitOutputCeiling,
} from './liveDirectorEval.js';
import type { DirectorEvalCondition, DirectorEvalTrial } from './types.js';
import type { SpendLedgerEvent } from './spendLedger.js';

const PREFLIGHT_INTENT_IDS = ['math-angle-sum', 'math-unit-circle'] as const;
const PREFLIGHT_TRIALS = [2] as const;

export function outputCapPreflightBudgetUsd(input: {
  intentCount?: number;
  conditions?: DirectorEvalCondition[];
  trialCount?: number;
} = {}): number {
  const perMatrix = (input.conditions ?? DIRECTOR_EVAL_CONDITIONS).reduce((total, condition) =>
    total + condition.legs.reduce((legTotal, leg) =>
      legTotal + compositionCallReserveUsd(
        leg.model, 'cold', false, leg.reasoningEffort, leg.maxCompletionTokens,
      ), 0), 0);
  return money(perMatrix * (input.intentCount ?? PREFLIGHT_INTENT_IDS.length) *
    (input.trialCount ?? PREFLIGHT_TRIALS.length));
}

export async function runLiveOutputCapPreflight(input: {
  client: OpenAI;
  harnessUrl: string;
  maxSpendUsd: number;
  priorReservedUsd: number;
  runId?: string;
  intentIds?: string[];
  conditionIds?: string[];
  onProgress?: (message: string) => void;
  onCheckpoint?: (trial: DirectorEvalTrial) => void;
  onSpendEvent?: (event: SpendLedgerEvent) => void;
  harness?: HeadlessSceneValidatorHandle;
}) {
  const sessionHardCapUsd = 30;
  const combinedMaximumUsd = money(input.priorReservedUsd + input.maxSpendUsd);
  if (!Number.isFinite(input.priorReservedUsd) || input.priorReservedUsd < 0 ||
      combinedMaximumUsd > sessionHardCapUsd) {
    throw new Error('Output-cap preflight authorization exceeds the cumulative $30 session cap. No provider call was made.');
  }
  const corpus = loadDirectorEvalCorpus();
  const requestedIntentIds = input.intentIds ?? [...PREFLIGHT_INTENT_IDS];
  const intents = requestedIntentIds.map((id) => {
    const intent = corpus.find((candidate) => candidate.id === id);
    if (!intent || intent.split !== 'representative') {
      throw new Error(`Output-cap preflight intent ${id} must be in the representative split.`);
    }
    return intent;
  });
  const conditions = input.conditionIds === undefined
    ? DIRECTOR_EVAL_CONDITIONS
    : input.conditionIds.map((id) => {
        const condition = DIRECTOR_EVAL_CONDITIONS.find((candidate) => candidate.id === id);
        if (!condition) throw new Error(`Unknown output-cap preflight condition ${id}.`);
        return condition;
      });
  const plannedUpperBoundUsd = outputCapPreflightBudgetUsd({
    intentCount: intents.length,
    conditions,
    trialCount: PREFLIGHT_TRIALS.length,
  });
  if (plannedUpperBoundUsd > input.maxSpendUsd) {
    throw new Error(`Output-cap preflight requires a $${plannedUpperBoundUsd} conservative budget. No provider call was made.`);
  }
  const runId = input.runId ?? `director-cap-preflight-${randomUUID()}`;
  const spend = new SpendGuard(input.maxSpendUsd, input.onSpendEvent, runId);
  const harness = input.harness ?? createHeadlessSceneValidator({ harnessUrl: input.harnessUrl });
  const ownsHarness = !input.harness;
  const trials: DirectorEvalTrial[] = [];
  try {
    for (const trial of PREFLIGHT_TRIALS) {
      for (const intent of intents) {
        for (const condition of conditions) {
          input.onProgress?.(`[director-cap-preflight] ${condition.id} ${intent.id} cold ${trial}`);
          const row = await runCompositionTrial({
            client: input.client,
            harness,
            spend,
            condition,
            intent,
            cacheState: 'cold',
            trial,
            runId,
          });
          trials.push(row);
          input.onCheckpoint?.(row);
          if (trialHitOutputCeiling(row)) {
            const ceiling = row.modelUsage.find((usage) =>
              usage.finishReason === 'length' || usage.outputTokens >= usage.maxCompletionTokens)
              ?.maxCompletionTokens;
            throw new Error(
              `${condition.id}/${intent.id} hit the ${ceiling ?? 'configured'}-token output ceiling; the full bake-off remains blocked.`,
            );
          }
        }
      }
    }
    const invalid = trials.filter((trial) =>
      !trial.strictSchemaValid || !trial.validatorPassed || !trial.storyboardCoverage);
    if (invalid.length > 0) {
      throw new Error(
        `${invalid.length}/${trials.length} representative preflight rows failed the production scene contract; the full bake-off remains blocked.`,
      );
    }
  } finally {
    if (ownsHarness) await harness.close();
  }
  return {
    schemaVersion: '1.0.0' as const,
    pass: true as const,
    evidenceMode: 'authorized_live_synthetic_output_cap_preflight' as const,
    evidenceBoundary: 'Two checked-in representative synthetic intents only; no holdout prompt tuning and no child data.',
    realChildData: false as const,
    outputControl: {
      defaultMaxCompletionTokensByModelAndReasoningEffort: DIRECTOR_PROPOSAL_MAX_COMPLETION_TOKENS,
      conditionCeilings: DIRECTOR_EVAL_CONDITIONS.map((condition) => ({
        conditionId: condition.id,
        legs: condition.legs.map((leg) => ({
          model: leg.model,
          reasoningEffort: leg.reasoningEffort,
          maxCompletionTokens: leg.maxCompletionTokens,
        })),
      })),
      verbosity: 'low' as const,
      representativeIntentIds: requestedIntentIds,
      conditionIds: conditions.map((condition) => condition.id),
      trials: [...PREFLIGHT_TRIALS],
    },
    authorizationLedger: {
      sessionHardCapUsd,
      priorReservedUsd: input.priorReservedUsd,
      runMaxSpendUsd: input.maxSpendUsd,
      combinedMaximumUsd,
    },
    plannedUpperBoundUsd,
    providerCalls: spend.providerCalls,
    estimatedCostUsd: spend.estimatedCostUsd,
    accountedCostUsd: spend.accountedCostUsd,
    spendLedger: spend.snapshot(),
    trials,
  };
}

function money(value: number): number {
  return Math.round(value * 1e10) / 1e10;
}
