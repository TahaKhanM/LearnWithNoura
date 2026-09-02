import type OpenAI from 'openai';
import type { M2SmokeAccounting } from './m2SmokeBudget.js';
import { z } from 'zod';
import type { OpenAiTelemetryModel } from '../../shared/sessionTelemetry.js';
import type { DirectorStreamUsage } from './directorStreamingService.js';
import type { VisionAuditInput, VisionAuditPort } from './visionAudit.js';

export const VisionAuditVerdictSchema = z.object({
  approved: z.boolean(),
  issues: z.array(z.string().min(1).max(300)).max(8),
}).strict();

export const VISION_AUDIT_VERDICT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    approved: { type: 'boolean' },
    issues: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 300 } },
  },
  required: ['approved', 'issues'],
} as const;

export const VISION_AUDIT_EVAL_STATIC_PROMPT =
  'Audit a synthetic educational board raster against its stated intent. Reject semantic mismatches including wrong shading, incorrect values, and reversed arrows. Approve a semantically correct raster. Return JSON only. Deterministic geometry checks have already passed.';

export const VISION_AUDIT_INCREMENTAL_STATIC_PROMPT = [
  'Audit an educational board raster against its stated teaching intent.',
  'The raster is the first incremental reveal, not necessarily the whole final scene. Do not reject merely because later reveal steps are absent.',
  'Reject only contradictions that are visible now, such as wrong shading, incorrect visible values, reversed visible arrows, or misleading visible labels.',
  'Approve a semantically correct raster. Deterministic geometry and layout checks have already passed and remain the hard authority.',
  'Return only the strict JSON verdict.',
].join('\n');

export function createVisionAuditForPipeline<T>(
  pipeline: 'classic' | 'streaming',
  create: () => T,
): T | null {
  return pipeline === 'streaming' ? create() : null;
}

export function createOpenAIVisionAuditPort(options: {
  client: OpenAI;
  model: OpenAiTelemetryModel;
  reasoningEffort: 'low' | 'medium' | 'high';
  smokeAccounting?: M2SmokeAccounting;
  onUsage?: (usage: DirectorStreamUsage) => void;
}): VisionAuditPort {
  return {
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    async inspect(input, runtime) {
      const callId = options.smokeAccounting?.begin('vision_audit', options.model, options.reasoningEffort);
      try {
        const response = await options.client.chat.completions.create({
          model: options.model,
          reasoning_effort: options.reasoningEffort,
          max_completion_tokens: 500,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'noura_vision_audit', strict: true, schema: VISION_AUDIT_VERDICT_JSON_SCHEMA },
          },
          prompt_cache_key: `noura-vision-audit:${options.model}:${options.reasoningEffort}`,
          messages: visionAuditMessages(input),
        }, { signal: runtime.signal });
        if (response.usage) {
          const usage = {
            inputTokens: response.usage.prompt_tokens,
            cachedInputTokens: response.usage.prompt_tokens_details?.cached_tokens ?? 0,
            cacheWriteTokens: response.usage.prompt_tokens_details?.cache_write_tokens ?? 0,
            outputTokens: response.usage.completion_tokens,
          };
          if (callId) options.smokeAccounting?.recordUsage(callId, usage);
          options.onUsage?.(usage);
        } else if (callId) {
          options.smokeAccounting?.markCompleted(callId);
        }
        const text = response.choices[0]?.message?.content ?? '';
        let decoded: unknown;
        try { decoded = JSON.parse(text); }
        catch { return { outcome: 'invalid', issues: ['Vision audit returned malformed JSON.'] }; }
        const parsed = VisionAuditVerdictSchema.safeParse(decoded);
        if (!parsed.success) return { outcome: 'invalid', issues: ['Vision audit violated its strict verdict schema.'] };
        if (parsed.data.approved && parsed.data.issues.length > 0) {
          return { outcome: 'invalid', issues: ['Vision audit returned a contradictory approval.'] };
        }
        return parsed.data.approved
          ? { outcome: 'approved', issues: parsed.data.issues }
          : { outcome: 'rejected', issues: parsed.data.issues.length > 0 ? parsed.data.issues : ['Vision audit rejected without a reason.'] };
      } catch (error) {
        if (callId) options.smokeAccounting?.markFailed(callId);
        throw error;
      }
    },
  };
}

export function visionAuditMessages(input: VisionAuditInput): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [
    { role: 'system', content: VISION_AUDIT_INCREMENTAL_STATIC_PROMPT },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            `Purpose: ${input.purpose}`,
            `Idea: ${input.idea}`,
            `Constraints: ${input.constraints ?? 'none'}`,
          ].join('\n'),
        },
        { type: 'image_url', image_url: { url: input.candidateImage, detail: 'high' } },
      ],
    },
  ];
}
