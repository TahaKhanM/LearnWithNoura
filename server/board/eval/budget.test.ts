import { describe, expect, it } from 'vitest';
import { DIRECTOR_EVAL_CONDITIONS } from './corpus.js';
import {
  compositionCallReserveUsd,
  DIRECTOR_MIN_WARM_CACHED_INPUT_TOKENS,
  DIRECTOR_PROPOSAL_MAX_COMPLETION_TOKENS,
  estimateUsageCostUsd,
  plannedLiveBudget,
} from './budget.js';

describe('Director live-evaluation budget', () => {
  it('prices cache writes at 1.25x without double-counting cached reads', () => {
    expect(estimateUsageCostUsd('gpt-5.6-terra', {
      inputTokens: 1_000,
      cachedInputTokens: 400,
      cacheWriteTokens: 200,
      outputTokens: 100,
    })).toBeCloseTo(
      (400 * 2 + 200 * 2 * 1.25 + 400 * 0.2 + 100 * 12) / 1_000_000,
      10,
    );
  });

  it('records the all-calls-at-reservation bound separately from the per-call hard cap', () => {
    const budget = plannedLiveBudget({
      intentCount: 36,
      judgedIntentCount: 25,
      trialsPerCacheState: 5,
      judgedTrialsPerCacheState: 1,
      judgedCacheStateCount: 1,
      conditions: DIRECTOR_EVAL_CONDITIONS,
      defectCount: 12,
      sketchCount: 30,
      contextRasterIntentCount: 4,
    });
    expect(budget.compositionCalls).toBe(2_160);
    expect(budget.judgeCalls).toBe(125);
    expect(budget.visionAuditCalls).toBe(48);
    expect(budget.sketchCalls).toBe(60);
    expect(budget.conservativeTotalUsd).toBe(57.1455);
    expect(budget.conservativeTotalUsd).toBeGreaterThan(30);
  });

  it('uses the full reservation when an aborted hedge leg has no final usage', () => {
    expect(DIRECTOR_MIN_WARM_CACHED_INPUT_TOKENS).toBe(1_792);
    expect(compositionCallReserveUsd('gpt-5.6-terra', 'cold', true)).toBe(0.0605);
    expect(compositionCallReserveUsd('gpt-5.6-luna', 'warm', false)).toBe(0.0063);
  });

  it('reserves above each reasoning tier output ceiling for every cache and raster case', () => {
    expect(DIRECTOR_PROPOSAL_MAX_COMPLETION_TOKENS).toEqual({
      'gpt-5.6-terra': { low: 4_000, medium: 4_000 },
      'gpt-5.6-luna': { low: 5_000, medium: 5_000 },
    });
    for (const model of ['gpt-5.6-terra', 'gpt-5.6-luna'] as const) {
      for (const reasoningEffort of ['low', 'medium'] as const) {
        for (const cacheState of ['cold', 'warm'] as const) {
          for (const hasBoardRaster of [false, true]) {
            const inputTokens = hasBoardRaster ? 5_000 : 3_000;
            const estimated = estimateUsageCostUsd(model, {
              inputTokens,
              cachedInputTokens: cacheState === 'warm' ? 1_792 : 0,
              cacheWriteTokens: cacheState === 'cold' ? inputTokens : 0,
              outputTokens: DIRECTOR_PROPOSAL_MAX_COMPLETION_TOKENS[model][reasoningEffort],
            });
            expect(compositionCallReserveUsd(model, cacheState, hasBoardRaster, reasoningEffort))
              .toBeGreaterThanOrEqual(estimated);
          }
        }
      }
    }
  });

  it('rejects a judge sample larger than the preregistered trial matrix', () => {
    expect(() => plannedLiveBudget({
      intentCount: 36,
      judgedIntentCount: 25,
      trialsPerCacheState: 5,
      judgedTrialsPerCacheState: 6,
      judgedCacheStateCount: 1,
      conditions: DIRECTOR_EVAL_CONDITIONS,
      defectCount: 12,
      sketchCount: 30,
    })).toThrow(/within the planned trial count/i);
  });
});
