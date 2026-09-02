import { describe, expect, it, vi } from 'vitest';
import type { DirectorSceneRequest } from './director.js';
import type { SceneModelPort } from './directorStreamingService.js';
import type { LayoutCorrectionPort } from './layoutCorrection.js';
import { StreamingDirectorPrecommitError, streamVisual } from './streamingDirector.js';

describe('streaming Board Director', () => {
  it('delivers a browser-validated first step before the stream completes', async () => {
    const proposal = scene();
    const text = JSON.stringify(proposal);
    const secondStart = text.indexOf(JSON.stringify(proposal.steps[1]));
    const releaseTail = deferred<void>();
    const firstDelivered = deferred<void>();
    const port: SceneModelPort = {
      streamPropose: () => controlledChunks(
        text.slice(0, secondStart + 10),
        text.slice(secondStart + 10),
        releaseTail.promise,
      ),
    };
    const validateScene = vi.fn(async (_ops: unknown[]) => ({ ok: true as const }));
    const delivered: string[] = [];
    let settled = false;
    const resultPromise = streamVisual({
      model: port,
      validateScene,
      renderScene: async () => null,
    }, request(), {
      signal: new AbortController().signal,
      onStep: async (step) => {
        delivered.push(step.step.id);
        if (delivered.length === 1) firstDelivered.resolve();
      },
    }).finally(() => { settled = true; });

    await firstDelivered.promise;
    expect(delivered).toEqual(['s1']);
    expect(settled).toBe(false);
    releaseTail.resolve();
    await expect(resultPromise).resolves.toMatchObject({ ok: true, scene: { groupId: 'section-1' } });
    expect(delivered).toEqual(['s1', 's2']);
    expect(validateScene.mock.calls.map(([ops]) => ops.length)).toEqual([1, 2]);
  });

  it('validates every cumulative step in the existing board context', async () => {
    const input = request();
    input.currentBoardOps = [{
      op: 'add', id: 'existing', color: 'ink',
      spec: { kind: 'line', from: [80, 80], to: [920, 80] },
    }];
    input.visibleObjectIds = ['existing'];
    const validatedIds: string[][] = [];
    const result = await streamVisual({
      model: { streamPropose: () => oneChunk(JSON.stringify(scene())) },
      validateScene: async (ops) => {
        const ids = ops.flatMap((op) => op.op === 'add' ? [op.id] : []);
        validatedIds.push(ids);
        return ids.includes('existing')
          ? { ok: true as const }
          : { ok: false as const, issues: ['existing board context is missing'] };
      },
      renderScene: async () => null,
    }, input, {
      signal: new AbortController().signal,
      onStep: async () => {},
    });

    expect(result.ok).toBe(true);
    expect(validatedIds).toEqual([
      ['existing', 'a'],
      ['existing', 'a', 'b'],
    ]);
  });

  it('runs one targeted placement correction before rejecting browser layout', async () => {
    const proposal = { ...scene(), steps: [step('s1', 'a')] };
    const streamPlacements = vi.fn(() => oneChunk(
      '{"placements":[{"id":"a","dx":0,"dy":120,"side":null}]}',
    ));
    const layoutCorrection: LayoutCorrectionPort = { streamPlacements };
    const validateScene = vi.fn(async (ops: Array<{ op: string; id?: string; spec?: { at?: [number, number] } }>) =>
      ops[0]?.spec?.at?.[1] === 420
        ? { ok: true as const }
        : {
            ok: false as const,
            issues: ['collision:a:fixed'],
            layoutIssues: [{
              code: 'collision' as const,
              itemId: 'a',
              withItemId: 'fixed',
              itemBounds: { x: 390, y: 250, w: 220, h: 100 },
              withItemBounds: { x: 390, y: 245, w: 220, h: 100 },
            }],
          });
    const delivered: Array<[number, number] | undefined> = [];
    const result = await streamVisual({
      model: { streamPropose: () => oneChunk(JSON.stringify(proposal)) },
      validateScene: validateScene as never,
      renderScene: async () => null,
      layoutCorrection,
    }, request(), {
      signal: new AbortController().signal,
      onStep: async (candidate) => {
        delivered.push(candidate.ops[0]?.spec.kind === 'box' ? candidate.ops[0].spec.at : undefined);
      },
    });

    expect(result.ok).toBe(true);
    expect(streamPlacements).toHaveBeenCalledOnce();
    expect(validateScene).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual([[500, 420]]);
  });

  it('fails closed on a later cumulative browser rejection while keeping the first callback', async () => {
    const port: SceneModelPort = { streamPropose: () => oneChunk(JSON.stringify(scene())) };
    const delivered: string[] = [];
    const result = await streamVisual({
      model: port,
      validateScene: async (ops) => ops.length === 1
        ? { ok: true }
        : { ok: false, issues: ['collision'] },
      renderScene: async () => null,
    }, request(), {
      signal: new AbortController().signal,
      onStep: async (step) => { delivered.push(step.step.id); },
    });
    expect(result).toEqual({
      ok: false,
      reasons: ['Step s2 failed browser preflight: collision'],
      retryable: false,
    });
    expect(delivered).toEqual(['s1']);
  });

  it('propagates an epoch abort after the first delivered step', async () => {
    const proposal = scene();
    const text = JSON.stringify(proposal);
    const secondStart = text.indexOf(JSON.stringify(proposal.steps[1]));
    const controller = new AbortController();
    const port: SceneModelPort = {
      streamPropose: () => controlledChunks(
        text.slice(0, secondStart + 10),
        text.slice(secondStart + 10),
        Promise.resolve(),
      ),
    };
    const delivered: string[] = [];
    await expect(streamVisual({
      model: port,
      validateScene: async () => ({ ok: true }),
      renderScene: async () => null,
    }, request(), {
      signal: controller.signal,
      onStep: async (step) => {
        delivered.push(step.step.id);
        controller.abort('new request');
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(delivered).toEqual(['s1']);
  });

  it('rejects an illustration header before delivering any overlay step', async () => {
    const proposal = {
      ...scene(),
      representation: 'illustration',
      illustration: {
        purpose: 'Add context',
        subject: 'A quiet garden',
        style: null,
        requiredElements: ['plants'],
        forbiddenElements: ['text'],
        alt: 'A garden',
      },
    };
    const onStep = vi.fn(async () => {});
    const result = await streamVisual({
      model: { streamPropose: () => oneChunk(JSON.stringify(proposal)) },
      validateScene: async () => ({ ok: true }),
      renderScene: async () => null,
    }, request(), {
      signal: new AbortController().signal,
      onStep,
    });

    expect(result).toEqual({
      ok: false,
      reasons: ['Streaming illustration composition is deferred to the parallel illustration lane.'],
      fallback: 'classic_illustration',
    });
    expect(onStep).not.toHaveBeenCalled();
  });

  it('short-circuits a non-null stream head into the exact deterministic template', async () => {
    let consumedTail = false;
    const providerSignals: AbortSignal[] = [];
    const steps: string[] = [];
    const input = request();
    input.idea = 'Compare 7/12 and 5/8 on one exact fraction strip.';
    const result = await streamVisual({
      model: {
        streamPropose: ({ signal }) => {
          providerSignals.push(signal);
          return (async function* () {
            yield '{"template":"fraction_comparison",';
            consumedTail = true;
            yield '"groupLabel":"must not be consumed"}';
          })();
        },
      },
      validateScene: async () => ({ ok: true }),
      renderScene: async () => null,
    }, input, {
      signal: new AbortController().signal,
      onStep: async (step) => { steps.push(step.step.id); },
    });

    expect(result).toMatchObject({ ok: true, scene: { template: 'fraction_comparison' } });
    expect(steps.length).toBeGreaterThan(0);
    expect(consumedTail).toBe(false);
    expect(providerSignals[0]?.aborted).toBe(true);
  });

  it('maps provider exceptions to closed failure codes', async () => {
    const result = await streamVisual({
      model: {
        streamPropose: () => (async function* () {
          yield await Promise.reject<string>(new Error('PRIVATE PROVIDER FAILURE TEXT'));
        })(),
      },
      validateScene: async () => ({ ok: true }),
      renderScene: async () => null,
    }, request(), {
      signal: new AbortController().signal,
      onStep: async () => {},
    });

    expect(result).toEqual({
      ok: false,
      reasons: ['director_stream_error:provider'],
      retryable: true,
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE PROVIDER FAILURE TEXT');
  });

  it('records first-op telemetry only after the realtime precommit callback succeeds', async () => {
    const timings = vi.fn();
    const result = await streamVisual({
      model: { streamPropose: () => oneChunk(JSON.stringify(scene())) },
      validateScene: async () => ({ ok: true }),
      renderScene: async () => null,
      composition: { model: 'gpt-5.6-terra', reasoningEffort: 'low' },
    }, request(), {
      signal: new AbortController().signal,
      onFirstValidatedOp: timings,
      onStep: async () => { throw new StreamingDirectorPrecommitError('duplicate visible scene'); },
    });
    expect(result).toMatchObject({ ok: false, retryable: true });
    expect(timings).not.toHaveBeenCalled();
  });

});

function scene() {
  return {
    template: null,
    groupLabel: 'Streaming scene',
    representation: 'diagram',
    illustration: null,
    steps: [step('s1', 'a'), step('s2', 'b')],
  };
}

function step(id: string, objectId: string) {
  return {
    id, reveal: 'outline', narration: `Explain ${id}.`,
    ops: [{
      op: 'add', id: objectId, color: 'blue',
      spec: { kind: 'box', at: [500, 300], w: 220, h: 100, text: id },
    }],
  };
}

function request(): DirectorSceneRequest {
  return {
    purpose: 'teach', idea: 'two steps', constraints: null, density: 'minimal',
    targetObjectIds: [], sectionId: 'section-1', sectionLabel: 'Streaming scene',
    boardSummary: 'empty', visibleObjectIds: [], currentBoardOps: [],
    stageBrief: 'stage', learnerContext: 'omitted',
  };
}

async function* oneChunk(value: string) { yield value; }

async function* controlledChunks(first: string, second: string, wait: Promise<void>) {
  yield first;
  await wait;
  yield second;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
