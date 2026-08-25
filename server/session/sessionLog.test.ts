import { describe, expect, it } from 'vitest';
import type { EventRow } from '../store/repo.js';
import type { MetricInput } from '../../shared/sessionTelemetry.js';
import { buildSessionTelemetryLog } from './sessionLog.js';
import { prepareMetric } from './telemetryRecorder.js';

const identity = {
  connectionEpoch: 2,
  turnId: 'turn-3',
  generationId: 'generation-4',
};

function metricEvent(
  id: number,
  payload: MetricInput,
  options: {
    released?: boolean;
    sessionId?: string;
    ts?: number;
    providerResponseId?: string;
    extraPayloadFields?: Record<string, unknown>;
  } = {},
): EventRow {
  const {
    released = true,
    sessionId = 'session-1',
    ts = id * 1_000,
    providerResponseId,
    extraPayloadFields = {},
  } = options;
  return {
    id,
    sessionId,
    ts,
    type: 'metric',
    released,
    payload: {
      ...payload,
      ...identity,
      ...(providerResponseId ? { providerResponseId } : {}),
      ...extraPayloadFields,
    },
  };
}

function buildPrimaryFixture(): EventRow[] {
  return [
    metricEvent(11, {
      schemaVersion: '1.0.0',
      name: 'board_reveal_to_narration',
      unit: 'ms',
      value: -900,
    }),
    metricEvent(12, {
      schemaVersion: '1.0.0',
      name: 'barge_in_gate_outcome',
      unit: 'count',
      value: 1,
      dimensions: { outcome: 'local_only_rejected' },
    }),
    metricEvent(13, {
      schemaVersion: '1.0.0',
      name: 'board_reveal_to_narration',
      unit: 'ms',
      value: 120,
    }),
    metricEvent(14, {
      schemaVersion: '1.0.0',
      name: 'barge_in_gate_outcome',
      unit: 'count',
      value: 1,
      dimensions: { outcome: 'provider_only_rejected' },
    }),
    metricEvent(15, {
      schemaVersion: '1.0.0',
      name: 'barge_in_gate_outcome',
      unit: 'count',
      value: 1,
      dimensions: { outcome: 'confirmed' },
    }, { providerResponseId: 'resp-a' }),
    metricEvent(16, {
      schemaVersion: '1.0.0',
      name: 'barge_in_gate_outcome',
      unit: 'count',
      value: 1,
      dimensions: { outcome: 'confirmed' },
    }, { providerResponseId: 'resp-b' }),
    metricEvent(17, {
      schemaVersion: '1.0.0',
      name: 'barge_in_cancel_outcome',
      unit: 'count',
      value: 1,
      dimensions: { outcome: 'provider_cancelled' },
    }, { providerResponseId: 'resp-a' }),
    metricEvent(18, {
      schemaVersion: '1.0.0',
      name: 'section_navigation',
      unit: 'count',
      value: 1,
      dimensions: {
        previousSemanticGroupId: 'group-a',
        nextSemanticGroupId: 'group-b',
        cause: 'picker',
      },
    }),
    metricEvent(19, {
      schemaVersion: '1.0.0',
      name: 'section_navigation',
      unit: 'count',
      value: 1,
      dimensions: {
        previousSemanticGroupId: 'group-root',
        nextSemanticGroupId: 'group-a',
        cause: 'initial_anchor',
      },
    }),
    metricEvent(20, {
      schemaVersion: '1.0.0',
      name: 'session_reconnect',
      unit: 'count',
      value: 1,
    }),
    metricEvent(21, {
      schemaVersion: '1.0.0',
      name: 'session_reconnect',
      unit: 'count',
      value: 1,
    }),
    metricEvent(22, {
      schemaVersion: '1.0.0',
      name: 'tutor_object_disappearance',
      unit: 'count',
      value: 1,
      dimensions: { objectId: 'obj-1', cause: 'scene_mutation' },
    }),
    { id: 23, sessionId: 'session-1', ts: 23_000, type: 'learner_said', payload: { text: 'ignored transcript' }, released: true },
    metricEvent(24, {
      schemaVersion: '1.0.0',
      name: 'speech_end_to_first_audio',
      unit: 'ms',
      value: 1,
    }, {
      released: false,
    }),
    { id: 25, sessionId: 'session-1', ts: 25_000, type: 'metric', released: true, payload: { name: 'child_text', unit: 'count', value: 1 } },
  ];
}

describe('buildSessionTelemetryLog', () => {
  it('aggregates durations, barge-in outcomes, lifecycle counts, and timeline order', () => {
    const log = buildSessionTelemetryLog('session-1', buildPrimaryFixture(), 5_000);

    expect(log.summary.durations.board_reveal_to_narration).toEqual({
      count: 2,
      min: -900,
      max: 120,
      mean: -390,
      latest: 120,
    });
    expect(log.summary.bargeIn).toEqual({
      localOnlyRejected: 1,
      providerOnlyRejected: 1,
      confirmed: 2,
      providerCancelled: 1,
      providerCompleted: 0,
      providerFailed: 0,
      unresolved: 1,
    });
    expect(log.summary.sectionSwitchCount).toBe(1);
    expect(log.summary.reconnectCount).toBe(2);
    expect(log.summary.tutorObjectDisappearanceCount).toBe(1);
    expect(log.summary.telemetryGaps).toEqual({
      server_queue_overflow: 0,
      server_persistence_failure: 0,
      server_history_failure: 0,
      server_accounting_overflow: 0,
      client_queue_overflow: 0,
    });
    expect(log.timeline.map((entry) => entry.eventId)).toEqual([
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
    ]);
  });

  it('rounds duration means from the exact total without cumulative drift', () => {
    const events = [0, 1, 0].map((value, index) => metricEvent(index + 1, {
      schemaVersion: '1.0.0',
      name: 'speech_end_to_first_audio',
      unit: 'ms',
      value,
    }));

    expect(buildSessionTelemetryLog('session-1', events, 5_000).summary.durations.speech_end_to_first_audio).toEqual({
      count: 3,
      min: 0,
      max: 1,
      mean: 0,
      latest: 0,
    });
  });

  it('does not increment section switches for initial_anchor', () => {
    const events = [
      metricEvent(1, {
        schemaVersion: '1.0.0',
        name: 'section_navigation',
        unit: 'count',
        value: 1,
        dimensions: {
          previousSemanticGroupId: 'group-root',
          nextSemanticGroupId: 'group-a',
          cause: 'initial_anchor',
        },
      }),
    ];
    expect(buildSessionTelemetryLog('session-1', events, 5_000).summary.sectionSwitchCount).toBe(0);
  });

  it('resolves cancellation outcomes only for the matching providerResponseId', () => {
    const events = [
      metricEvent(1, {
        schemaVersion: '1.0.0',
        name: 'barge_in_gate_outcome',
        unit: 'count',
        value: 1,
        dimensions: { outcome: 'confirmed' },
      }, { providerResponseId: 'resp-a' }),
      metricEvent(2, {
        schemaVersion: '1.0.0',
        name: 'barge_in_gate_outcome',
        unit: 'count',
        value: 1,
        dimensions: { outcome: 'confirmed' },
      }, { providerResponseId: 'resp-b' }),
      metricEvent(3, {
        schemaVersion: '1.0.0',
        name: 'barge_in_cancel_outcome',
        unit: 'count',
        value: 1,
        dimensions: { outcome: 'provider_cancelled' },
      }, { providerResponseId: 'resp-b' }),
    ];

    expect(buildSessionTelemetryLog('session-1', events, 5_000).summary.bargeIn).toEqual({
      localOnlyRejected: 0,
      providerOnlyRejected: 0,
      confirmed: 2,
      providerCancelled: 1,
      providerCompleted: 0,
      providerFailed: 0,
      unresolved: 1,
    });
  });

  it('counts confirmed barge-ins without a providerResponseId as unresolved', () => {
    const events = [
      metricEvent(1, {
        schemaVersion: '1.0.0',
        name: 'barge_in_gate_outcome',
        unit: 'count',
        value: 1,
        dimensions: { outcome: 'confirmed' },
      }),
    ];

    expect(buildSessionTelemetryLog('session-1', events, 5_000).summary.bargeIn.unresolved).toBe(1);
  });

  it('excludes malformed metrics', () => {
    const events = [
      { id: 1, sessionId: 'session-1', ts: 1_000, type: 'metric', released: true, payload: { name: 'child_text', unit: 'count', value: 1 } },
      metricEvent(2, {
        schemaVersion: '1.0.0',
        name: 'session_reconnect',
        unit: 'count',
        value: 1,
      }),
    ];

    expect(buildSessionTelemetryLog('session-1', events, 5_000).timeline.map((entry) => entry.eventId)).toEqual([2]);
  });

  it('excludes unreleased metric events passed accidentally', () => {
    const events = [
      metricEvent(1, {
        schemaVersion: '1.0.0',
        name: 'session_reconnect',
        unit: 'count',
        value: 1,
      }, { released: false }),
      metricEvent(2, {
        schemaVersion: '1.0.0',
        name: 'session_reconnect',
        unit: 'count',
        value: 1,
      }),
    ];

    expect(buildSessionTelemetryLog('session-1', events, 5_000).summary.reconnectCount).toBe(1);
  });

  it('excludes released metric events belonging to another session', () => {
    const events = [
      metricEvent(1, {
        schemaVersion: '1.0.0',
        name: 'speech_end_to_first_audio',
        unit: 'ms',
        value: 900,
      }, { sessionId: 'session-2' }),
      metricEvent(2, {
        schemaVersion: '1.0.0',
        name: 'speech_end_to_first_audio',
        unit: 'ms',
        value: 200,
      }),
    ];

    const log = buildSessionTelemetryLog('session-1', events, 5_000);

    expect(log.summary.durations.speech_end_to_first_audio).toEqual({
      count: 1,
      min: 200,
      max: 200,
      mean: 200,
      latest: 200,
    });
    expect(log.timeline.map((entry) => entry.eventId)).toEqual([2]);
  });

  it('sums every provider usage category across observations', () => {
    const events = [
      metricEvent(1, {
        schemaVersion: '1.0.0',
        name: 'provider_usage',
        unit: 'count',
        value: 100,
        dimensions: {
          totalTokens: 100,
          inputTextTokens: 40,
          inputAudioTokens: 10,
          inputImageTokens: 0,
          cachedTextTokens: 5,
          cachedAudioTokens: 2,
          cachedImageTokens: 0,
          outputTextTokens: 30,
          outputAudioTokens: 20,
        },
      }),
      metricEvent(2, {
        schemaVersion: '1.0.0',
        name: 'provider_usage',
        unit: 'count',
        value: 50,
        dimensions: {
          totalTokens: 50,
          inputTextTokens: 20,
          inputAudioTokens: 5,
          inputImageTokens: 5,
          cachedTextTokens: 3,
          cachedAudioTokens: 1,
          cachedImageTokens: 2,
          outputTextTokens: 10,
          outputAudioTokens: 10,
        },
      }),
    ];

    expect(buildSessionTelemetryLog('session-1', events, 5_000).summary.providerUsage).toEqual({
      totalTokens: 150,
      inputTextTokens: 60,
      inputAudioTokens: 15,
      inputImageTokens: 5,
      cachedTextTokens: 8,
      cachedAudioTokens: 3,
      cachedImageTokens: 2,
      outputTextTokens: 40,
      outputAudioTokens: 30,
    });
  });

  it('marks truncated when the input reaches the requested limit', () => {
    const events = Array.from({ length: 100 }, (_, index) => metricEvent(index + 1, {
      schemaVersion: '1.0.0',
      name: 'session_reconnect',
      unit: 'count',
      value: 1,
    }));

    expect(buildSessionTelemetryLog('session-1', events, 100).truncated).toBe(true);
    expect(buildSessionTelemetryLog('session-1', events.slice(0, 99), 100).truncated).toBe(false);
  });

  it('projects aggregated telemetry gaps by bounded reason', () => {
    const events = [
      metricEvent(1, {
        schemaVersion: '1.0.0',
        name: 'telemetry_gap',
        unit: 'count',
        value: 3,
        dimensions: { reason: 'server_queue_overflow' },
      }),
      metricEvent(2, {
        schemaVersion: '1.0.0',
        name: 'telemetry_gap',
        unit: 'count',
        value: 2,
        dimensions: { reason: 'server_persistence_failure' },
      }),
      metricEvent(3, {
        schemaVersion: '1.0.0',
        name: 'telemetry_gap',
        unit: 'count',
        value: 4,
        dimensions: { reason: 'client_queue_overflow' },
      }),
      metricEvent(4, {
        schemaVersion: '1.0.0',
        name: 'telemetry_gap',
        unit: 'count',
        value: 1,
        dimensions: { reason: 'server_queue_overflow' },
      }),
    ];

    expect(buildSessionTelemetryLog('session-1', events, 5_000).summary.telemetryGaps).toEqual({
      server_queue_overflow: 4,
      server_persistence_failure: 2,
      server_history_failure: 0,
      server_accounting_overflow: 0,
      client_queue_overflow: 4,
    });
  });

  it('preserves only current-session server-encoded identifiers and re-encodes copied tokens', () => {
    const currentEncoded = prepareMetric('session-1', {
      schemaVersion: '1.0.0',
      name: 'session_reconnect',
      unit: 'count',
      value: 1,
    }, {
      connectionEpoch: 2,
      turnId: 'current-turn',
      generationId: 'current-generation',
    });
    const copiedEncoded = prepareMetric('session-other', {
      schemaVersion: '1.0.0',
      name: 'session_reconnect',
      unit: 'count',
      value: 1,
    }, {
      connectionEpoch: 2,
      turnId: 'copied-turn',
      generationId: 'copied-generation',
    });
    expect(currentEncoded).not.toBeNull();
    expect(copiedEncoded).not.toBeNull();
    const forgedToken = `tel2_${'A'.repeat(10)}_${'B'.repeat(24)}`;
    const secretValues = [
      'PRIVATE_NAME_AS_TURN',
      'PRIVATE_TRANSCRIPT_AS_GENERATION',
      'sk-secret-provider-response',
      'private-visual-cue',
      'private-semantic-object',
      'private-section-a',
      'private-section-b',
      'private-object-id',
    ];
    const events = [
      metricEvent(1, {
        schemaVersion: '1.0.0',
        name: 'board_reveal_to_narration',
        unit: 'ms',
        value: -10,
        visualCueId: secretValues[3],
        semanticObjectId: secretValues[4],
      }, {
        providerResponseId: secretValues[2],
        extraPayloadFields: {
          turnId: secretValues[0],
          generationId: secretValues[1],
        },
      }),
      metricEvent(2, {
        schemaVersion: '1.0.0',
        name: 'section_navigation',
        unit: 'count',
        value: 1,
        dimensions: {
          previousSemanticGroupId: secretValues[5],
          nextSemanticGroupId: secretValues[6],
          cause: 'picker',
        },
      }),
      metricEvent(3, {
        schemaVersion: '1.0.0',
        name: 'tutor_object_disappearance',
        unit: 'count',
        value: 1,
        dimensions: { objectId: secretValues[7], cause: 'scene_mutation' },
      }),
      metricEvent(4, {
        schemaVersion: '1.0.0',
        name: 'session_reconnect',
        unit: 'count',
        value: 1,
      }, {
        extraPayloadFields: currentEncoded ?? {},
      }),
      metricEvent(5, {
        schemaVersion: '1.0.0',
        name: 'session_reconnect',
        unit: 'count',
        value: 1,
      }, {
        extraPayloadFields: copiedEncoded ?? {},
      }),
      metricEvent(6, {
        schemaVersion: '1.0.0',
        name: 'session_reconnect',
        unit: 'count',
        value: 1,
      }, {
        extraPayloadFields: {
          turnId: forgedToken,
          generationId: forgedToken,
          telemetryEncoding: {
            version: 'forged-version',
            sessionTag: 'AAAAAAAAAA',
          },
        },
      }),
    ];

    const log = buildSessionTelemetryLog('session-1', events, 5_000);
    const serialized = JSON.stringify(log);
    for (const secret of secretValues) expect(serialized).not.toContain(secret);
    expect(log.timeline[0]).toMatchObject({
      turnId: expect.stringMatching(/^tel2_/),
      generationId: expect.stringMatching(/^tel2_/),
      providerResponseId: expect.stringMatching(/^tel2_/),
      visualCueId: expect.stringMatching(/^tel2_/),
      semanticObjectId: expect.stringMatching(/^tel2_/),
    });
    expect(log.timeline[3]).toMatchObject({
      turnId: currentEncoded?.turnId,
      generationId: currentEncoded?.generationId,
    });
    expect(log.timeline[4]?.turnId).not.toBe(copiedEncoded?.turnId);
    expect(log.timeline[4]?.generationId).not.toBe(copiedEncoded?.generationId);
    expect(log.timeline[4]).toMatchObject({
      turnId: expect.stringMatching(/^tel2_/),
      generationId: expect.stringMatching(/^tel2_/),
    });
    expect(log.timeline[5]?.turnId).not.toBe(forgedToken);
    expect(log.timeline[5]?.generationId).not.toBe(forgedToken);
  });

  it('does not expose payload text outside typed dimensions', () => {
    const log = buildSessionTelemetryLog('session-1', [
      metricEvent(1, {
        schemaVersion: '1.0.0',
        name: 'section_navigation',
        unit: 'count',
        value: 1,
        dimensions: {
          previousSemanticGroupId: 'group-a',
          nextSemanticGroupId: 'group-b',
          cause: 'picker',
        },
      }, {
        extraPayloadFields: {
          transcript: 'secret learner text',
          childName: 'Maya',
        },
      }),
    ], 5_000);

    expect(JSON.stringify(log)).not.toContain('secret learner text');
    expect(JSON.stringify(log)).not.toContain('Maya');
    expect(log.timeline[0]?.dimensions).toEqual({
      previousSemanticGroupId: expect.stringMatching(/^tel2_/),
      nextSemanticGroupId: expect.stringMatching(/^tel2_/),
      cause: 'picker',
    });
  });
});
