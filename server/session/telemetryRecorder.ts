import { z } from 'zod';
import {
  MetricInputSchema,
  TELEMETRY_SCHEMA_VERSION,
  attachMetricContext,
  type MetricContext,
} from '../../shared/sessionTelemetry.js';
import type { GenerationIdentity } from '../../shared/runtimeProtocol.js';
import type { DomainRepository } from '../store/domain.js';

const providerTokenCount = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const ProviderUsageSchema = z.object({
  total_tokens: providerTokenCount,
  input_token_details: z.object({
    text_tokens: providerTokenCount,
    audio_tokens: providerTokenCount,
    image_tokens: providerTokenCount,
    cached_tokens_details: z.object({
      text_tokens: providerTokenCount,
      audio_tokens: providerTokenCount,
      image_tokens: providerTokenCount,
    }),
  }),
  output_token_details: z.object({
    text_tokens: providerTokenCount,
    audio_tokens: providerTokenCount,
  }),
});

export async function recordMetric(
  repo: DomainRepository,
  sessionId: string,
  input: unknown,
  context: MetricContext,
): Promise<number | null> {
  const parsed = MetricInputSchema.safeParse(input);
  if (!parsed.success) return null;

  let observation;
  try {
    observation = attachMetricContext(parsed.data, context);
  } catch {
    return null;
  }

  return repo.addEvent(sessionId, 'metric', observation);
}

export async function recordProviderUsage(
  repo: DomainRepository,
  sessionId: string,
  usage: unknown,
  context: MetricContext,
): Promise<number | null> {
  const parsed = ProviderUsageSchema.safeParse(usage);
  if (!parsed.success) return null;

  const input = parsed.data.input_token_details;
  const cached = input.cached_tokens_details;
  const output = parsed.data.output_token_details;
  return recordMetric(repo, sessionId, {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    name: 'provider_usage',
    unit: 'count',
    value: parsed.data.total_tokens,
    dimensions: {
      totalTokens: parsed.data.total_tokens,
      inputTextTokens: input.text_tokens,
      inputAudioTokens: input.audio_tokens,
      inputImageTokens: input.image_tokens,
      cachedTextTokens: cached.text_tokens,
      cachedAudioTokens: cached.audio_tokens,
      cachedImageTokens: cached.image_tokens,
      outputTextTokens: output.text_tokens,
      outputAudioTokens: output.audio_tokens,
    },
  }, context);
}

export function metricContextFromIdentity(
  identity: GenerationIdentity,
  providerResponseId?: string,
): MetricContext {
  return {
    connectionEpoch: identity.connectionEpoch,
    turnId: identity.turnId,
    generationId: identity.generationId,
    ...(providerResponseId ? { providerResponseId } : {}),
  };
}
