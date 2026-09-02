import type OpenAI from 'openai';
import type { M2SmokeAccounting } from './m2SmokeBudget.js';
import type { DirectorMessage, DirectorSceneRequest } from './director.js';
import {
  LAYOUT_CORRECTION_RESPONSE_FORMAT,
  type LayoutCorrectionPort,
  type LayoutCorrectionRequest,
} from './layoutCorrection.js';
import {
  DIRECTOR_STREAM_RESPONSE_FORMAT,
  DIRECTOR_STREAM_STATIC_PROMPT,
} from './directorStreamSchema.js';

export interface SceneModelPort {
  streamPropose(input: {
    request: DirectorSceneRequest;
    boardImage: string | null;
    signal: AbortSignal;
  }): AsyncIterable<string>;
}

export interface DirectorStreamUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface OpenAIDirectorStreamOptions {
  client: OpenAI;
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high';
  maxCompletionTokens: number;
  onUsage?: (usage: DirectorStreamUsage) => void;
  smokeAccounting?: M2SmokeAccounting;
  smokeRole?: 'composition' | 'recovery' | 'layout_correction';
}

export function createOpenAISceneModelPort(
  options: OpenAIDirectorStreamOptions,
): SceneModelPort {
  return {
    async *streamPropose(input) {
      const callId = options.smokeAccounting?.begin(
        options.smokeRole ?? 'composition',
        options.model,
        options.reasoningEffort,
      );
      try {
        const stream = await options.client.chat.completions.create({
          model: options.model,
          reasoning_effort: options.reasoningEffort,
          verbosity: 'low',
          stream: true,
          stream_options: { include_usage: true },
          max_completion_tokens: options.maxCompletionTokens,
          response_format: DIRECTOR_STREAM_RESPONSE_FORMAT,
          prompt_cache_key: `noura-director-stream:${options.model}:${options.reasoningEffort}`,
          messages: directorStreamMessages(input.request, input.boardImage).map(toOpenAiMessage),
        }, { signal: input.signal });
        for await (const chunk of stream) {
          if (input.signal.aborted) throw abortError();
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) yield delta;
          if (chunk.usage) {
            const usage = streamUsage(chunk.usage);
            options.onUsage?.(usage);
            if (callId) options.smokeAccounting?.recordUsage(callId, usage);
          }
        }
        if (input.signal.aborted) throw abortError();
        if (callId) options.smokeAccounting?.markCompleted(callId);
      } catch (error) {
        if (callId) options.smokeAccounting?.markFailed(callId);
        throw error;
      }
    },
  };
}

const LAYOUT_CORRECTION_STATIC_PROMPT = [
  'Correct placement only for the rejected operations in an educational board scene.',
  'Return strict JSON translation patches. Keep every id, shape, value, label, equation, color, and relationship unchanged.',
  'Use only ids implicated by the closed layout issues. dx and dy translate code-owned geometry; side may change only an anchored label side.',
  'Resolve every supplied bounds, collision, stroke_collision, connector_crossing, or reserved issue while keeping objects inside a 1000 by 600 board.',
].join('\n');

export function createOpenAIDirectorLayoutCorrectionPort(
  options: OpenAIDirectorStreamOptions,
): LayoutCorrectionPort {
  return {
    async *streamPlacements(input) {
      const callId = options.smokeAccounting?.begin(
        options.smokeRole ?? 'layout_correction',
        options.model,
        options.reasoningEffort,
      );
      try {
        const stream = await options.client.chat.completions.create({
          model: options.model,
          reasoning_effort: options.reasoningEffort,
          verbosity: 'low',
          stream: true,
          stream_options: { include_usage: true },
          max_completion_tokens: options.maxCompletionTokens,
          response_format: LAYOUT_CORRECTION_RESPONSE_FORMAT,
          prompt_cache_key: `noura-director-layout-correction:${options.model}:${options.reasoningEffort}`,
          messages: layoutCorrectionMessages(input).map(toOpenAiMessage),
        }, { signal: input.signal });
        for await (const chunk of stream) {
          if (input.signal.aborted) throw abortError();
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) yield delta;
          if (chunk.usage) {
            const usage = streamUsage(chunk.usage);
            options.onUsage?.(usage);
            if (callId) options.smokeAccounting?.recordUsage(callId, usage);
          }
        }
        if (input.signal.aborted) throw abortError();
        if (callId) options.smokeAccounting?.markCompleted(callId);
      } catch (error) {
        if (callId) options.smokeAccounting?.markFailed(callId);
        throw error;
      }
    },
  };
}

export function layoutCorrectionMessages(input: LayoutCorrectionRequest): DirectorMessage[] {
  const payload = {
    intent: {
      purpose: input.request.purpose,
      idea: input.request.idea,
      constraints: input.request.constraints,
      sectionId: input.request.sectionId,
    },
    priorAcceptedOps: input.priorOps,
    rejectedStepOps: input.rejectedOps,
    layoutIssues: input.layoutIssues,
  };
  return [
    { role: 'system', content: [{ type: 'text', text: LAYOUT_CORRECTION_STATIC_PROMPT }] },
    { role: 'user', content: [{ type: 'text', text: JSON.stringify(payload) }] },
  ];
}

export function directorStreamMessages(
  request: DirectorSceneRequest,
  boardImage: string | null,
): DirectorMessage[] {
  const dynamic = [
    'No learner identity or transcript is included.',
    `Purpose: ${request.purpose}`,
    `Idea: ${request.idea}`,
    `Constraints: ${request.constraints ?? 'none'}`,
    `Density: ${request.density}`,
    `Section id: ${request.sectionId}`,
    `Section label: ${request.sectionLabel}`,
    `Visible object ids: ${request.visibleObjectIds.join(', ') || 'none'}`,
    `Current board summary: ${request.boardSummary}`,
    `Stage brief: ${request.stageBrief}`,
    'Reply with the requested JSON object only.',
  ].join('\n');
  return [
    { role: 'system', content: [{ type: 'text', text: DIRECTOR_STREAM_STATIC_PROMPT }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: dynamic },
        ...(boardImage ? [{ type: 'image' as const, dataUrl: boardImage }] : []),
      ],
    },
  ];
}

function toOpenAiMessage(message: DirectorMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (message.role === 'system') {
    return {
      role: 'system',
      content: message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n'),
    };
  }
  return {
    role: 'user',
    content: message.content.map((part) => part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : { type: 'image_url' as const, image_url: { url: part.dataUrl, detail: 'high' as const } }),
  };
}

function streamUsage(usage: {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
}): DirectorStreamUsage {
  return {
    inputTokens: usage.prompt_tokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: usage.prompt_tokens_details?.cache_write_tokens ?? 0,
    outputTokens: usage.completion_tokens,
  };
}

function abortError(): Error {
  const error = new Error('Director stream aborted by visual request epoch.');
  error.name = 'AbortError';
  return error;
}
