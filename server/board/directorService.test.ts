import { describe, expect, it, vi } from 'vitest';
import type { DirectorSceneRequest } from './director.js';
import { createLiveStreamingBoardDirector } from './directorService.js';

describe('live streaming Director orchestration', () => {
  it('retries one pre-commit validity failure at medium effort', async () => {
    const efforts: string[] = [];
    const valid = JSON.stringify({
      template: null,
      groupLabel: 'Retried scene',
      representation: 'diagram',
      illustration: null,
      steps: [{
        id: 's1', reveal: 'outline', narration: 'Show the box.',
        ops: [{ op: 'add', id: 'box', color: 'blue', spec: { kind: 'box', at: [500, 300], w: 220, h: 100, text: 'retry' } }],
      }],
    });
    const create = vi.fn(async (body: { reasoning_effort?: string }) => {
      efforts.push(String(body.reasoning_effort));
      return chunks(body.reasoning_effort === 'low' ? ['{"template":'] : [valid]);
    });
    const director = createLiveStreamingBoardDirector({
      client: { chat: { completions: { create } } } as never,
      model: 'gpt-5.6-terra',
      reasoningEffort: 'low',
      harness: null,
    });
    const delivered: string[] = [];
    const result = await director(request(), {
      signal: new AbortController().signal,
      onStep: async (step) => { delivered.push(step.step.id); },
    });
    expect(result.ok).toBe(true);
    expect(efforts).toEqual(['low', 'medium']);
    expect(delivered).toEqual(['s1']);
  });

  it('never retries after a streamed step has crossed the callback boundary', async () => {
    const proposal = JSON.stringify({
      template: null,
      groupLabel: 'Partial scene',
      representation: 'diagram',
      illustration: null,
      steps: [{
        id: 's1', reveal: 'outline', narration: 'Show the box.',
        ops: [{ op: 'add', id: 'box', color: 'blue', spec: { kind: 'box', at: [500, 300], w: 220, h: 100, text: 'partial' } }],
      }],
    });
    const malformedTail = `${proposal.slice(0, -2)},`;
    const efforts: string[] = [];
    const create = vi.fn(async (body: { reasoning_effort?: string }) => {
      efforts.push(String(body.reasoning_effort));
      return chunks([malformedTail]);
    });
    const director = createLiveStreamingBoardDirector({
      client: { chat: { completions: { create } } } as never,
      model: 'gpt-5.6-terra', reasoningEffort: 'low', harness: null,
    });
    const delivered: string[] = [];
    const result = await director(request(), {
      signal: new AbortController().signal,
      onStep: async (step) => { delivered.push(step.step.id); },
    });
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(efforts).toEqual(['low']);
    expect(delivered).toEqual(['s1']);
  });

  it('does not reinterpret a provider transport failure as schema validity', async () => {
    const efforts: string[] = [];
    const create = vi.fn(async (body: { reasoning_effort?: string }) => {
      efforts.push(String(body.reasoning_effort));
      throw new Error('network unavailable');
    });
    const director = createLiveStreamingBoardDirector({
      client: { chat: { completions: { create } } } as never,
      model: 'gpt-5.6-terra', reasoningEffort: 'low', harness: null,
    });
    const result = await director(request(), {
      signal: new AbortController().signal,
      onStep: async () => {},
    });
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(efforts).toEqual(['low']);
  });
});

function request(): DirectorSceneRequest {
  return {
    purpose: 'teach', idea: 'retry once', constraints: null, density: 'minimal',
    targetObjectIds: [], sectionId: 'section-1', sectionLabel: 'Retry',
    boardSummary: 'empty', visibleObjectIds: [], currentBoardOps: [],
    stageBrief: 'stage', learnerContext: 'private context',
    validateScene: async () => ({ ok: true }),
    renderScene: async () => 'data:image/jpeg;base64,Ym9hcmQ=',
  };
}

async function* chunks(values: string[]) {
  for (const value of values) yield { choices: [{ delta: { content: value } }] };
}
