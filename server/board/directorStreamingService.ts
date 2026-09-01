import type OpenAI from 'openai';
import type { DirectorMessage, DirectorSceneRequest } from './director.js';
import {
  DIRECTOR_STREAM_RESPONSE_FORMAT,
  DIRECTOR_STREAM_STATIC_PROMPT,
} from './directorStreamSchema.js';

export interface DirectorStreamModelPort {
  streamProposal(input: {
    request: DirectorSceneRequest;
    boardImage: string | null;
    signal: AbortSignal;
  }): AsyncIterable<string>;
}

export interface OpenAIDirectorStreamOptions {
  client: OpenAI;
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high';
  maxCompletionTokens: number;
}

export function createOpenAIDirectorStreamPort(
  options: OpenAIDirectorStreamOptions,
): DirectorStreamModelPort {
  return {
    async *streamProposal(input) {
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
      }
      if (input.signal.aborted) throw abortError();
    },
  };
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

function abortError(): Error {
  const error = new Error('Director stream aborted by visual request epoch.');
  error.name = 'AbortError';
  return error;
}
