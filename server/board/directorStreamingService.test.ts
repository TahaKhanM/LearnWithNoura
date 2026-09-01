import { describe, expect, it, vi } from 'vitest';
import type { DirectorSceneRequest } from './director.js';
import {
  createOpenAIDirectorStreamPort,
  directorStreamMessages,
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
    const port = createOpenAIDirectorStreamPort({
      client: { chat: { completions: { create } } } as never,
      model: 'gpt-5.6-terra',
      reasoningEffort: 'low',
      maxCompletionTokens: 4_000,
    });
    const controller = new AbortController();
    const output: string[] = [];
    for await (const delta of port.streamProposal({
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

  it('aborts before exposing a delta after the request epoch changes', async () => {
    const create = vi.fn(async () => chunks(['late']));
    const port = createOpenAIDirectorStreamPort({
      client: { chat: { completions: { create } } } as never,
      model: 'gpt-5.6-terra', reasoningEffort: 'low', maxCompletionTokens: 4_000,
    });
    const controller = new AbortController();
    controller.abort('superseded visual');
    const stream = port.streamProposal({
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
