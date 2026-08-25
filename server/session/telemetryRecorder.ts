import { z } from 'zod';
import {
  MetricInputSchema,
  TELEMETRY_SCHEMA_VERSION,
  attachMetricContext,
  type MetricContext,
  type MetricObservation,
} from '../../shared/sessionTelemetry.js';
import type { GenerationIdentity } from '../../shared/runtimeProtocol.js';
import { encodeMetricObservation } from './telemetryPrivacy.js';

type PreparedMetricObservation = Exclude<MetricObservation, { legacy: true }>;

const providerTokenCount = z.number().finite().int().nonnegative();

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

export function prepareMetric(
  sessionId: string,
  input: unknown,
  context: MetricContext,
): PreparedMetricObservation | null {
  const parsed = MetricInputSchema.safeParse(input);
  if (!parsed.success) return null;

  try {
    const observation = encodeMetricObservation(
      sessionId,
      attachMetricContext(parsed.data, context),
    );
    return 'legacy' in observation ? null : observation;
  } catch {
    return null;
  }
}

export function prepareProviderUsage(
  sessionId: string,
  usage: unknown,
  context: MetricContext,
): PreparedMetricObservation | null {
  const parsed = ProviderUsageSchema.safeParse(usage);
  if (!parsed.success) return null;

  const input = parsed.data.input_token_details;
  const cached = input.cached_tokens_details;
  const output = parsed.data.output_token_details;
  return prepareMetric(sessionId, {
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
