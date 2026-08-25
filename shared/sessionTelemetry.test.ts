import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  MetricInputSchema,
  attachMetricContext,
  normalizeStoredMetric,
  type DurationAggregate,
  type DurationMetricName,
  type SessionTelemetryLog,
} from './sessionTelemetry';

const context = {
  connectionEpoch: 2,
  turnId: 'turn-3',
  generationId: 'generation-4',
  providerResponseId: 'resp-1',
};

describe('session telemetry contract', () => {
  it('accepts signed board timing and attaches server-owned identity', () => {
    const input = MetricInputSchema.parse({
      schemaVersion: '1.0.0',
      name: 'board_reveal_to_narration',
      unit: 'ms',
      value: -820,
      visualCueId: 'cue-1',
      semanticObjectId: 'anchor-1',
    });
    expect(attachMetricContext(input, context)).toMatchObject({
      value: -820,
      connectionEpoch: 2,
      providerResponseId: 'resp-1',
    });
  });

  it('rejects unknown names, free-form outcomes, and non-finite values', () => {
    expect(MetricInputSchema.safeParse({ schemaVersion: '1.0.0', name: 'child_text', unit: 'count', value: 1 }).success).toBe(false);
    expect(MetricInputSchema.safeParse({
      schemaVersion: '1.0.0',
      name: 'barge_in_gate_outcome',
      unit: 'count',
      value: 1,
      dimensions: { outcome: 'arbitrary text' },
    }).success).toBe(false);
    expect(MetricInputSchema.safeParse({
      schemaVersion: '1.0.0',
      name: 'speech_end_to_first_audio',
      unit: 'ms',
      value: Number.POSITIVE_INFINITY,
    }).success).toBe(false);
  });

  it('rejects negative non-board durations and fractional typed observations', () => {
    const nonBoardDurationNames = [
      'speech_end_to_response_started',
      'speech_end_to_first_audio',
      'ask_to_first_audio',
      'tutor_audio_output_duration',
    ] as const;

    for (const name of nonBoardDurationNames) {
      expect(MetricInputSchema.safeParse({
        schemaVersion: '1.0.0',
        name,
        unit: 'ms',
        value: -1,
      }).success).toBe(false);
    }

    expect(MetricInputSchema.safeParse({
      schemaVersion: '1.0.0',
      name: 'ask_to_first_audio',
      unit: 'ms',
      value: 420.6,
    }).success).toBe(false);
  });

  it('rejects provider usage when value differs from totalTokens', () => {
    expect(MetricInputSchema.safeParse({
      schemaVersion: '1.0.0',
      name: 'provider_usage',
      unit: 'count',
      value: 9,
      dimensions: {
        totalTokens: 10,
        inputTextTokens: 4,
        inputAudioTokens: 1,
        inputImageTokens: 0,
        cachedTextTokens: 1,
        cachedAudioTokens: 0,
        cachedImageTokens: 0,
        outputTextTokens: 3,
        outputAudioTokens: 2,
      },
    }).success).toBe(false);
  });

  it('accepts every bounded lifecycle enum branch', () => {
    for (const outcome of ['local_only_rejected', 'provider_only_rejected', 'confirmed'] as const) {
      expect(MetricInputSchema.safeParse({
        schemaVersion: '1.0.0',
        name: 'barge_in_gate_outcome',
        unit: 'count',
        value: 1,
        dimensions: { outcome },
      }).success).toBe(true);
    }

    for (const outcome of ['provider_cancelled', 'provider_completed', 'provider_failed'] as const) {
      expect(MetricInputSchema.safeParse({
        schemaVersion: '1.0.0',
        name: 'barge_in_cancel_outcome',
        unit: 'count',
        value: 1,
        dimensions: { outcome },
      }).success).toBe(true);
    }

    for (const cause of ['initial_anchor', 'notice_open', 'picker', 'draft_restore'] as const) {
      expect(MetricInputSchema.safeParse({
        schemaVersion: '1.0.0',
        name: 'section_navigation',
        unit: 'count',
        value: 1,
        dimensions: {
          previousSemanticGroupId: 'group-a',
          nextSemanticGroupId: 'group-b',
          cause,
        },
      }).success).toBe(true);
    }

    for (const cause of ['scene_mutation', 'unknown'] as const) {
      expect(MetricInputSchema.safeParse({
        schemaVersion: '1.0.0',
        name: 'tutor_object_disappearance',
        unit: 'count',
        value: 1,
        dimensions: { objectId: 'object-a', cause },
      }).success).toBe(true);
    }

    for (const reason of [
      'server_queue_overflow',
      'server_persistence_failure',
      'client_queue_overflow',
    ] as const) {
      expect(MetricInputSchema.safeParse({
        schemaVersion: '1.0.0',
        name: 'telemetry_gap',
        unit: 'count',
        value: 3,
        dimensions: { reason },
      }).success).toBe(true);
    }
  });

  it('rejects values outside every bounded lifecycle enum', () => {
    const invalidMetrics = [
      {
        schemaVersion: '1.0.0',
        name: 'barge_in_gate_outcome',
        unit: 'count',
        value: 1,
        dimensions: { outcome: 'ignored' },
      },
      {
        schemaVersion: '1.0.0',
        name: 'barge_in_cancel_outcome',
        unit: 'count',
        value: 1,
        dimensions: { outcome: 'timed_out' },
      },
      {
        schemaVersion: '1.0.0',
        name: 'section_navigation',
        unit: 'count',
        value: 1,
        dimensions: {
          previousSemanticGroupId: 'group-a',
          nextSemanticGroupId: 'group-b',
          cause: 'automatic',
        },
      },
      {
        schemaVersion: '1.0.0',
        name: 'tutor_object_disappearance',
        unit: 'count',
        value: 1,
        dimensions: { objectId: 'object-a', cause: 'timeout' },
      },
      {
        schemaVersion: '1.0.0',
        name: 'telemetry_gap',
        unit: 'count',
        value: 0,
        dimensions: { reason: 'server_queue_overflow' },
      },
      {
        schemaVersion: '1.0.0',
        name: 'telemetry_gap',
        unit: 'count',
        value: 1,
        dimensions: { reason: 'arbitrary_loss' },
      },
    ];

    for (const metric of invalidMetrics) {
      expect(MetricInputSchema.safeParse(metric).success).toBe(false);
    }
  });

  it('normalizes historical duration rows without inventing correlation', () => {
    expect(normalizeStoredMetric({ name: 'speech_end_to_first_audio', ms: 420 })).toMatchObject({
      name: 'speech_end_to_first_audio',
      unit: 'ms',
      value: 420,
      legacy: true,
    });
  });

  it('rounds finite non-negative fractional historical milliseconds', () => {
    expect(normalizeStoredMetric({ name: 'ask_to_first_audio', ms: 420.6 })).toEqual({
      name: 'ask_to_first_audio',
      unit: 'ms',
      value: 421,
      legacy: true,
    });
  });

  it('rejects normalized legacy output as a stored metric payload', () => {
    expect(normalizeStoredMetric({
      name: 'speech_end_to_first_audio',
      unit: 'ms',
      value: 420,
      legacy: true,
    })).toBeNull();
  });

  it('types duration summaries with duration metric names only', () => {
    expectTypeOf<SessionTelemetryLog['summary']['durations']>()
      .toEqualTypeOf<Partial<Record<DurationMetricName, DurationAggregate>>>();
  });
});
