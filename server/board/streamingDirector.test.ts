import { describe, expect, it, vi } from 'vitest';
import type { DirectorSceneRequest } from './director.js';
import type { DirectorStreamModelPort } from './directorStreamingService.js';
import { streamVisual } from './streamingDirector.js';

describe('streaming Board Director', () => {
  it('delivers a browser-validated first step before the stream completes', async () => {
    const proposal = scene();
    const text = JSON.stringify(proposal);
    const secondStart = text.indexOf(JSON.stringify(proposal.steps[1]));
    const releaseTail = deferred<void>();
    const firstDelivered = deferred<void>();
    const port: DirectorStreamModelPort = {
      streamProposal: () => controlledChunks(
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

  it('fails closed on a later cumulative browser rejection while keeping the first callback', async () => {
    const port: DirectorStreamModelPort = { streamProposal: () => oneChunk(JSON.stringify(scene())) };
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
    });
    expect(delivered).toEqual(['s1']);
  });

  it('propagates an epoch abort after the first delivered step', async () => {
    const proposal = scene();
    const text = JSON.stringify(proposal);
    const secondStart = text.indexOf(JSON.stringify(proposal.steps[1]));
    const controller = new AbortController();
    const port: DirectorStreamModelPort = {
      streamProposal: () => controlledChunks(
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
