import { describe, expect, it } from 'vitest';
import { LiveSpendLedger } from './spendLedger.js';

describe('live evaluation spend ledger', () => {
  it('records reserved, completed, and failed calls with recomputable cumulative bounds', () => {
    const emitted: unknown[] = [];
    const ledger = new LiveSpendLedger(30, (entry) => emitted.push(entry));
    const warmup = ledger.begin({ phase: 'warmup', models: ['gpt-5.6-terra'], reserveUsd: 0.023 });
    ledger.noteProviderCalls(warmup, 1);
    ledger.complete(warmup, {
      status: 'completed', observedCostUsd: 0.01, upperBoundUsd: 0.01,
      usage: [{ model: 'gpt-5.6-terra', inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 100, outputTokens: 20, usageComplete: true }],
    });
    const judge = ledger.begin({ phase: 'judge', models: ['gpt-5.6-luna'], reserveUsd: 0.0032 });
    ledger.noteProviderCalls(judge, 1);
    ledger.complete(judge, { status: 'failed', observedCostUsd: 0, upperBoundUsd: 0.0032, usage: [] });

    expect(ledger.providerCalls).toBe(2);
    expect(ledger.observedCostUsd).toBe(0.01);
    expect(ledger.accountedCostUsd).toBe(0.0132);
    expect(ledger.entries).toHaveLength(6);
    expect(emitted).toEqual(ledger.entries);
    expect(ledger.entries.at(-1)).toMatchObject({
      phase: 'judge', status: 'failed', cumulativeAccountedCostUsd: 0.0132,
    });
  });

  it('refuses a reservation that could cross the hard cap', () => {
    const ledger = new LiveSpendLedger(1);
    const first = ledger.begin({ phase: 'composition', models: ['gpt-5.6-terra'], reserveUsd: 0.8 });
    ledger.noteProviderCalls(first, 1);
    ledger.complete(first, { status: 'completed', observedCostUsd: 0.7, upperBoundUsd: 0.7, usage: [] });
    expect(() => ledger.begin({ phase: 'judge', models: ['gpt-5.6-luna'], reserveUsd: 0.31 })).toThrow(/spend cap/i);
  });

  it('fails closed on illegal transitions and incomplete usage accounting', () => {
    const ledger = new LiveSpendLedger(30, undefined, 'strict-ledger');
    const callId = ledger.begin({ phase: 'composition', models: ['gpt-5.6-terra'], reserveUsd: 0.03 });
    expect(() => ledger.complete(callId, {
      status: 'completed', observedCostUsd: 0, upperBoundUsd: 0, usage: [],
    })).toThrow(/before it starts/i);
    ledger.noteProviderCalls(callId, 1);
    expect(() => ledger.complete(callId, {
      status: 'completed', observedCostUsd: 0.01, upperBoundUsd: 0.01,
      usage: [{
        model: 'gpt-5.6-terra', inputTokens: 100, cachedInputTokens: 80,
        cacheWriteTokens: 30, outputTokens: 10, usageComplete: true,
      }],
    })).toThrow(/cannot exceed total input/i);
    ledger.complete(callId, {
      status: 'failed', observedCostUsd: 0, upperBoundUsd: 0, usage: [],
    });
    expect(ledger.accountedCostUsd).toBe(0.03);
    expect(ledger.snapshot()).toMatchObject({
      runId: 'strict-ledger', openReservationUsd: 0, accountedCostUsd: 0.03,
    });
  });
});
