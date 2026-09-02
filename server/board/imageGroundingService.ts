import type OpenAI from 'openai';
import { z } from 'zod';
import { validateAnchorRef, type ImageRegionSelector } from '../../shared/boardOps.js';
import type { ImageGroundingProposalPort } from './imageGrounding.js';
import type { OpenAiTelemetryModel } from '../../shared/sessionTelemetry.js';
import type { DirectorStreamUsage } from './directorStreamingService.js';

const FragmentSelectorSchema = z.object({
  type: z.literal('FragmentSelector'), unit: z.literal('percent'),
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  w: z.number().positive().max(1), h: z.number().positive().max(1),
}).strict();
const PointSelectorSchema = z.object({
  type: z.literal('PointSelector'), x: z.number().min(0).max(1), y: z.number().min(0).max(1),
}).strict();
const SvgSelectorSchema = z.object({
  type: z.literal('SvgSelector'),
  points: z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).min(3).max(32),
}).strict();
const ProposalSchema = z.object({
  selector: z.union([FragmentSelectorSchema, PointSelectorSchema, SvgSelectorSchema]),
  confidence: z.number().min(0).max(1),
}).strict();

export const IMAGE_GROUNDING_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    selector: {
      anyOf: [
        {
          type: 'object', additionalProperties: false,
          properties: {
            type: { type: 'string', const: 'FragmentSelector' }, unit: { type: 'string', const: 'percent' },
            x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 },
            w: { type: 'number', exclusiveMinimum: 0, maximum: 1 }, h: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
          },
          required: ['type', 'unit', 'x', 'y', 'w', 'h'],
        },
        {
          type: 'object', additionalProperties: false,
          properties: {
            type: { type: 'string', const: 'PointSelector' },
            x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['type', 'x', 'y'],
        },
        {
          type: 'object', additionalProperties: false,
          properties: {
            type: { type: 'string', const: 'SvgSelector' },
            points: {
              type: 'array', minItems: 3, maxItems: 32,
              items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0, maximum: 1 } },
            },
          },
          required: ['type', 'points'],
        },
      ],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['selector', 'confidence'],
} as const;

const STATIC_PROMPT = [
  'Ground one requested target inside the supplied synthetic educational board image.',
  'Return one normalized W3C-style selector and confidence. Coordinates are fractions from 0 to 1 within the named image object.',
  'Use a rectangle for an area, a point for a tiny landmark, or a polygon only when a rectangle would be misleading.',
  'Do not infer learner identity or include prose. Return strict JSON only.',
].join('\n');

export function createOpenAIImageGroundingProposalPort(options: {
  client: OpenAI;
  model: OpenAiTelemetryModel;
  reasoningEffort: 'low' | 'medium' | 'high';
  onUsage?: (usage: DirectorStreamUsage) => void;
}): ImageGroundingProposalPort {
  return {
    async propose(input, runtime) {
      const response = await options.client.chat.completions.create({
        model: options.model,
        reasoning_effort: options.reasoningEffort,
        max_completion_tokens: 500,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'noura_image_grounding', strict: true, schema: IMAGE_GROUNDING_JSON_SCHEMA },
        },
        prompt_cache_key: `noura-image-grounding:${options.model}:${options.reasoningEffort}`,
        messages: imageGroundingMessages(input),
      }, { signal: runtime.signal });
      if (response.usage) options.onUsage?.({
        inputTokens: response.usage.prompt_tokens,
        cachedInputTokens: response.usage.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: response.usage.prompt_tokens_details?.cache_write_tokens ?? 0,
        outputTokens: response.usage.completion_tokens,
      });
      const text = response.choices[0]?.message?.content ?? '';
      let decoded: unknown;
      try { decoded = JSON.parse(text); } catch { return null; }
      const parsed = ProposalSchema.safeParse(decoded);
      if (!parsed.success) return null;
      const ref = validateAnchorRef({ type: 'image_region', imageId: input.imageId, selector: parsed.data.selector });
      if (!ref || ref.type !== 'image_region') return null;
      return { selector: ref.selector as ImageRegionSelector, confidence: parsed.data.confidence };
    },
  };
}

export function imageGroundingMessages(input: {
  imageId: string;
  hint: string;
  boardImage: string;
}): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [
    { role: 'system', content: STATIC_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Image object id: ${input.imageId}\nTarget hint: ${input.hint}` },
        { type: 'image_url', image_url: { url: input.boardImage, detail: 'high' } },
      ],
    },
  ];
}
