import { describe, expect, it } from 'vitest';
import { M2SmokeBudget } from './m2SmokeBudget.js';

describe('authorized M2 smoke provider budget', () => {
  it('fits the itemized maximum below the authorized $1.25 ceiling', () => {
    const budget = new M2SmokeBudget(1.25);
    expect(budget.maximumPlannedReserveUsd()).toBe(1.1);
    budget.begin('realtime', 'gpt-realtime-2.1', 'low');
    budget.begin('composition', 'gpt-5.6-terra', 'low');
    budget.begin('composition', 'gpt-5.6-terra', 'low');
    budget.begin('vision_audit', 'gpt-5.6-luna', 'low');
    budget.begin('vision_audit', 'gpt-5.6-luna', 'low');
    budget.begin('recovery', 'gpt-5.6-terra', 'medium');
    budget.begin('recovery', 'gpt-5.6-terra', 'medium');
    expect(budget.snapshot()).toMatchObject({
      hardCapUsd: 1.25,
      providerCalls: 7,
      accountedUpperBoundUsd: 1.1,
      counts: { realtime: 1, composition: 2, vision_audit: 2, recovery: 2 },
    });
  });

  it('fits a corrected rerun to one call per adopted role under $0.85', () => {
    const budget = new M2SmokeBudget(0.85, 'corrected_rerun');
    expect(budget.maximumPlannedReserveUsd()).toBe(0.8);
    budget.begin('realtime', 'gpt-realtime-2.1', 'low');
    budget.begin('composition', 'gpt-5.6-terra', 'low');
    budget.begin('vision_audit', 'gpt-5.6-luna', 'low');
    budget.begin('recovery', 'gpt-5.6-terra', 'medium');
    expect(() => budget.begin('composition', 'gpt-5.6-terra', 'low')).toThrow(/call limit/i);
    expect(budget.snapshot()).toMatchObject({
      mode: 'corrected_rerun',
      hardCapUsd: 0.85,
      providerCalls: 4,
      accountedUpperBoundUsd: 0.8,
    });
  });

  it('rejects any extra role call before the provider boundary', () => {
    const budget = new M2SmokeBudget(1.25);
    budget.begin('composition', 'gpt-5.6-terra', 'low');
    budget.begin('composition', 'gpt-5.6-terra', 'low');
    expect(() => budget.begin('composition', 'gpt-5.6-terra', 'low')).toThrow(/call limit/i);
    expect(() => budget.begin('layout_correction', 'gpt-5.6-terra', 'low')).toThrow(/call limit/i);
  });

  it('records provider usage without treating the Realtime reservation as observed token cost', () => {
    const budget = new M2SmokeBudget(1.25);
    const callId = budget.begin('vision_audit', 'gpt-5.6-luna', 'low');
    budget.recordUsage(callId, {
      inputTokens: 1_000,
      cachedInputTokens: 200,
      cacheWriteTokens: 0,
      outputTokens: 100,
    });
    const snapshot = budget.snapshot();
    expect(snapshot.entries[0]?.usage).toMatchObject({ inputTokens: 1_000, outputTokens: 100 });
    expect(snapshot.observedTextCostUsd).toBeGreaterThan(0);
    expect(snapshot.observedTextCostUsd).toBeLessThanOrEqual(snapshot.accountedUpperBoundUsd);
  });
});
