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

  it('normalizes historical duration rows without inventing correlation', () => {
    expect(normalizeStoredMetric({ name: 'speech_end_to_first_audio', ms: 420 })).toMatchObject({
      name: 'speech_end_to_first_audio',
      unit: 'ms',
      value: 420,
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
