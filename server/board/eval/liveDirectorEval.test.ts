import { describe, expect, it, vi } from 'vitest';
import {
  DIRECTOR_EVAL_CONDITIONS,
  loadDirectorEvalCorpus,
  loadDirectorQualitySampleIntentIds,
} from './corpus.js';
import {
  SpendGuard,
  conditionDominatingByMoreThan2x,
  runCompositionTrial,
  runConditionProbe,
  runLiveDirectorEval,
} from './liveDirectorEval.js';
import { compositionCallReserveUsd } from './budget.js';
import { materializeSketchCorpus } from './corpus.js';

describe('authorized Director evaluation orchestration', () => {
  it('validates revision proposals in board context and retains auditable raw evidence', async () => {
    const intent = loadDirectorEvalCorpus().find((entry) => entry.id === 'revision-alternative-scale');
    expect(intent).toBeDefined();
    const proposal = strictProposal('new-scale');
    const create = vi.fn(async (request: { stream?: boolean }) => request.stream
      ? streamResponse(proposal, { cached: 0, cacheWrite: 900 })
      : judgeResponse());
    const validatedCounts: number[] = [];
    const validate = vi.fn(async (ops: unknown[]) => {
      validatedCounts.push(ops.length);
      return { ok: true as const };
    });
    let renderIndex = 0;
    const render = vi.fn(async () => `data:image/jpeg;base64,${Buffer.from(`raster-${renderIndex++}`).toString('base64')}`);
    const trial = await runCompositionTrial({
      client: { chat: { completions: { create } } } as never,
      harness: { validate, render, close: async () => undefined },
      spend: new SpendGuard(30),
      condition: DIRECTOR_EVAL_CONDITIONS[0],
      intent: intent!,
      cacheState: 'cold',
      trial: 1,
    });

    expect(trial).toMatchObject({
      strictSchemaValid: true,
      validatorPassed: true,
      storyboardCoverage: true,
      qualitySampled: true,
      qualityGrade: 4,
      qualityEvidenceComplete: true,
      cacheExpectationMet: true,
      cacheWriteTokens: 900,
      usageComplete: true,
      judgeReasons: ['clear and coherent'],
    });
    expect(trial.proposalText).toContain('"steps"');
    expect(trial.rasterHashes).toHaveLength(1);
    const existingCount = intent!.existingBoardOps?.length ?? 0;
    expect(validatedCounts.some((count) => count > existingCount)).toBe(true);
    expect(render).toHaveBeenCalledWith(intent!.existingBoardOps, `existing-${intent!.id}`);
  });

  it('retains validity and latency evidence without grading rows outside trial one', async () => {
    const proposal = strictProposal('ungraded-box');
    const create = vi.fn(async (request: { stream?: boolean }) => {
      if (!request.stream) throw new Error('An unsampled row must not call the raster judge.');
      return streamResponse(proposal, { cached: 0, cacheWrite: 900 });
    });
    const render = vi.fn(async () => 'data:image/jpeg;base64,dW51c2Vk');
    const trial = await runCompositionTrial({
      client: { chat: { completions: { create } } } as never,
      harness: { validate: async () => ({ ok: true as const }), render, close: async () => undefined },
      spend: new SpendGuard(30),
      condition: DIRECTOR_EVAL_CONDITIONS[0],
      intent: loadDirectorEvalCorpus()[0],
      cacheState: 'cold',
      trial: 2,
    });

    expect(trial).toMatchObject({
      strictSchemaValid: true,
      validatorPassed: true,
      storyboardCoverage: true,
      qualitySampled: false,
      qualityGrade: null,
      qualityEvidenceComplete: false,
      judgeReasons: [],
      rasterHashes: [],
    });
    expect(trial.firstValidOpMs).not.toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
  });

  it('uses a fresh run nonce in every cold-cache request', async () => {
    const proposal = strictProposal('cold-nonce-box');
    const cacheKeys: string[] = [];
    const create = vi.fn(async (request: { prompt_cache_key?: string }) => {
      cacheKeys.push(request.prompt_cache_key ?? '');
      return streamResponse(proposal, { cached: 0, cacheWrite: 900 });
    });
    const base = {
      client: { chat: { completions: { create } } } as never,
      harness: { validate: async () => ({ ok: true as const }), render: async () => null, close: async () => undefined },
      condition: DIRECTOR_EVAL_CONDITIONS[0],
      intent: loadDirectorEvalCorpus()[0],
      cacheState: 'cold' as const,
      trial: 2,
    };
    await runCompositionTrial({ ...base, runId: 'attempt-a', spend: new SpendGuard(30) });
    await runCompositionTrial({ ...base, runId: 'attempt-b', spend: new SpendGuard(30) });
    expect(cacheKeys).toHaveLength(2);
    expect(cacheKeys[0]).toContain('attempt-a');
    expect(cacheKeys[1]).toContain('attempt-b');
    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
  });

  it('does not invoke the provider when durable reservation persistence fails', async () => {
    const create = vi.fn();
    const spend = new SpendGuard(30, () => { throw new Error('durable writer failed'); }, 'writer-failure');
    await expect(runConditionProbe({
      client: { chat: { completions: { create } } } as never,
      harness: { validate: async () => ({ ok: true as const }), render: async () => null, close: async () => undefined },
      spend,
      condition: DIRECTOR_EVAL_CONDITIONS[0],
      intent: loadDirectorEvalCorpus()[0],
      cacheState: 'cold',
      trial: 1,
    }, 'writer-failure:trial', { currentBoardRaster: null, existingOps: [], visibleObjectIds: [] }))
      .rejects.toThrow(/durable writer failed/);
    expect(create).not.toHaveBeenCalled();
  });

  it('retries one transient composition transport failure with a fresh cold nonce', async () => {
    const proposal = strictProposal('retry-box');
    const cacheKeys: string[] = [];
    const create = vi.fn(async (request: { prompt_cache_key?: string }) => {
      cacheKeys.push(request.prompt_cache_key ?? '');
      if (cacheKeys.length === 1) throw new Error('terminated');
      return streamResponse(proposal, { cached: 0, cacheWrite: 900 });
    });
    const spend = new SpendGuard(30);
    const row = await runCompositionTrial({
      client: { chat: { completions: { create } } } as never,
      harness: {
        validate: async () => ({ ok: true as const }),
        render: async () => null,
        close: async () => undefined,
      },
      spend,
      condition: DIRECTOR_EVAL_CONDITIONS[0],
      intent: loadDirectorEvalCorpus()[0],
      cacheState: 'cold',
      trial: 2,
      runId: 'transport-retry',
      transportRetryDelay: async () => undefined,
    });

    expect(row.strictSchemaValid).toBe(true);
    expect(spend.providerCalls).toBe(2);
    expect(spend.entries.filter((entry) => entry.status === 'failed')).toHaveLength(1);
    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
  });

  it('retries an invalid blind-judge payload without rerunning composition', async () => {
    const proposal = strictProposal('judge-retry-box');
    let judgeAttempts = 0;
    const create = vi.fn(async (request: { stream?: boolean }) => {
      if (request.stream) return streamResponse(proposal, { cached: 0, cacheWrite: 900 });
      judgeAttempts += 1;
      if (judgeAttempts === 1) return {
        choices: [{ message: { content: '' } }],
        usage: smallUsage(),
      };
      return judgeResponse();
    });
    const spend = new SpendGuard(30);
    const row = await runCompositionTrial({
      client: { chat: { completions: { create } } } as never,
      harness: {
        validate: async () => ({ ok: true as const }),
        render: async () => 'data:image/jpeg;base64,c3ludGhldGlj',
        close: async () => undefined,
      },
      spend,
      condition: DIRECTOR_EVAL_CONDITIONS[0],
      intent: loadDirectorEvalCorpus()[0],
      cacheState: 'cold',
      trial: 1,
      runId: 'judge-semantic-retry',
    });
    expect(row.qualityEvidenceComplete).toBe(true);
    expect(spend.judgeInvalidResponseRetries).toBe(1);
    expect(spend.providerCalls).toBe(3);
  });

  it('charges an aborted hedge loser its conservative reservation', async () => {
    const intent = loadDirectorEvalCorpus()[0];
    const proposal = strictProposal('hedge-box');
    const create = vi.fn(async (
      request: { model: string },
      options?: { signal?: AbortSignal },
    ) => request.model === 'gpt-5.6-luna'
      ? streamResponse(proposal, { cached: 2_500, cacheWrite: 0 })
      : delayedAbortStream(options?.signal));
    const spend = new SpendGuard(30);
    const result = await runConditionProbe({
      client: { chat: { completions: { create } } } as never,
      harness: { validate: async () => ({ ok: true as const }), render: async () => null, close: async () => undefined },
      spend,
      condition: DIRECTOR_EVAL_CONDITIONS[4],
      intent,
      cacheState: 'warm',
      trial: 1,
    }, 'hedge-trial', { currentBoardRaster: null, existingOps: [], visibleObjectIds: [] });

    expect(spend.providerCalls).toBe(2);
    expect(result.text).toBe(proposal);
    expect(result.usageComplete).toBe(false);
    expect(result.costUpperBoundUsd).toBeGreaterThanOrEqual(
      compositionCallReserveUsd('gpt-5.6-terra', 'warm', false, 'low', 2_000),
    );
  });

  it('requires every reported metric to beat every sampled arm by more than two times', () => {
    const dominant = {
      conditionId: 'candidate', firstPassValidity: 0.9, qualityGrade: 4,
      p50FirstValidOpMs: 400, meanCostUsd: 0.001, p50TtftMs: 300,
      p50CompleteSceneMs: 800, strictSchemaValidity: 0.9,
      validatorPassRate: 0.9, storyboardCoverageRate: 0.9,
      meanCostUpperBoundUsd: 0.001,
    };
    const weak = {
      conditionId: 'weak', firstPassValidity: 0.4, qualityGrade: 1.5,
      p50FirstValidOpMs: 1_000, meanCostUsd: 0.003, p50TtftMs: 800,
      p50CompleteSceneMs: 2_000, strictSchemaValidity: 0.4,
      validatorPassRate: 0.4, storyboardCoverageRate: 0.4,
      meanCostUpperBoundUsd: 0.003,
    };
    expect(conditionDominatingByMoreThan2x([dominant, weak])).toBe('candidate');
    expect(conditionDominatingByMoreThan2x([
      { ...dominant, firstPassValidity: 0.8 },
      { ...weak, firstPassValidity: 0.5 },
    ])).toBeNull();
  });

  it('carries prior interrupted-run liability into the session authorization preflight', async () => {
    const create = vi.fn();
    await expect(runLiveDirectorEval({
      client: { chat: { completions: { create } } } as never,
      harnessUrl: 'http://127.0.0.1:1/dev/board',
      maxSpendUsd: 29.75,
      priorReservedUsd: 0.26,
    })).rejects.toThrow(/session authorization.*No provider call was made/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('stops the study on the first output-ceiling-censored composition leg', async () => {
    const create = vi.fn(async () => streamResponse(
      '{"template":null,"groupLabel":"truncated',
      { cached: 0, cacheWrite: 900 },
      900,
      'length',
    ));
    let checkpoints = 0;
    await expect(runLiveDirectorEval({
      client: { chat: { completions: { create } } } as never,
      harnessUrl: 'injected://board',
      harness: {
        validate: async () => ({ ok: true }),
        render: async () => null,
        close: async () => undefined,
      },
      maxSpendUsd: 29.46,
      priorReservedUsd: 0.5349221,
      onCheckpoint: () => { checkpoints += 1; },
    })).rejects.toThrow(/stopped before collecting censored evidence/i);
    expect(create).toHaveBeenCalledTimes(1);
    expect(checkpoints).toBe(1);
  });

  it('completes the full N=5 matrix while blind-grading only the preregistered trial-one sample', async () => {
    const proposal = strictProposal('matrix-box');
    const sketches = materializeSketchCorpus();
    const expectedSketch = new Map(sketches.map((sketch) => [`sketch-${sketch.id}`, sketch.expectedInterpretation]));
    const create = vi.fn(async (request: {
      stream?: boolean;
      prompt_cache_key?: string;
      response_format?: { json_schema?: { name?: string } };
      messages?: Array<{ content?: unknown }>;
    }) => {
      if (request.stream) {
        const warm = request.prompt_cache_key?.includes('-cold:') !== true;
        return streamResponse(proposal, { cached: warm ? 2_500 : 0, cacheWrite: warm ? 0 : 900 });
      }
      const name = request.response_format?.json_schema?.name;
      if (name === 'noura_vision_audit') {
        const group = imageGroup(request.messages);
        const clean = group.includes('clean_control');
        return {
          choices: [{ message: { content: JSON.stringify({ approved: clean, issues: clean ? [] : ['seeded defect'] }) } }],
          usage: smallUsage(),
        };
      }
      if (name === 'noura_sketch_interpretation') {
        const group = imageGroup(request.messages);
        return {
          choices: [{ message: { content: JSON.stringify({ interpretation: expectedSketch.get(group) ?? '', confidence: 0.9 }) } }],
          usage: smallUsage(),
        };
      }
      return judgeResponse();
    });
    let checkpointCount = 0;
    const report = await runLiveDirectorEval({
      client: { chat: { completions: { create } } } as never,
      harnessUrl: 'injected://board',
      harness: {
        validate: async () => ({ ok: true }),
        render: async (_ops, groupId) => `data:image/jpeg;base64,${Buffer.from(groupId ?? 'board').toString('base64')}`,
        close: async () => undefined,
      },
      maxSpendUsd: 28.8,
      priorReservedUsd: 1.1,
      onCheckpoint: () => { checkpointCount += 1; },
    });

    expect(report.pass).toBe(true);
    expect(report.trials).toHaveLength(1_800);
    expect(checkpointCount).toBe(1_800);
    expect(report.trials.filter((trial) => trial.qualitySampled)).toHaveLength(125);
    expect(report.trials.filter((trial) => !trial.qualitySampled).every((trial) =>
      trial.qualityGrade === null && !trial.qualityEvidenceComplete)).toBe(true);
    expect(report.conditionSummaries.every((summary) =>
      summary.firstPassValidity === 1 && summary.qualityGrade === 4)).toBe(true);
    expect(report.cacheEvidenceComplete).toBe(true);
    expect(report.qualityEvidenceComplete).toBe(true);
    expect(report.qualitySample).toEqual({
      preregisteredTrial: 1,
      cacheState: 'cold',
      intentIds: loadDirectorQualitySampleIntentIds(),
      plannedRows: 125,
      observedRows: 125,
      eligibleRows: 125,
      gradedRows: 125,
    });
    expect(report.visionAudit?.trials).toHaveLength(48);
    expect(report.sketchGrounding?.rows).toHaveLength(60);
    expect(report.providerCalls).toBe(2_397);
    expect(report.conservativePlanFitsRunCap).toBe(false);
    expect(report.budgetPlan.conservativeTotalUsd).toBeGreaterThan(28.8);
    expect(report.accountedCostUsd).toBeLessThan(28.8);
    expect(report.authorizationLedger).toEqual({
      sessionHardCapUsd: 30,
      priorReservedUsd: 1.1,
      runMaxSpendUsd: 28.8,
      combinedMaximumUsd: 29.9,
    });
  }, 60_000);

  it('records individual warm misses and fails the aggregate cache sufficiency rule', async () => {
    const proposal = strictProposal('cache-miss-box');
    const create = vi.fn(async (request: { stream?: boolean }) => request.stream
      ? streamResponse(proposal, { cached: 0, cacheWrite: 900 })
      : judgeResponse());
    const report = await runLiveDirectorEval({
      client: { chat: { completions: { create } } } as never,
      harnessUrl: 'injected://board',
      harness: {
        validate: async () => ({ ok: true }),
        render: async (_ops, groupId) => `data:image/jpeg;base64,${Buffer.from(groupId ?? 'board').toString('base64')}`,
        close: async () => undefined,
      },
      maxSpendUsd: 30,
    });
    expect(report.pass).toBe(false);
    expect(report.stoppedEarly).toBeNull();
    expect(report.cacheEvidenceComplete).toBe(false);
    expect(report.trials).toHaveLength(1_800);
    expect(report.trials.some((trial) => trial.cacheState === 'warm' && !trial.cacheExpectationMet)).toBe(true);
    expect(report.visionAudit).not.toBeNull();
  });
});

function strictProposal(id: string): string {
  return JSON.stringify({
    template: null,
    groupLabel: 'Evaluation scene',
    representation: 'diagram',
    illustration: null,
    steps: [{
      id: 'outline', reveal: 'outline', narration: 'Here is the new exact scale.',
      ops: [{
        op: 'add', id, color: null,
        spec: { kind: 'box', at: [700, 300], w: 300, h: 120, text: 'new representation' },
      }],
    }],
  });
}

async function* streamResponse(
  text: string,
  usage: { cached: number; cacheWrite: number },
  completionTokens = 120,
  finishReason: 'stop' | 'length' = 'stop',
) {
  yield { choices: [{ delta: { content: text }, finish_reason: finishReason }], usage: null };
  yield {
    choices: [],
    usage: {
      prompt_tokens: 3_000,
      completion_tokens: completionTokens,
      prompt_tokens_details: {
        cached_tokens: usage.cached,
        cache_write_tokens: usage.cacheWrite,
      },
    },
  };
}

async function* delayedAbortStream(signal?: AbortSignal) {
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  if (signal?.aborted) throw new Error('aborted hedge leg');
  yield { choices: [], usage: null };
}

function judgeResponse() {
  return {
    choices: [{ message: { content: JSON.stringify({ grade: 4, reasons: ['clear and coherent'] }) } }],
    usage: {
      prompt_tokens: 600,
      completion_tokens: 30,
      prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 0 },
    },
  };
}

function smallUsage() {
  return {
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  };
}

function imageGroup(messages: Array<{ content?: unknown }> | undefined): string {
  const content = messages?.[1]?.content as Array<{ type?: string; image_url?: { url?: string } }> | undefined;
  const url = content?.find((part) => part.type === 'image_url')?.image_url?.url ?? '';
  const encoded = url.split(',')[1] ?? '';
  return Buffer.from(encoded, 'base64').toString();
}
