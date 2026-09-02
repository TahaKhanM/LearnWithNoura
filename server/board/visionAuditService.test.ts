import { describe, expect, it, vi } from 'vitest';
import type { VisionAuditInput } from './visionAudit.js';
import { createOpenAIVisionAuditPort, createVisionAuditForPipeline, visionAuditMessages } from './visionAuditService.js';

describe('OpenAI vision audit port', () => {
  it('constructs no audit surface for the classic Director pipeline', () => {
    const create = vi.fn(() => ({ model: 'gpt-5.6-luna' as const }));

    expect(createVisionAuditForPipeline('classic', create)).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(createVisionAuditForPipeline('streaming', create)).toEqual({ model: 'gpt-5.6-luna' });
    expect(create).toHaveBeenCalledOnce();
  });

  it('pins strict decoding and propagates the visual epoch signal', async () => {
    let capturedRequest: Record<string, unknown> | null = null;
    let capturedSignal: AbortSignal | undefined;
    const create = vi.fn(async (body: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      capturedRequest = body;
      capturedSignal = options?.signal;
      return { choices: [{ message: { content: '{"approved":true,"issues":[]}' } }] };
    });
    const audit = createOpenAIVisionAuditPort({
      client: { chat: { completions: { create } } } as never,
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
    });
    const controller = new AbortController();
    await expect(audit.inspect(input(), { signal: controller.signal })).resolves.toEqual({ outcome: 'approved', issues: [] });
    expect(capturedSignal).toBe(controller.signal);
    expect(capturedRequest).toMatchObject({
      model: 'gpt-5.6-luna',
      reasoning_effort: 'low',
      response_format: { type: 'json_schema', json_schema: { name: 'noura_vision_audit', strict: true } },
    });
  });

  it('keeps learner context and identity outside the audit payload', () => {
    const privateSentinel = 'PRIVATE_LEARNER_TRANSCRIPT_91';
    const messages = visionAuditMessages({
      ...input(),
      learnerContext: privateSentinel,
      learnerName: 'Private Name',
    } as VisionAuditInput & { learnerContext: string; learnerName: string });
    expect(JSON.stringify(messages)).not.toContain(privateSentinel);
    expect(JSON.stringify(messages)).not.toContain('Private Name');
    expect(JSON.stringify(messages)).toContain('compare two quantities');
    const second = visionAuditMessages({ ...input(), purpose: 'a different intent' });
    expect(messages[0]).toEqual(second[0]);
    expect(JSON.stringify(messages[0])).toContain('first incremental reveal');
    expect(JSON.stringify(messages[0])).not.toContain('a different intent');
  });

  it('turns malformed or schema-invalid model output into a fail-closed invalid verdict', async () => {
    const replies = [
      'not json',
      '{"approved":true,"issues":[],"extra":1}',
      '{"approved":true,"issues":["wrong visible value"]}',
    ];
    const audit = createOpenAIVisionAuditPort({
      client: {
        chat: { completions: { create: async () => ({ choices: [{ message: { content: replies.shift() } }] }) } },
      } as never,
      model: 'gpt-5.6-luna', reasoningEffort: 'low',
    });
    await expect(audit.inspect(input(), { signal: new AbortController().signal })).resolves.toMatchObject({ outcome: 'invalid' });
    await expect(audit.inspect(input(), { signal: new AbortController().signal })).resolves.toMatchObject({ outcome: 'invalid' });
    await expect(audit.inspect(input(), { signal: new AbortController().signal })).resolves.toMatchObject({ outcome: 'invalid' });
  });
});

function input(): VisionAuditInput {
  return {
    purpose: 'compare two quantities',
    idea: 'show why one bar is larger',
    constraints: 'labels match values',
    candidateImage: 'data:image/jpeg;base64,YXVkaXQ=',
  };
}
