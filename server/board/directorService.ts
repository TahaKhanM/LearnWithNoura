import type OpenAI from 'openai';
import type { HeadlessSceneValidatorHandle } from '../lesson/headlessSceneValidator.js';
import {
  directVisual,
  type BoardDirector,
  type DirectorChatClient,
  type DirectorMessage,
  type IllustrationDirectorPort,
} from './director.js';

/**
 * The app-facing face of the Board Director: maps the neutral multimodal
 * message shape onto the existing Chat Completions path (no new provider
 * dependency) and binds the shared headless harness for validation and
 * rendering. Model and effort come from the environment
 * (NOURA_DIRECTOR_MODEL / NOURA_DIRECTOR_REASONING_EFFORT).
 */

export interface LiveBoardDirectorOptions {
  client: OpenAI;
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high';
  harness: HeadlessSceneValidatorHandle;
  maxCorrectionRounds?: number;
  illustrations?: IllustrationDirectorPort | null;
}

export function createLiveBoardDirector(options: LiveBoardDirectorOptions): BoardDirector {
  const chat: DirectorChatClient = {
    complete: async ({ messages }) => {
      const response = await options.client.chat.completions.create({
        model: options.model,
        reasoning_effort: options.reasoningEffort,
        response_format: { type: 'json_object' },
        messages: messages.map(toOpenAiMessage),
      });
      return response.choices[0]?.message?.content ?? null;
    },
  };
  return (request) => directVisual({
    client: chat,
    validateScene: options.harness.validate,
    renderScene: options.harness.render,
    maxCorrectionRounds: options.maxCorrectionRounds,
    illustrations: options.illustrations ?? null,
  }, request);
}

function toOpenAiMessage(message: DirectorMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (message.role === 'system') {
    return {
      role: 'system',
      content: message.content
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('\n'),
    };
  }
  return {
    role: 'user',
    content: message.content.map((part) => part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : { type: 'image_url' as const, image_url: { url: part.dataUrl, detail: 'high' as const } }),
  };
}
