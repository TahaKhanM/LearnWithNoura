import type OpenAI from 'openai';
import type { HeadlessSceneValidatorHandle } from '../lesson/headlessSceneValidator.js';
import {
  directVisual,
  type BoardDirector,
  type DirectorChatClient,
  type DirectorMessage,
  type IllustrationDirectorPort,
} from './director.js';
import { createOpenAIDirectorStreamPort } from './directorStreamingService.js';
import { streamVisual, type StreamingBoardDirector } from './streamingDirector.js';
import type { OpenAiTelemetryModel } from '../../shared/sessionTelemetry.js';

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
  /** Optional compiler/offline harness. Live lesson requests override these
   * ports with the connected learner browser's real render pipeline. */
  harness?: HeadlessSceneValidatorHandle | null;
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
    validateScene: options.harness?.validate ?? (async () => ({
      ok: false,
      issues: ['No scene validation authority is connected.'],
    })),
    renderScene: options.harness?.render ?? (async () => null),
    maxCorrectionRounds: options.maxCorrectionRounds,
    illustrations: options.illustrations ?? null,
  }, request);
}

export function createLiveStreamingBoardDirector(
  options: LiveBoardDirectorOptions & { maxCompletionTokens?: number },
): StreamingBoardDirector {
  const maxCompletionTokens = options.maxCompletionTokens ??
    (options.model.includes('luna') ? 5_000 : 4_000);
  const port = (reasoningEffort: 'low' | 'medium' | 'high') => createOpenAIDirectorStreamPort({
    client: options.client,
    model: options.model,
    reasoningEffort,
    maxCompletionTokens,
  });
  const primary = port(options.reasoningEffort);
  const escalated = options.reasoningEffort === 'low' ? port('medium') : null;
  const telemetryModel = openAiTelemetryModel(options.model);
  const validateScene = options.harness?.validate ?? (async () => ({
    ok: false as const,
    issues: ['No scene validation authority is connected.'],
  }));
  const renderScene = options.harness?.render ?? (async () => null);
  return async (request, runtime) => {
    let deliveredSteps = 0;
    const guardedRuntime = {
      ...runtime,
      onStep: async (step: Parameters<typeof runtime.onStep>[0]) => {
        await runtime.onStep(step);
        deliveredSteps += 1;
      },
    };
    const run = (
      model: ReturnType<typeof port>,
      reasoningEffort: 'low' | 'medium' | 'high',
    ) => streamVisual({
      model,
      validateScene,
      renderScene,
      ...(telemetryModel ? { composition: { model: telemetryModel, reasoningEffort } } : {}),
    }, request, guardedRuntime);
    const first = await run(primary, options.reasoningEffort);
    if (first.ok || !first.retryable || deliveredSteps > 0 || !escalated) return first;
    return run(escalated, 'medium');
  };
}

function openAiTelemetryModel(model: string): OpenAiTelemetryModel | null {
  return ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].includes(model)
    ? model as OpenAiTelemetryModel
    : null;
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
