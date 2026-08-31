import { describe, expect, it, vi } from 'vitest';
import { DIRECTOR_EVAL_CONDITIONS, loadDirectorEvalCorpus } from './corpus.js';
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

  it('charges an aborted hedge loser its conservative reservation', async () => {
    const intent = loadDirectorEvalCorpus()[0];
    const proposal = strictProposal('hedge-box');
    const create = vi.fn(async (
      request: { model: string },
      options?: { signal?: AbortSignal },
    ) => request.model === 'gpt-5.6-luna'
      ? streamResponse(proposal, { cached: 700, cacheWrite: 0 })
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
    expect(result.costUpperBoundUsd).toBeGreaterThanOrEqual(compositionCallReserveUsd('gpt-5.6-terra', 'warm'));
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

  it('refuses an unaffordable full plan before constructing any provider call', async () => {
    const create = vi.fn();
    await expect(runLiveDirectorEval({
      client: { chat: { completions: { create } } } as never,
      harnessUrl: 'http://127.0.0.1:1/dev/board',
      maxSpendUsd: 25,
    })).rejects.toThrow(/No provider call was made/);
    expect(create).not.toHaveBeenCalled();
  });

  it('completes the full N=5 warm/cold matrix with four warmups and both live studies', async () => {
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
        return streamResponse(proposal, { cached: warm ? 700 : 0, cacheWrite: warm ? 0 : 900 });
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
      maxSpendUsd: 30,
      onCheckpoint: () => { checkpointCount += 1; },
    });

    expect(report.pass).toBe(true);
    expect(report.trials).toHaveLength(1_800);
    expect(checkpointCount).toBe(1_800);
    expect(report.cacheEvidenceComplete).toBe(true);
    expect(report.visionAudit?.trials).toHaveLength(48);
    expect(report.sketchGrounding?.rows).toHaveLength(60);
    expect(report.providerCalls).toBe(4_072);
    expect(report.accountedCostUsd).toBeLessThan(30);
  }, 60_000);

  it('stops immediately when a selected warm leg does not report a cache hit', async () => {
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
    expect(report.stoppedEarly).toMatch(/^cache_miss:/);
    expect(report.trials.some((trial) => trial.cacheState === 'warm' && !trial.cacheExpectationMet)).toBe(true);
    expect(report.visionAudit).toBeNull();
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
) {
  yield { choices: [{ delta: { content: text } }], usage: null };
  yield {
    choices: [],
    usage: {
      prompt_tokens: 1_000,
      completion_tokens: 120,
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
