import { describe, expect, it } from 'vitest';
import { DIRECTOR_EVAL_CONDITIONS } from './corpus.js';
import {
  compositionCallReserveUsd,
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

  it('keeps the complete preregistered study inside the thirty-dollar ceiling', () => {
    const budget = plannedLiveBudget({
      intentCount: 36,
      trialsPerCacheState: 5,
      conditions: DIRECTOR_EVAL_CONDITIONS,
      defectCount: 12,
      sketchCount: 30,
      contextRasterIntentCount: 4,
    });
    expect(budget.compositionCalls).toBe(2_160);
    expect(budget.judgeCalls).toBe(1_800);
    expect(budget.visionAuditCalls).toBe(48);
    expect(budget.sketchCalls).toBe(60);
    expect(budget.conservativeTotalUsd).toBeLessThanOrEqual(30);
    expect(budget.conservativeTotalUsd).toBeGreaterThan(25);
  });

  it('uses the full reservation when an aborted hedge leg has no final usage', () => {
    expect(compositionCallReserveUsd('gpt-5.6-terra', 'cold', true)).toBe(0.027);
    expect(compositionCallReserveUsd('gpt-5.6-luna', 'warm', false)).toBe(0.0011);
  });
});
