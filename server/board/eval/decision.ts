import type { ConditionSummary } from './types.js';

export const COMPOSITION_MIN_FIRST_PASS_VALIDITY = 0.95;
export const COMPOSITION_MAX_QUALITY_GRADE_GAP = 1;
export const HEDGE_MIN_P50_IMPROVEMENT = 0.15;
export const HEDGE_MAX_MEAN_COST_USD = 0.1;

export interface CompositionDecision {
  winnerConditionId: string | null;
  hedgeAdopted: boolean;
  eligibleConditionIds: string[];
  reasons: string[];
}

/** The pre-registered M0 rule. The hedge competes only with the best eligible
 * single condition and only after clearing the explicit 15% latency bar. */
export function chooseCompositionWinner(summaries: ConditionSummary[]): CompositionDecision {
  const reference = summaries.find((entry) => entry.conditionId === 'terra-med');
  if (!reference) return { winnerConditionId: null, hedgeAdopted: false, eligibleConditionIds: [], reasons: ['terra-med reference is missing'] };
  const eligible = summaries.filter((entry) =>
    entry.firstPassValidity >= COMPOSITION_MIN_FIRST_PASS_VALIDITY &&
    Math.abs(entry.qualityGrade - reference.qualityGrade) <= COMPOSITION_MAX_QUALITY_GRADE_GAP);
  const singles = eligible.filter((entry) => !entry.conditionId.includes('+'))
    .sort(byLatencyThenCost);
  const bestSingle = singles[0];
  if (!bestSingle) return { winnerConditionId: null, hedgeAdopted: false, eligibleConditionIds: eligible.map((entry) => entry.conditionId), reasons: ['no single condition cleared the validity and quality bars'] };
  const hedge = eligible.find((entry) => entry.conditionId === 'terra-low+luna-low');
  const improvement = hedge
    ? (bestSingle.p50FirstValidOpMs - hedge.p50FirstValidOpMs) / bestSingle.p50FirstValidOpMs
    : 0;
  const hedgeAdopted = Boolean(hedge && improvement >= HEDGE_MIN_P50_IMPROVEMENT && hedge.meanCostUsd <= HEDGE_MAX_MEAN_COST_USD);
  return {
    winnerConditionId: hedgeAdopted && hedge ? hedge.conditionId : bestSingle.conditionId,
    hedgeAdopted,
    eligibleConditionIds: eligible.map((entry) => entry.conditionId),
    reasons: hedgeAdopted
      ? [`hedge improved p50 by ${Math.round(improvement * 1_000) / 10}% within the cost ceiling`]
      : [`best eligible single condition was ${bestSingle.conditionId}`, hedge ? `hedge improvement was ${Math.round(improvement * 1_000) / 10}%` : 'hedge was ineligible'],
  };
}

function byLatencyThenCost(left: ConditionSummary, right: ConditionSummary): number {
  return left.p50FirstValidOpMs - right.p50FirstValidOpMs || left.meanCostUsd - right.meanCostUsd;
}
