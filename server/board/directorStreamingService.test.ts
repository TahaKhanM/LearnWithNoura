import { describe, expect, it, vi } from 'vitest';
import type { DirectorSceneRequest } from './director.js';
import {
  createOpenAIDirectorLayoutCorrectionPort,
  createOpenAISceneModelPort,
  directorStreamMessages,
  layoutCorrectionMessages,
} from './directorStreamingService.js';

describe('OpenAI Director streaming port', () => {
  it('pins strict streaming configuration and propagates the epoch abort signal', async () => {
    let capturedRequest: Record<string, unknown> | null = null;
    let capturedSignal: AbortSignal | undefined;
    const create = vi.fn(async (request: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      capturedRequest = request;
      capturedSignal = options?.signal;
      return chunks(['{"template":null,', '"groupLabel":"x"}']);
    });
    const port = createOpenAISceneModelPort({
      client: { chat: { completions: { create } } } as never,
      model: 'gpt-5.6-terra',
      reasoningEffort: 'low',
      maxCompletionTokens: 4_000,
    });
    const controller = new AbortController();
    const output: string[] = [];
    for await (const delta of port.streamPropose({
      request: sceneRequest('one idea'), boardImage: null, signal: controller.signal,
    })) output.push(delta);

    expect(output.join('')).toContain('groupLabel');
    expect(capturedSignal).toBe(controller.signal);
    expect(capturedRequest).toMatchObject({
      model: 'gpt-5.6-terra',
      reasoning_effort: 'low',
      verbosity: 'low',
      stream: true,
      max_completion_tokens: 4_000,
      response_format: { type: 'json_schema', json_schema: { strict: true } },
    });
  });

  it('keeps the cacheable policy static and learner data out of the payload', () => {
    const first = sceneRequest('first idea');
    const second = sceneRequest('second idea');
    const firstMessages = directorStreamMessages(first, 'data:image/jpeg;base64,Ym9hcmQ=');
    const secondMessages = directorStreamMessages(second, null);

    expect(firstMessages[0]).toEqual(secondMessages[0]);
    expect(JSON.stringify(firstMessages[0])).not.toContain(first.idea);
    expect(JSON.stringify(firstMessages[1])).toContain(first.idea);
    expect(JSON.stringify(firstMessages)).not.toContain(first.learnerContext);
    expect(firstMessages[1]?.content).toEqual(expect.arrayContaining([
      { type: 'image', dataUrl: 'data:image/jpeg;base64,Ym9hcmQ=' },
    ]));
  });

  it('streams a low-effort correction from closed ids and bounds only', async () => {
    let capturedRequest: Record<string, unknown> | null = null;
    const create = vi.fn(async (request: Record<string, unknown>) => {
      capturedRequest = request;
      return chunks(['{"placements":[{"id":"move-me","dx":0,"dy":120,"side":null}]}']);
    });
    const port = createOpenAIDirectorLayoutCorrectionPort({
      client: { chat: { completions: { create } } } as never,
      model: 'gpt-5.6-terra',
      reasoningEffort: 'low',
      maxCompletionTokens: 1_000,
    });
    const input = {
      request: sceneRequest('two colliding boxes'),
      priorOps: [],
      rejectedOps: [{
        op: 'add' as const, id: 'move-me',
        spec: { kind: 'box' as const, at: [500, 300] as [number, number], w: 220, h: 100, text: 'Meaning stays fixed' },
      }],
      layoutIssues: [{
        code: 'collision' as const,
        itemId: 'move-me',
        withItemId: 'visible-box',
        itemBounds: { x: 390, y: 250, w: 220, h: 100 },
        withItemBounds: { x: 390, y: 245, w: 220, h: 100 },
      }],
      signal: new AbortController().signal,
    };
    const output: string[] = [];
    for await (const delta of port.streamPlacements(input)) output.push(delta);

    expect(output.join('')).toContain('move-me');
    expect(capturedRequest).toMatchObject({
      model: 'gpt-5.6-terra',
      reasoning_effort: 'low',
      verbosity: 'low',
      stream: true,
      max_completion_tokens: 1_000,
      response_format: { json_schema: { name: 'noura_director_layout_correction', strict: true } },
    });
    const messages = layoutCorrectionMessages(input);
    const userPayload = messages[1]?.content[0];
    expect(userPayload?.type).toBe('text');
    expect(userPayload?.type === 'text' ? JSON.parse(userPayload.text) : null).toMatchObject({
      layoutIssues: [expect.objectContaining({ code: 'collision', itemBounds: expect.any(Object) })],
    });
    expect(JSON.stringify(messages)).not.toContain(input.request.learnerContext);
  });

  it('aborts before exposing a delta after the request epoch changes', async () => {
    const create = vi.fn(async () => chunks(['late']));
    const port = createOpenAISceneModelPort({
      client: { chat: { completions: { create } } } as never,
      model: 'gpt-5.6-terra', reasoningEffort: 'low', maxCompletionTokens: 4_000,
    });
    const controller = new AbortController();
    controller.abort('superseded visual');
    const stream = port.streamPropose({
      request: sceneRequest('aborted'), boardImage: null, signal: controller.signal,
    })[Symbol.asyncIterator]();
    await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' });
  });
});

function sceneRequest(idea: string): DirectorSceneRequest {
  return {
    purpose: 'teach one synthetic idea',
    idea,
    constraints: null,
    density: 'minimal',
    targetObjectIds: [],
    sectionId: 'section-1',
    sectionLabel: 'Synthetic section',
    boardSummary: 'one released box',
    visibleObjectIds: ['visible-box'],
    currentBoardOps: [],
    stageBrief: 'synthetic stage',
    learnerContext: 'private learner detail must never enter the request',
  };
}

async function* chunks(values: string[]) {
  for (const value of values) {
    yield { choices: [{ delta: { content: value } }] };
  }
}
