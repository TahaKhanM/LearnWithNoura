import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import { runTutorTurn } from './tutorAgent';

function completion(): OpenAI.Chat.ChatCompletion {
  return {
    id: 'test',
    object: 'chat.completion',
    created: 0,
    model: 'test',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: {
          role: 'assistant',
          content: 'I can see your drawing.',
          refusal: null,
        },
      },
    ],
  };
}

function inspectingClient(
  inspect: (params: OpenAI.Chat.ChatCompletionCreateParams) => void,
): OpenAI {
  return {
    chat: {
      completions: {
        create: async (params: OpenAI.Chat.ChatCompletionCreateParams) => {
          inspect(params);
          return completion();
        },
      },
    },
  } as unknown as OpenAI;
}

describe('runTutorTurn board context', () => {
  it('always includes the structured scene in the learner turn', async () => {
    let body: OpenAI.Chat.ChatCompletionCreateParams | undefined;

    await runTutorTurn(
      inspectingClient((params) => {
        body = params;
      }),
      'test-model',
      [],
      'What does my note mean?',
      { objects: [{ owner: 'learner', type: 'text', text: 'c²' }] },
      undefined,
      () => undefined,
    );

    const learnerMessage = body?.messages.find((message) => message.role === 'user');
    expect(learnerMessage?.content).toContain('CURRENT_WHITEBOARD_STATE');
    expect(learnerMessage?.content).toContain('"owner":"learner"');
  });

  it('attaches valid visual context at high detail alongside the scene', async () => {
    let body: OpenAI.Chat.ChatCompletionCreateParams | undefined;
    const image = 'data:image/png;base64,aGVsbG8=';

    await runTutorTurn(
      inspectingClient((params) => {
        body = params;
      }),
      'test-model',
      [],
      'What did I draw?',
      { objects: [{ owner: 'learner', type: 'freehand' }] },
      image,
      () => undefined,
    );

    const learnerMessage = body?.messages.find((message) => message.role === 'user');
    const parts = learnerMessage?.content as OpenAI.Chat.ChatCompletionContentPart[];
    expect(parts[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('CURRENT_WHITEBOARD_IMAGE is attached'),
    });
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: image, detail: 'high' },
    });
  });

  it('does not attach untrusted remote image URLs', async () => {
    let body: OpenAI.Chat.ChatCompletionCreateParams | undefined;

    await runTutorTurn(
      inspectingClient((params) => {
        body = params;
      }),
      'test-model',
      [],
      'What did I draw?',
      { objects: [] },
      'https://example.com/untrusted.png',
      () => undefined,
    );

    const learnerMessage = body?.messages.find((message) => message.role === 'user');
    expect(typeof learnerMessage?.content).toBe('string');
    expect(learnerMessage?.content).not.toContain('CURRENT_WHITEBOARD_IMAGE is attached');
  });
});
