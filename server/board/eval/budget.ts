import type { DirectorEvalCondition } from './types.js';

export type EvalTextModel = 'gpt-5.6-terra' | 'gpt-5.6-luna';

export const DIRECTOR_PROPOSAL_MAX_COMPLETION_TOKENS = {
  'gpt-5.6-terra': { low: 4_000, medium: 4_000 },
  'gpt-5.6-luna': { low: 5_000, medium: 5_000 },
} as const;
/** Provider reporting for these models is rounded down to 128-token cache
 * boundaries. The raster-bearing production-shaped prefix reports 1,792. */
export const DIRECTOR_MIN_WARM_CACHED_INPUT_TOKENS = 1_792;

const TOKEN_RATES_PER_MILLION = {
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
} as const;
/** The static schema/prompt plus bounded fixture suffix is below 3k input
 * tokens in live usage. A high-detail 960x576 board raster raises the bound
 * to 5k. Cold calls conservatively charge every input token as a 1.25x cache
 * write; warm calls receive discounted pricing only for the enforced 2k hit. */
const COMPOSITION_INPUT_TOKEN_BOUND = {
  withoutRaster: 3_000,
  withRaster: 5_000,
} as const;
/** Luna judge: up to eight high-detail 960×576 cumulative rasters plus a
 * 1,000-token reasoning-and-verdict ceiling. */
const JUDGE_RESERVE_USD = 0.0041;
const VISION_RESERVE_USD: Record<EvalTextModel, number> = {
  'gpt-5.6-terra': 0.01,
  'gpt-5.6-luna': 0.001,
};
const SKETCH_RESERVE_USD: Record<EvalTextModel, number> = {
  'gpt-5.6-terra': 0.0068,
  'gpt-5.6-luna': 0.00068,
};
/** The runner stops on the first selected warm-leg cache miss. The largest
 * cold-vs-warm reservation delta is below two cents, including a raster. */
const CACHE_MISS_CONTINGENCY_USD = 0.02;

export interface EvalUsageCostInput {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export function estimateUsageCostUsd(model: EvalTextModel, usage: EvalUsageCostInput): number {
  const rate = TOKEN_RATES_PER_MILLION[model];
  const cacheWrites = Math.min(usage.inputTokens, Math.max(0, usage.cacheWriteTokens));
  const cachedReads = Math.min(
    Math.max(0, usage.inputTokens - cacheWrites),
    Math.max(0, usage.cachedInputTokens),
  );
  const ordinaryInput = Math.max(0, usage.inputTokens - cacheWrites - cachedReads);
  return round((
    ordinaryInput * rate.input +
    cacheWrites * rate.input * 1.25 +
    cachedReads * rate.cachedInput +
    Math.max(0, usage.outputTokens) * rate.output
  ) / 1_000_000, 10);
}

export function compositionCallReserveUsd(
  model: EvalTextModel,
  cacheState: 'cold' | 'warm' = 'cold',
  hasBoardRaster = false,
  reasoningEffort: 'low' | 'medium' = 'low',
  maxCompletionTokens: number = DIRECTOR_PROPOSAL_MAX_COMPLETION_TOKENS[model][reasoningEffort],
): number {
  const inputTokens = COMPOSITION_INPUT_TOKEN_BOUND[hasBoardRaster ? 'withRaster' : 'withoutRaster'];
  const estimated = estimateUsageCostUsd(model, {
    inputTokens,
    cachedInputTokens: cacheState === 'warm' ? DIRECTOR_MIN_WARM_CACHED_INPUT_TOKENS : 0,
    cacheWriteTokens: cacheState === 'cold' ? inputTokens : 0,
    outputTokens: maxCompletionTokens,
  });
  return Math.ceil((estimated - 1e-12) * 10_000) / 10_000;
}

export function plannedLiveBudget(input: {
  intentCount: number;
  judgedIntentCount: number;
  trialsPerCacheState: number;
  judgedTrialsPerCacheState: number;
  judgedCacheStateCount: 1 | 2;
  conditions: DirectorEvalCondition[];
  defectCount: number;
  sketchCount: number;
  contextRasterIntentCount?: number;
}) {
  if (!Number.isInteger(input.judgedTrialsPerCacheState) ||
      input.judgedTrialsPerCacheState < 0 ||
      input.judgedTrialsPerCacheState > input.trialsPerCacheState) {
    throw new Error('Judged trials per cache state must be an integer within the planned trial count.');
  }
  if (!Number.isInteger(input.judgedIntentCount) || input.judgedIntentCount < 0 ||
      input.judgedIntentCount > input.intentCount) {
    throw new Error('Judged intent count must be an integer within the corpus size.');
  }
  const contextRasterIntentCount = Math.max(0, input.contextRasterIntentCount ?? 0);
  const compositionLegCounts: Record<EvalTextModel, { cold: number; warm: number }> = {
    'gpt-5.6-terra': { cold: 0, warm: 0 },
    'gpt-5.6-luna': { cold: 0, warm: 0 },
  };
  for (const condition of input.conditions) {
    for (const leg of condition.legs) {
      compositionLegCounts[leg.model].cold += input.intentCount * input.trialsPerCacheState;
      compositionLegCounts[leg.model].warm += input.intentCount * input.trialsPerCacheState;
    }
  }
  const compositionCalls = Object.values(compositionLegCounts)
    .reduce((sum, value) => sum + value.cold + value.warm, 0);
  const judgeCalls = input.judgedIntentCount * input.judgedCacheStateCount *
    input.judgedTrialsPerCacheState * input.conditions.length;
  const visionAuditCalls = input.defectCount * 2 * 2;
  const sketchCalls = input.sketchCount * 2;
  const warmupKeys = new Set(input.conditions.flatMap((condition) =>
    condition.legs.map((leg) => `${leg.model}:${leg.reasoningEffort}`)));
  const warmupUsd = [...warmupKeys].reduce((total, key) => {
    const model = key.split(':', 1)[0] as EvalTextModel;
    const reasoningEffort = key.split(':')[1] as 'low' | 'medium';
    const maxCompletionTokens = Math.max(...input.conditions.flatMap((condition) =>
      condition.legs.filter((leg) => `${leg.model}:${leg.reasoningEffort}` === key)
        .map((leg) => leg.maxCompletionTokens)));
    return total + compositionCallReserveUsd(
      model, 'cold', false, reasoningEffort, maxCompletionTokens,
    );
  }, 0);
  const compositionUsd = input.conditions.reduce((conditionTotal, condition) =>
    conditionTotal + condition.legs.reduce((total, leg) => {
      const plainPerCache = (input.intentCount - contextRasterIntentCount) * input.trialsPerCacheState;
      const rasterPerCache = contextRasterIntentCount * input.trialsPerCacheState;
      return total +
        plainPerCache * compositionCallReserveUsd(
          leg.model, 'cold', false, leg.reasoningEffort, leg.maxCompletionTokens,
        ) +
        rasterPerCache * compositionCallReserveUsd(
          leg.model, 'cold', true, leg.reasoningEffort, leg.maxCompletionTokens,
        ) +
        plainPerCache * compositionCallReserveUsd(
          leg.model, 'warm', false, leg.reasoningEffort, leg.maxCompletionTokens,
        ) +
        rasterPerCache * compositionCallReserveUsd(
          leg.model, 'warm', true, leg.reasoningEffort, leg.maxCompletionTokens,
        );
    }, 0), 0);
  const judgeUsd = judgeCalls * JUDGE_RESERVE_USD;
  const visionAuditUsd = input.defectCount * 2 *
    (VISION_RESERVE_USD['gpt-5.6-terra'] + VISION_RESERVE_USD['gpt-5.6-luna']);
  const sketchUsd = input.sketchCount *
    (SKETCH_RESERVE_USD['gpt-5.6-terra'] + SKETCH_RESERVE_USD['gpt-5.6-luna']);
  const hedge = input.conditions.find((condition) => condition.legs.length > 1);
  const hedgeWarmAbortUsd = hedge
    ? hedgeWarmAbortReservation(input, hedge, contextRasterIntentCount)
    : 0;
  return {
    compositionCalls,
    judgeCalls,
    visionAuditCalls,
    sketchCalls,
    compositionLegCounts,
    componentsUsd: {
      warmup: round(warmupUsd, 4),
      composition: round(compositionUsd, 4),
      judging: round(judgeUsd, 4),
      visionAudit: round(visionAuditUsd, 4),
      sketch: round(sketchUsd, 4),
      hedgeWarmAbort: round(hedgeWarmAbortUsd, 4),
      cacheMissContingency: CACHE_MISS_CONTINGENCY_USD,
    },
    conservativeTotalUsd: round(
      warmupUsd + compositionUsd + judgeUsd + visionAuditUsd + sketchUsd +
      hedgeWarmAbortUsd + CACHE_MISS_CONTINGENCY_USD,
      4,
    ),
  };
}

function hedgeWarmAbortReservation(
  input: { intentCount: number; trialsPerCacheState: number },
  hedge: DirectorEvalCondition,
  contextRasterIntentCount: number,
): number {
  const worstLeg = hedge.legs.find((leg) => leg.model === 'gpt-5.6-terra') ?? hedge.legs[0];
  if (!worstLeg) return 0;
  const plainTrials = (input.intentCount - contextRasterIntentCount) * input.trialsPerCacheState;
  const rasterTrials = contextRasterIntentCount * input.trialsPerCacheState;
  return plainTrials * (
    compositionCallReserveUsd(
      worstLeg.model, 'cold', false, worstLeg.reasoningEffort, worstLeg.maxCompletionTokens,
    ) -
    compositionCallReserveUsd(
      worstLeg.model, 'warm', false, worstLeg.reasoningEffort, worstLeg.maxCompletionTokens,
    )
  ) + rasterTrials * (
    compositionCallReserveUsd(
      worstLeg.model, 'cold', true, worstLeg.reasoningEffort, worstLeg.maxCompletionTokens,
    ) -
    compositionCallReserveUsd(
      worstLeg.model, 'warm', true, worstLeg.reasoningEffort, worstLeg.maxCompletionTokens,
    )
  );
}

export function judgeCallReserveUsd(): number { return JUDGE_RESERVE_USD; }
export function visionCallReserveUsd(model: EvalTextModel): number { return VISION_RESERVE_USD[model]; }
export function sketchCallReserveUsd(model: EvalTextModel): number { return SKETCH_RESERVE_USD[model]; }

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
