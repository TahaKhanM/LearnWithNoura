import type OpenAI from 'openai';
import {
  persistIllustrationRecord,
  prepareIllustration,
  type IllustrationHooks,
  type IllustrationPrepareOk,
  type IllustrationPrepareResult,
} from './illustration.js';
import type { IllustrationDirectorPort } from './director.js';
import type {
  IllustrationBrief,
  IllustrationGenerateClient,
  IllustrationStore,
  IllustrationVisionClient,
} from './illustrationTypes.js';

/**
 * Live illustration adapter: gpt-image family via images.generate.
 * The installed openai@7.4 SDK supports stream + partial_images; we use
 * both so the board can show a preparing/partial state without blanking.
 */

export interface LiveIllustrationOptions {
  client: OpenAI;
  imageModel: string;
  visionModel: string;
  visionEffort: 'low' | 'medium' | 'high';
  store: IllustrationStore;
  enabled: boolean;
}

export function createLiveIllustrationService(options: LiveIllustrationOptions): IllustrationDirectorPort {
  const generate: IllustrationGenerateClient = {
    generate: async ({ prompt, model, onPartial }) => {
      const stream = await options.client.images.generate({
        model,
        prompt,
        size: '1536x1024',
        output_format: 'png',
        moderation: 'auto',
        stream: true,
        partial_images: 2,
      });
      let finalB64: string | null = null;
      let totalTokens = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      for await (const event of stream) {
        if (event.type === 'image_generation.partial_image') {
          onPartial?.(`data:image/png;base64,${event.b64_json}`, event.partial_image_index);
          continue;
        }
        if (event.type === 'image_generation.completed') {
          finalB64 = event.b64_json;
          totalTokens = event.usage.total_tokens;
          inputTokens = event.usage.input_tokens;
          outputTokens = event.usage.output_tokens;
        }
      }
      if (!finalB64) return null;
      return {
        bytes: Buffer.from(finalB64, 'base64'),
        mime: 'image/png',
        usage: { totalTokens, inputTokens, outputTokens },
      };
    },
  };

  const vision: IllustrationVisionClient = {
    inspect: async ({ prompt, imageDataUrl }) => {
      const response = await options.client.chat.completions.create({
        model: options.visionModel,
        reasoning_effort: options.visionEffort,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: prompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Inspect the generated illustration.' },
              { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } },
            ],
          },
        ],
      });
      return response.choices[0]?.message?.content ?? null;
    },
  };

  return {
    enabled: options.enabled,
    store: options.store,
    prepare: (brief: IllustrationBrief, hooks?: IllustrationHooks, prepareOptions?: { generationBudgetRemaining?: number }): Promise<IllustrationPrepareResult> =>
      prepareIllustration({
        generate,
        vision,
        store: options.store,
        model: options.imageModel,
        enabled: options.enabled,
        generationBudgetRemaining: prepareOptions?.generationBudgetRemaining,
      }, brief, hooks),
    persist: (result: IllustrationPrepareOk, owner?: { parentId?: string; sessionId?: string }) =>
      persistIllustrationRecord(options.store, result, owner),
  };
}
