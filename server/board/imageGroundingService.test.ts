import { describe, expect, it, vi } from 'vitest';
import { createOpenAIImageGroundingProposalPort, imageGroundingMessages } from './imageGroundingService.js';

describe('OpenAI image grounding proposal port', () => {
  it('uses strict Luna-low structured output and propagates abort identity', async () => {
    let captured: Record<string, unknown> | null = null;
    let capturedSignal: AbortSignal | undefined;
    const create = vi.fn(async (body: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      captured = body;
      capturedSignal = options?.signal;
      return { choices: [{ message: { content: JSON.stringify({
        selector: { type: 'FragmentSelector', unit: 'percent', x: 0.2, y: 0.25, w: 0.3, h: 0.2 },
        confidence: 0.91,
      }) } }] };
    });
    const port = createOpenAIImageGroundingProposalPort({
      client: { chat: { completions: { create } } } as never,
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
    });
    const controller = new AbortController();
    await expect(port.propose({
      imageId: 'worksheet-image', hint: 'the axle', boardImage: 'data:image/jpeg;base64,Ym9hcmQ=',
    }, { signal: controller.signal })).resolves.toMatchObject({ confidence: 0.91 });
    expect(capturedSignal).toBe(controller.signal);
    expect(captured).toMatchObject({
      model: 'gpt-5.6-luna',
      reasoning_effort: 'low',
      response_format: { type: 'json_schema', json_schema: { name: 'noura_image_grounding', strict: true } },
    });
  });

  it('keeps identity and transcript fields outside the proposal payload', () => {
    const messages = imageGroundingMessages({
      imageId: 'worksheet-image', hint: 'the left denominator', boardImage: 'data:image/jpeg;base64,Ym9hcmQ=',
      learnerName: 'Private Name', learnerContext: 'PRIVATE_TRANSCRIPT',
    } as never);
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain('Private Name');
    expect(serialized).not.toContain('PRIVATE_TRANSCRIPT');
    expect(serialized).toContain('the left denominator');
    expect(serialized).toContain('data:image/jpeg');
  });

  it('fails closed on malformed or invalid selector output', async () => {
    const replies = ['not json', '{"selector":{"type":"PointSelector","x":2,"y":0.5},"confidence":0.9}'];
    const port = createOpenAIImageGroundingProposalPort({
      client: { chat: { completions: { create: async () => ({ choices: [{ message: { content: replies.shift() } }] }) } } } as never,
      model: 'gpt-5.6-luna', reasoningEffort: 'low',
    });
    const input = { imageId: 'worksheet-image', hint: 'target', boardImage: 'data:image/jpeg;base64,Yg==' };
    await expect(port.propose(input, { signal: new AbortController().signal })).resolves.toBeNull();
    await expect(port.propose(input, { signal: new AbortController().signal })).resolves.toBeNull();
  });
});
