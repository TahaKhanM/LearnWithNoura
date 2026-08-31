import { z } from 'zod';
import {
  DRAWING_METRIC_SCHEMAS,
} from './drawingTelemetry.js';

export {
  DirectorReasoningEffortSchema,
  DRAWING_METRIC_SCHEMAS,
  OpenAiTelemetryModelSchema,
  VisionAuditOutcomeSchema,
  VisualTelemetryLaneSchema,
} from './drawingTelemetry.js';
export type {
  DirectorReasoningEffort,
  OpenAiTelemetryModel,
  VisionAuditOutcome,
  VisualTelemetryLane,
} from './drawingTelemetry.js';

export const TELEMETRY_SCHEMA_VERSION = '1.0.0' as const;
export const TELEMETRY_ENCODING_VERSION = 'hmac-sha256-v2' as const;

const finiteInt = z.number().finite().int();
const nonNegativeInt = finiteInt.nonnegative();
const boundedId = z.string().min(1).max(160);

const schemaVersion = z.literal(TELEMETRY_SCHEMA_VERSION);

const durationValue = nonNegativeInt;
const boardDurationValue = finiteInt;
const historicalDurationValue = z.number().finite().nonnegative();

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
  'arrow',
  'task_focus',
  'tutor_announce',
]);

const TutorObjectDisappearanceCauseSchema = z.enum(['scene_mutation', 'unknown']);

export const TELEMETRY_GAP_REASONS = [
  'server_queue_overflow',
  'server_persistence_failure',
  'server_history_failure',
  'server_accounting_overflow',
  'client_queue_overflow',
] as const;

const TelemetryGapReasonSchema = z.enum(TELEMETRY_GAP_REASONS);

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
    ...durationMetricBase,
    name: z.literal('illustration_generation'),
    value: durationValue,
    dimensions: z.object({
      cache: z.enum(['hit', 'miss']),
      outcome: z.enum(['accepted', 'failed', 'refused']),
      imageCount: nonNegativeInt,
      totalTokens: nonNegativeInt,
    }),
  }),
  ...DRAWING_METRIC_SCHEMAS,
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
    ...countMetricBase,
    name: z.literal('storyboard_outcome'),
    dimensions: z.object({
      outcome: z.enum(['completed', 'abandoned']),
      source: z.enum(['anchor', 'director']),
      revealedSteps: nonNegativeInt,
      totalSteps: nonNegativeInt,
    }),
  }),
  z.object({
    schemaVersion,
    name: z.literal('telemetry_gap'),
    unit: z.literal('count'),
    value: finiteInt.positive(),
    dimensions: z.object({ reason: TelemetryGapReasonSchema }),
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

const telemetryEncodingSchema = z.object({
  version: z.literal(TELEMETRY_ENCODING_VERSION),
  sessionTag: z.string().regex(/^[A-Za-z0-9_-]{10}$/),
});

const metricContextFields = {
  connectionEpoch: nonNegativeInt,
  turnId: boundedId,
  generationId: boundedId,
  providerResponseId: boundedId.optional(),
  telemetryEncoding: telemetryEncodingSchema.optional(),
};

const LEGACY_DURATION_NAMES = [
  'speech_end_to_response_started',
  'speech_end_to_first_audio',
  'ask_to_first_audio',
] as const;

const LegacyDurationNameSchema = z.enum(LEGACY_DURATION_NAMES);

const legacyObservationSchema = z.object({
  name: LegacyDurationNameSchema,
  unit: z.literal('ms'),
  value: durationValue,
  legacy: z.literal(true),
});

const newMetricObservationSchema = MetricInputSchema.and(z.object(metricContextFields));

export const MetricObservationSchema = z.union([
  newMetricObservationSchema,
  legacyObservationSchema,
]);

export type MetricObservation = z.infer<typeof MetricObservationSchema>;

export type NormalizedMetric = MetricObservation;

const historicalDurationSchema = z.object({
  name: LegacyDurationNameSchema,
  ms: historicalDurationValue,
});

export function attachMetricContext(
  input: MetricInput,
  context: MetricContext,
): MetricObservation {
  return MetricObservationSchema.parse({ ...input, ...context });
}

export function normalizeStoredMetric(payload: unknown): NormalizedMetric | null {
  const storedCandidate = sanitizeStoredEncoding(payload);
  const observation = newMetricObservationSchema.safeParse(storedCandidate);
  if (observation.success) {
    return observation.data;
  }

  const historical = historicalDurationSchema.safeParse(payload);
  if (historical.success) {
    return {
      name: historical.data.name,
      unit: 'ms',
      value: Math.round(historical.data.ms),
      legacy: true,
    };
  }

  return null;
}

function sanitizeStoredEncoding(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const candidate = { ...(payload as Record<string, unknown>) };
  const encoding = telemetryEncodingSchema.safeParse(candidate.telemetryEncoding);
  delete candidate.telemetryEncoding;
  if (encoding.success) candidate.telemetryEncoding = encoding.data;
  return candidate;
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

export type TelemetryGapReason = (typeof TELEMETRY_GAP_REASONS)[number];

export type TelemetryGapTotals = Record<TelemetryGapReason, number>;

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
    durations: Partial<Record<DurationMetricName, DurationAggregate>>;
    bargeIn: BargeInOutcomeCounts;
    sectionSwitchCount: number;
    reconnectCount: number;
    tutorObjectDisappearanceCount: number;
    providerUsage: ProviderUsageTotals;
    telemetryGaps: TelemetryGapTotals;
  };
  timeline: SessionMetricEntry[];
};

export const DURATION_METRIC_NAMES = [
  'speech_end_to_response_started',
  'speech_end_to_first_audio',
  'ask_to_first_audio',
  'board_reveal_to_narration',
  'tutor_audio_output_duration',
  'illustration_generation',
  'visual_first_paint',
  'visual_scene_complete',
  'director_stream_first_op',
  'vision_audit_outcome',
] as const;

export type DurationMetricName = (typeof DURATION_METRIC_NAMES)[number];

export function isDurationMetricName(name: string): name is DurationMetricName {
  return (DURATION_METRIC_NAMES as readonly string[]).includes(name);
}
