import { describe, expect, it, vi } from 'vitest';
import { loadDirectorEvalCorpus } from './corpus.js';
import {
  completeStepsArrayItems,
  containsCompleteValidStep,
  directorEvalMessages,
  inspectFirstCompleteStep,
  runStreamingProbe,
} from './streamingProbe.js';
import { compositionCallReserveUsd } from './budget.js';
import {
  DIRECTOR_VNEXT_EVAL_JSON_SCHEMA,
  DIRECTOR_VNEXT_EVAL_RESPONSE_FORMAT,
  DIRECTOR_STREAM_JSON_SCHEMA,
  DIRECTOR_STREAM_RESPONSE_FORMAT,
  DirectorStreamProposalSchema,
  VNextEvalProposalSchema,
  parseVNextEvalDirectorProposal,
  validatePolicyReadyEvalStep,
} from '../directorStreamSchema.js';
import type { JsonSchema } from '../directorVNextBoardOpSchema.js';

describe('Drawing vNext evaluation stream contract', () => {
  it('uses strict json_schema decoding with template as the first field', () => {
    expect(DIRECTOR_VNEXT_EVAL_RESPONSE_FORMAT).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'noura_director_vnext_eval', strict: true },
    });
    expect(DIRECTOR_STREAM_RESPONSE_FORMAT).toBe(DIRECTOR_VNEXT_EVAL_RESPONSE_FORMAT);
    expect(DIRECTOR_STREAM_JSON_SCHEMA).toBe(DIRECTOR_VNEXT_EVAL_JSON_SCHEMA);
    expect(DirectorStreamProposalSchema).toBe(VNextEvalProposalSchema);
    const properties = DIRECTOR_VNEXT_EVAL_JSON_SCHEMA.properties as Record<string, JsonSchema>;
    expect(Object.keys(properties)).toEqual([
      'template', 'groupLabel', 'representation', 'illustration', 'steps',
    ]);
    expectAllObjectsClosed(DIRECTOR_VNEXT_EVAL_JSON_SCHEMA);
  });

  it('recognizes a complete policy-ready step without waiting for later steps', () => {
    const first = step('first', [boxOp('box-1', 'A } inside narration')]);
    const partial = `{"template":null,"groupLabel":"Fractions","representation":"diagram","illustration":null,"steps":[${JSON.stringify(first)},{"id":"unfinished"`;

    expect(completeStepsArrayItems(partial)).toEqual([JSON.stringify(first)]);
    expect(containsCompleteValidStep(partial, 'minimal')).toBe(true);
    const incompleteFirst = JSON.stringify(first).slice(0, -1);
    expect(containsCompleteValidStep(`{"template":null,"steps":[${incompleteFirst}`)).toBe(false);
  });

  it('does not let an isolated op, non-template-first output, or loose op win a hedge', () => {
    const validStep = step('first', [boxOp('box-1', 'One box')]);
    const isolated = `{"ops":[${JSON.stringify(boxOp('box-1', 'One box'))}]}`;
    const wrongOrder = `{"groupLabel":"Loose","template":null,"steps":[${JSON.stringify(validStep)}]}`;
    const invalidHeader = `{"template":null,"groupLabel":"Loose","representation":"diagram","illustration":{"purpose":"x","subject":"x","style":null,"requiredElements":[],"forbiddenElements":[],"alt":null},"steps":[${JSON.stringify(validStep)}]}`;
    const baseOp = boxOp('box-1', 'One box');
    const loose = step('first', [{
      ...baseOp,
      spec: { ...(baseOp.spec as Record<string, unknown>), unexpected: 'ignored by the old validator' },
    }]);
    const looseText = `{"template":null,"groupLabel":"Loose","representation":"diagram","illustration":null,"steps":[${JSON.stringify(loose)}]}`;

    expect(containsCompleteValidStep(isolated)).toBe(false);
    expect(containsCompleteValidStep(wrongOrder)).toBe(false);
    expect(containsCompleteValidStep(invalidHeader)).toBe(false);
    expect(containsCompleteValidStep(looseText)).toBe(false);
  });

  it('never skips a rejected first step to let a later step win the hedge', () => {
    const text = JSON.stringify({
      template: null,
      groupLabel: 'Ordered scene',
      representation: 'diagram',
      illustration: null,
      steps: [
        step('invalid-first', [boxOp('visible-id', 'Collision')]),
        step('valid-second', [boxOp('fresh-id', 'Would be valid')]),
      ],
    });
    expect(inspectFirstCompleteStep(text, 'standard', ['visible-id'])).toEqual({ status: 'invalid' });
  });

  it('ignores array-looking text inside header strings when locating steps', () => {
    const validStep = step('first', [boxOp('box-1', 'One box')]);
    const groupLabel = JSON.stringify('literal "steps":[ is text');
    const text = `{"template":null,"groupLabel":${groupLabel},"representation":"diagram","illustration":null,"steps":[${JSON.stringify(validStep)}]}`;
    expect(completeStepsArrayItems(text)).toEqual([JSON.stringify(validStep)]);
    expect(containsCompleteValidStep(text)).toBe(true);
  });

  it('applies density and cross-step id policy before declaring a step ready', () => {
    const first = validatePolicyReadyEvalStep({
      step: step('first', [boxOp('shared-id', 'First')]),
      density: 'minimal',
    });
    expect(() => validatePolicyReadyEvalStep({
      step: step('second', [boxOp('shared-id', 'Duplicate')]),
      density: 'minimal',
      priorOps: first.ops,
    })).toThrow(/collide/i);

    expect(() => validatePolicyReadyEvalStep({
      step: step('dense', Array.from({ length: 15 }, (_, index) => boxOp(`box-${index}`, `${index}`))),
      density: 'minimal',
    })).toThrow(/density budget/i);
  });

  it('strictly parses the full proposal and converts steps to production scene input', () => {
    const raw = {
      template: null,
      groupLabel: 'Two ideas',
      representation: 'diagram',
      illustration: null,
      steps: [
        step('outline', [boxOp('box-1', 'First')]),
        step('relation', [boxOp('box-2', 'Second')], 'relation'),
      ],
    };
    const proposal = parseVNextEvalDirectorProposal(JSON.stringify(raw), 'minimal');
    expect(proposal.ops.map((op) => (op as { id?: string }).id)).toEqual(['box-1', 'box-2']);
    expect(proposal.storyboard).toEqual([
      { id: 'outline', reveal: 'outline', narration: 'Explain outline.', objectIds: ['box-1'] },
      { id: 'relation', reveal: 'relation', narration: 'Explain relation.', objectIds: ['box-2'] },
    ]);
    expect(VNextEvalProposalSchema.safeParse({ ...raw, unexpected: true }).success).toBe(false);
  });

  it('keeps the schema and policy static while placing synthetic intent data last', () => {
    const [first, second] = loadDirectorEvalCorpus();
    const firstMessages = directorEvalMessages(first);
    const secondMessages = directorEvalMessages(second);
    expect(firstMessages[0]).toEqual(secondMessages[0]);
    expect(firstMessages[0].content).toContain('step-structured');
    expect(firstMessages[0].content).toContain('at most 15 operations total');
    expect(firstMessages[0].content).toContain('complete scene for bounds and collisions');
    expect(firstMessages[0].content).not.toContain(first.intent);
    expect(firstMessages[1].content).toContain(first.intent);
    expect(firstMessages[1]).not.toEqual(secondMessages[1]);
  });

  it('streams the strict schema, proves the first step through browser preflight, and retains auditable usage', async () => {
    const intent = loadDirectorEvalCorpus()[0];
    const raw = JSON.stringify({
      template: null,
      groupLabel: 'One idea',
      representation: 'diagram',
      illustration: null,
      steps: [step('outline', [boxOp('box-1', 'First')])],
    });
    let split = raw.indexOf(']}') + 2;
    if (split < 2) split = raw.length;
    let capturedRequest: unknown;
    const create = vi.fn(async (request: unknown) => {
      capturedRequest = request;
      return streamChunks([
      { text: raw.slice(0, split) },
      { text: raw.slice(split), finishReason: 'stop' },
      { usage: { prompt_tokens: 1_000, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 700, cache_write_tokens: 200 } } },
      ]);
    });
    const validateFirstStep = vi.fn(async () => true);
    const onFirstValidStep = vi.fn();
    const result = await runStreamingProbe({
      client: { chat: { completions: { create } } } as never,
      intent,
      model: 'gpt-5.6-terra',
      reasoningEffort: 'low',
      cacheState: 'warm',
      trialKey: 'trial-1',
      currentBoardRaster: 'data:image/jpeg;base64,Ym9hcmQ=',
      validateFirstStep,
      onFirstValidStep,
    });

    expect(capturedRequest).toMatchObject({
      response_format: { type: 'json_schema', json_schema: { strict: true } },
      max_completion_tokens: 4_000,
      verbosity: 'low',
      messages: [
        { role: 'system' },
        { role: 'user', content: expect.arrayContaining([
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,Ym9hcmQ=', detail: 'high' } },
        ]) },
      ],
    });
    expect(validateFirstStep).toHaveBeenCalledTimes(1);
    expect(onFirstValidStep).toHaveBeenCalledTimes(1);
    expect(result.usage).toEqual({
      inputTokens: 1_000,
      cachedInputTokens: 700,
      cacheWriteTokens: 200,
      outputTokens: 120,
    });
    expect(result.usageComplete).toBe(true);
    expect(result.finishReason).toBe('stop');
    expect(result.maxCompletionTokens).toBe(4_000);
    expect(result.firstStepStatus).toBe('valid');
    expect(result.costUpperBoundUsd).toBe(result.estimatedCostUsd);
  });

  it('charges the full reservation when an aborted stream has no final usage', async () => {
    const controller = new AbortController();
    controller.abort('hedge lost');
    const result = await runStreamingProbe({
      client: { chat: { completions: { create: async () => { throw new Error('aborted'); } } } } as never,
      intent: loadDirectorEvalCorpus()[0],
      model: 'gpt-5.6-terra',
      reasoningEffort: 'low',
      cacheState: 'cold',
      trialKey: 'aborted-leg',
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(result.usageComplete).toBe(false);
    expect(result.firstStepStatus).toBe('missing');
    expect(result.costUpperBoundUsd).toBe(compositionCallReserveUsd('gpt-5.6-terra'));
  });

  it('uses a unique static nonce for cold probes and keeps warm prefixes identical', () => {
    const intent = loadDirectorEvalCorpus()[0];
    const coldA = directorEvalMessages(intent, { cacheState: 'cold', trialKey: 'a' });
    const coldB = directorEvalMessages(intent, { cacheState: 'cold', trialKey: 'b' });
    const warmA = directorEvalMessages(intent, { cacheState: 'warm', trialKey: 'a' });
    const warmB = directorEvalMessages(intent, { cacheState: 'warm', trialKey: 'b' });
    expect(coldA[0]).not.toEqual(coldB[0]);
    expect(warmA[0]).toEqual(warmB[0]);
  });
});

async function* streamChunks(chunks: Array<{
  text?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details: { cached_tokens: number; cache_write_tokens: number } };
  finishReason?: 'stop' | 'length';
}>) {
  for (const chunk of chunks) {
    yield {
      choices: chunk.text === undefined && chunk.finishReason === undefined
        ? []
        : [{ delta: { content: chunk.text ?? '' }, finish_reason: chunk.finishReason ?? null }],
      usage: chunk.usage ?? null,
    };
  }
}

function boxOp(id: string, text: string): Record<string, unknown> {
  return {
    op: 'add',
    id,
    color: null,
    spec: { kind: 'box', at: [500, 300], w: null, h: null, text },
  };
}

function step(id: string, ops: unknown[], reveal: 'outline' | 'relation' = 'outline') {
  return { id, reveal, narration: `Explain ${id}.`, ops };
}

function expectAllObjectsClosed(schema: JsonSchema): void {
  if (schema.type === 'object') expect(schema.additionalProperties).toBe(false);
  const properties = schema.properties as Record<string, JsonSchema> | undefined;
  for (const child of Object.values(properties ?? {})) expectAllObjectsClosed(child);
  if (schema.items && typeof schema.items === 'object') expectAllObjectsClosed(schema.items as JsonSchema);
  if (Array.isArray(schema.anyOf)) {
    for (const child of schema.anyOf) expectAllObjectsClosed(child as JsonSchema);
  }
}
