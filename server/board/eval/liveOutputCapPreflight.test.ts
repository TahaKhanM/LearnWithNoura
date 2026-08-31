import { describe, expect, it, vi } from 'vitest';
import {
  outputCapPreflightBudgetUsd,
  runLiveOutputCapPreflight,
} from './liveOutputCapPreflight.js';

describe('Director output-cap live preflight', () => {
  it('uses representative-only synthetic rows and balances every provider leg', async () => {
    const proposal = strictProposal();
    const create = vi.fn(async () => stream(proposal, 180, 'stop'));
    const report = await runLiveOutputCapPreflight({
      client: { chat: { completions: { create } } } as never,
      harnessUrl: 'injected://board',
      maxSpendUsd: outputCapPreflightBudgetUsd(),
      priorReservedUsd: 0.5349221,
      runId: 'scripted-cap-preflight',
      harness: {
        validate: async () => ({ ok: true }),
        render: async () => null,
        close: async () => undefined,
      },
    });

    expect(report.pass).toBe(true);
    expect(report.trials).toHaveLength(10);
    expect(report.trials.every((trial) => trial.split === 'representative')).toBe(true);
    expect(report.providerCalls).toBe(12);
    expect(report.spendLedger.openReservationUsd).toBe(0);
    expect(report.outputControl).toMatchObject({
      defaultMaxCompletionTokensByModelAndReasoningEffort: {
        'gpt-5.6-terra': { low: 4_000, medium: 4_000 },
        'gpt-5.6-luna': { low: 5_000, medium: 5_000 },
      },
      verbosity: 'low',
    });
    expect(create).toHaveBeenCalledTimes(12);
  });

  it('fails on the first length-censored row and makes no later calls', async () => {
    const create = vi.fn(async () => stream('{"template":null', 900, 'length'));
    await expect(runLiveOutputCapPreflight({
      client: { chat: { completions: { create } } } as never,
      harnessUrl: 'injected://board',
      maxSpendUsd: outputCapPreflightBudgetUsd(),
      priorReservedUsd: 0.5349221,
      runId: 'scripted-cap-failure',
      harness: {
        validate: async () => ({ ok: true }),
        render: async () => null,
        close: async () => undefined,
      },
    })).rejects.toThrow(/full bake-off remains blocked/i);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('preflights its complete bound before making a provider call', async () => {
    const create = vi.fn();
    await expect(runLiveOutputCapPreflight({
      client: { chat: { completions: { create } } } as never,
      harnessUrl: 'injected://board',
      maxSpendUsd: outputCapPreflightBudgetUsd() - 0.0001,
      priorReservedUsd: 0,
      harness: {
        validate: async () => ({ ok: true }),
        render: async () => null,
        close: async () => undefined,
      },
    })).rejects.toThrow(/No provider call was made/i);
    expect(create).not.toHaveBeenCalled();
  });
});

function strictProposal(): string {
  return JSON.stringify({
    template: null,
    groupLabel: 'Compact exact scene',
    representation: 'diagram',
    illustration: null,
    steps: [{
      id: 's1',
      reveal: 'outline',
      narration: 'Here is the exact relationship.',
      ops: [{
        op: 'add', id: 'b1', color: 'blue',
        spec: { kind: 'box', at: [500, 300], w: 300, h: 120, text: 'synthetic' },
      }],
    }],
  });
}

async function* stream(text: string, outputTokens: number, finishReason: 'stop' | 'length') {
  yield { choices: [{ delta: { content: text }, finish_reason: finishReason }], usage: null };
  yield {
    choices: [],
    usage: {
      prompt_tokens: 1_000,
      completion_tokens: outputTokens,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 900 },
    },
  };
}
