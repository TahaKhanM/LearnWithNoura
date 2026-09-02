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

  it('adopts medium escalation as the default layout recovery and skips the rejected correction arm', async () => {
    const proposal = JSON.stringify({
      template: null,
      groupLabel: 'Recovered scene',
      representation: 'diagram',
      illustration: null,
      steps: [{
        id: 's1', reveal: 'outline', narration: 'Show the box.',
        ops: [{ op: 'add', id: 'box', color: 'blue', spec: { kind: 'box', at: [500, 300], w: 220, h: 100, text: 'recover me' } }],
      }],
    });
    const calls: Array<{ effort: string; schema: string }> = [];
    const create = vi.fn(async (body: {
      reasoning_effort?: string;
      response_format?: { json_schema?: { name?: string } };
    }) => {
      calls.push({
        effort: String(body.reasoning_effort),
        schema: String(body.response_format?.json_schema?.name),
      });
      return chunks([proposal]);
    });
    const director = createLiveStreamingBoardDirector({
      client: { chat: { completions: { create } } } as never,
      model: 'gpt-5.6-terra', reasoningEffort: 'low', harness: null,
    });
    let validations = 0;
    const input = request();
    input.validateScene = async () => {
      validations += 1;
      return validations === 1
        ? {
            ok: false,
            issues: ['collision:box:fixed'],
            layoutIssues: [{
              code: 'collision', itemId: 'box', withItemId: 'fixed',
              itemBounds: { x: 390, y: 250, w: 220, h: 100 },
              withItemBounds: { x: 390, y: 245, w: 220, h: 100 },
            }],
          }
        : { ok: true };
    };

    await expect(director(input, {
      signal: new AbortController().signal,
      onStep: async () => {},
    })).resolves.toMatchObject({ ok: true });
    expect(calls).toEqual([
      { effort: 'low', schema: 'noura_director_vnext_eval' },
      { effort: 'medium', schema: 'noura_director_vnext_eval' },
    ]);
  });

  it('retains targeted correction as an explicit non-default study path', async () => {
    const proposal = JSON.stringify({
      template: null,
      groupLabel: 'Corrected scene',
      representation: 'diagram',
      illustration: null,
      steps: [{
        id: 's1', reveal: 'outline', narration: 'Show the box.',
        ops: [{ op: 'add', id: 'box', color: 'blue', spec: { kind: 'box', at: [500, 300], w: 220, h: 100, text: 'correct me' } }],
      }],
    });
    const calls: Array<{ effort: string; schema: string }> = [];
    const create = vi.fn(async (body: {
      reasoning_effort?: string;
      response_format?: { json_schema?: { name?: string } };
    }) => {
      const schema = String(body.response_format?.json_schema?.name);
      calls.push({ effort: String(body.reasoning_effort), schema });
      return chunks(schema === 'noura_director_layout_correction'
        ? ['{"placements":[{"id":"box","dx":0,"dy":120,"side":null}]}']
        : [proposal]);
    });
    const director = createLiveStreamingBoardDirector({
      client: { chat: { completions: { create } } } as never,
      model: 'gpt-5.6-terra', reasoningEffort: 'low', harness: null,
      recoveryStrategy: 'targeted_then_medium',
    });
    const input = request();
    input.validateScene = async (ops) => {
      const box = ops.find((op) => op.op === 'add' && op.id === 'box');
      return box?.op === 'add' && box.spec.kind === 'box' && box.spec.at[1] === 420
        ? { ok: true }
        : {
            ok: false,
            issues: ['collision:box:fixed'],
            layoutIssues: [{
              code: 'collision', itemId: 'box', withItemId: 'fixed',
              itemBounds: { x: 390, y: 250, w: 220, h: 100 },
              withItemBounds: { x: 390, y: 245, w: 220, h: 100 },
            }],
          };
    };
    const delivered: number[] = [];
    const result = await director(input, {
      signal: new AbortController().signal,
      onStep: async (step) => {
        const box = step.ops.find((op) => op.id === 'box');
        if (box?.spec.kind === 'box') delivered.push(box.spec.at[1]);
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { effort: 'low', schema: 'noura_director_vnext_eval' },
      { effort: 'low', schema: 'noura_director_layout_correction' },
    ]);
    expect(delivered).toEqual([420]);
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

  it('retries a provider transport failure once without reinterpreting it as schema validity', async () => {
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
    expect(efforts).toEqual(['low', 'medium']);
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
