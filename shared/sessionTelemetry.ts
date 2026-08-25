import { z } from 'zod';

export const TELEMETRY_SCHEMA_VERSION = '1.0.0' as const;

const finiteInt = z.number().finite().int();
const nonNegativeInt = finiteInt.nonnegative();
const boundedId = z.string().min(1).max(160);

const schemaVersion = z.literal(TELEMETRY_SCHEMA_VERSION);

const durationValue = nonNegativeInt;
const boardDurationValue = finiteInt;

const durationMetricBase = {
  schemaVersion,
  unit: z.literal('ms'),
};

const countMetricBase = {
  schemaVersion,
  unit: z.literal('count'),
  value: z.literal(1),
};

const BargeInGateOutcomeSchema = z.enum([
  'local_only_rejected',
  'provider_only_rejected',
  'confirmed',
]);

const BargeInCancelOutcomeSchema = z.enum([
  'provider_cancelled',
  'provider_completed',
  'provider_failed',
]);

const SectionNavigationCauseSchema = z.enum([
  'initial_anchor',
  'notice_open',
  'picker',
  'draft_restore',
]);

const TutorObjectDisappearanceCauseSchema = z.enum(['scene_mutation', 'unknown']);

const ProviderUsageDimensionsSchema = z.object({
  totalTokens: nonNegativeInt,
  inputTextTokens: nonNegativeInt,
  inputAudioTokens: nonNegativeInt,
  inputImageTokens: nonNegativeInt,
  cachedTextTokens: nonNegativeInt,
  cachedAudioTokens: nonNegativeInt,
  cachedImageTokens: nonNegativeInt,
  outputTextTokens: nonNegativeInt,
  outputAudioTokens: nonNegativeInt,
});

export const MetricInputSchema = z.discriminatedUnion('name', [
  z.object({
    ...durationMetricBase,
    name: z.literal('speech_end_to_response_started'),
    value: durationValue,
  }),
  z.object({
    ...durationMetricBase,
    name: z.literal('speech_end_to_first_audio'),
    value: durationValue,
  }),
  z.object({
    ...durationMetricBase,
    name: z.literal('ask_to_first_audio'),
    value: durationValue,
  }),
  z.object({
    ...durationMetricBase,
    name: z.literal('board_reveal_to_narration'),
    value: boardDurationValue,
    visualCueId: boundedId.optional(),
    semanticObjectId: boundedId.optional(),
  }),
  z.object({
    ...durationMetricBase,
    name: z.literal('tutor_audio_output_duration'),
    value: durationValue,
  }),
  z.object({
    ...countMetricBase,
    name: z.literal('barge_in_gate_outcome'),
    dimensions: z.object({ outcome: BargeInGateOutcomeSchema }),
  }),
  z.object({
    ...countMetricBase,
    name: z.literal('barge_in_cancel_outcome'),
    dimensions: z.object({ outcome: BargeInCancelOutcomeSchema }),
  }),
  z.object({
    ...countMetricBase,
    name: z.literal('section_navigation'),
    dimensions: z.object({
      previousSemanticGroupId: boundedId,
      nextSemanticGroupId: boundedId,
      cause: SectionNavigationCauseSchema,
    }),
  }),
  z.object({
    ...countMetricBase,
    name: z.literal('session_reconnect'),
  }),
  z.object({
    ...countMetricBase,
    name: z.literal('tutor_object_disappearance'),
    dimensions: z.object({
      objectId: boundedId,
      cause: TutorObjectDisappearanceCauseSchema,
    }),
  }),
  z.object({
    schemaVersion,
    name: z.literal('provider_usage'),
    unit: z.literal('count'),
    value: nonNegativeInt,
    dimensions: ProviderUsageDimensionsSchema,
  }).superRefine((metric, context) => {
    if (metric.value !== metric.dimensions.totalTokens) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'provider_usage value must equal totalTokens',
      });
    }
  }),
]);

export type MetricInput = z.infer<typeof MetricInputSchema>;

export type MetricContext = {
  connectionEpoch: number;
  turnId: string;
  generationId: string;
  providerResponseId?: string;
};

const metricContextFields = {
  connectionEpoch: nonNegativeInt,
  turnId: boundedId,
  generationId: boundedId,
  providerResponseId: boundedId.optional(),
};

const legacyObservationSchema = z.object({
  name: z.enum([
    'speech_end_to_response_started',
    'speech_end_to_first_audio',
    'ask_to_first_audio',
  ]),
  unit: z.literal('ms'),
  value: durationValue,
  legacy: z.literal(true),
});

export const MetricObservationSchema = z.union([
  MetricInputSchema.and(z.object(metricContextFields)),
  legacyObservationSchema,
]);

export type MetricObservation = z.infer<typeof MetricObservationSchema>;

export type NormalizedMetric = MetricObservation;

const historicalDurationSchema = z.object({
  name: z.enum([
    'speech_end_to_response_started',
    'speech_end_to_first_audio',
    'ask_to_first_audio',
  ]),
  ms: durationValue,
});

export function attachMetricContext(
  input: MetricInput,
  context: MetricContext,
): MetricObservation {
  return MetricObservationSchema.parse({ ...input, ...context });
}

export function normalizeStoredMetric(payload: unknown): NormalizedMetric | null {
  const observation = MetricObservationSchema.safeParse(payload);
  if (observation.success) {
    return observation.data;
  }

  const historical = historicalDurationSchema.safeParse(payload);
  if (historical.success) {
    return {
      name: historical.data.name,
      unit: 'ms',
      value: historical.data.ms,
      legacy: true,
    };
  }

  return null;
}

export type DurationAggregate = {
  count: number;
  min: number;
  max: number;
  mean: number;
  latest: number;
};

export type BargeInOutcomeCounts = {
  localOnlyRejected: number;
  providerOnlyRejected: number;
  confirmed: number;
  providerCancelled: number;
  providerCompleted: number;
  providerFailed: number;
  unresolved: number;
};

export type ProviderUsageTotals = {
  totalTokens: number;
  inputTextTokens: number;
  inputAudioTokens: number;
  inputImageTokens: number;
  cachedTextTokens: number;
  cachedAudioTokens: number;
  cachedImageTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
};

export type SessionMetricEntry = {
  eventId: number;
  ts: number;
  name: MetricInput['name'];
  unit: 'ms' | 'count';
  value: number;
  connectionEpoch?: number;
  turnId?: string;
  generationId?: string;
  providerResponseId?: string;
  visualCueId?: string;
  semanticObjectId?: string;
  dimensions?: Record<string, string | number>;
  legacy?: true;
};

export type SessionTelemetryLog = {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  sessionId: string;
  truncated: boolean;
  summary: {
    durations: Partial<Record<MetricInput['name'], DurationAggregate>>;
    bargeIn: BargeInOutcomeCounts;
    sectionSwitchCount: number;
    reconnectCount: number;
    tutorObjectDisappearanceCount: number;
    providerUsage: ProviderUsageTotals;
  };
  timeline: SessionMetricEntry[];
};

export const DURATION_METRIC_NAMES = [
  'speech_end_to_response_started',
  'speech_end_to_first_audio',
  'ask_to_first_audio',
  'board_reveal_to_narration',
  'tutor_audio_output_duration',
] as const;

export type DurationMetricName = (typeof DURATION_METRIC_NAMES)[number];

export function isDurationMetricName(name: string): name is DurationMetricName {
  return (DURATION_METRIC_NAMES as readonly string[]).includes(name);
}
