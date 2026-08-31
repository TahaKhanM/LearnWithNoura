import type { DirectorEvalCondition } from './types.js';

export type EvalTextModel = 'gpt-5.6-terra' | 'gpt-5.6-luna';

const TOKEN_RATES_PER_MILLION = {
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
} as const;

/** Derived from a 6k-token cold prefix/dynamic bound, 5k-token warm cache
 * hit, 1.6k-token high-detail board raster bound, and the probe's 600 output
 * token cap. Values round upward and include GPT-5.6's 1.25x cache write. */
const COMPOSITION_RESERVE_USD = {
  cold: {
    withoutRaster: { 'gpt-5.6-terra': 0.023, 'gpt-5.6-luna': 0.0023 },
    withRaster: { 'gpt-5.6-terra': 0.027, 'gpt-5.6-luna': 0.0027 },
  },
  warm: {
    withoutRaster: { 'gpt-5.6-terra': 0.011, 'gpt-5.6-luna': 0.0011 },
    withRaster: { 'gpt-5.6-terra': 0.015, 'gpt-5.6-luna': 0.0015 },
  },
} as const;
/** Luna judge: up to eight high-detail 960×576 cumulative rasters plus the
 * 300-token strict verdict. Rounded above the image-token calculator bound. */
const JUDGE_RESERVE_USD = 0.0032;
const VISION_RESERVE_USD: Record<EvalTextModel, number> = {
  'gpt-5.6-terra': 0.01,
  'gpt-5.6-luna': 0.001,
};
const SKETCH_RESERVE_USD: Record<EvalTextModel, number> = {
  'gpt-5.6-terra': 0.0068,
  'gpt-5.6-luna': 0.00068,
};
const CACHE_MISS_CONTINGENCY_USD = 0.25;

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
): number {
  return COMPOSITION_RESERVE_USD[cacheState][hasBoardRaster ? 'withRaster' : 'withoutRaster'][model];
}

export function plannedLiveBudget(input: {
  intentCount: number;
  trialsPerCacheState: number;
  conditions: DirectorEvalCondition[];
  defectCount: number;
  sketchCount: number;
  contextRasterIntentCount?: number;
}) {
  const trialsPerCondition = input.intentCount * 2 * input.trialsPerCacheState;
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
  const judgeCalls = trialsPerCondition * input.conditions.length;
  const visionAuditCalls = input.defectCount * 2 * 2;
  const sketchCalls = input.sketchCount * 2;
  const warmupKeys = new Set(input.conditions.flatMap((condition) =>
    condition.legs.map((leg) => `${leg.model}:${leg.reasoningEffort}`)));
  const warmupUsd = [...warmupKeys].reduce((total, key) => {
    const model = key.split(':', 1)[0] as EvalTextModel;
    return total + compositionCallReserveUsd(model, 'cold', false);
  }, 0);
  const conditionLegCounts = (Object.keys(compositionLegCounts) as EvalTextModel[]).map((model) => ({
    model,
    legMultiplicity: input.conditions.reduce((count, condition) =>
      count + condition.legs.filter((leg) => leg.model === model).length, 0),
  }));
  const compositionUsd = conditionLegCounts.reduce((total, { model, legMultiplicity }) => {
    const plainPerCache = (input.intentCount - contextRasterIntentCount) * input.trialsPerCacheState * legMultiplicity;
    const rasterPerCache = contextRasterIntentCount * input.trialsPerCacheState * legMultiplicity;
    return total +
      plainPerCache * compositionCallReserveUsd(model, 'cold', false) +
      rasterPerCache * compositionCallReserveUsd(model, 'cold', true) +
      plainPerCache * compositionCallReserveUsd(model, 'warm', false) +
      rasterPerCache * compositionCallReserveUsd(model, 'warm', true);
  }, 0);
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
  const worstModel = hedge.legs.some((leg) => leg.model === 'gpt-5.6-terra')
    ? 'gpt-5.6-terra'
    : 'gpt-5.6-luna';
  const plainTrials = (input.intentCount - contextRasterIntentCount) * input.trialsPerCacheState;
  const rasterTrials = contextRasterIntentCount * input.trialsPerCacheState;
  return plainTrials * (
    compositionCallReserveUsd(worstModel, 'cold', false) - compositionCallReserveUsd(worstModel, 'warm', false)
  ) + rasterTrials * (
    compositionCallReserveUsd(worstModel, 'cold', true) - compositionCallReserveUsd(worstModel, 'warm', true)
  );
}

export function judgeCallReserveUsd(): number { return JUDGE_RESERVE_USD; }
export function visionCallReserveUsd(model: EvalTextModel): number { return VISION_RESERVE_USD[model]; }
export function sketchCallReserveUsd(model: EvalTextModel): number { return SKETCH_RESERVE_USD[model]; }

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
