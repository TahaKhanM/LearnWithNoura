import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MetricInputSchema,
  type MetricContext,
  type MetricInput,
} from '../../shared/sessionTelemetry.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import { visionAuditTelemetryInput } from './streamingVisualRequest.js';
import {
  recordDirectorStreamFirstOp,
  recordVisionAuditOutcome,
  recordVisualClientEventTiming,
  recordVisualSceneComplete,
} from './visualTelemetry.js';

type TestRun = {
  source: 'anchor' | 'director';
  pendingStepEventId: number | null;
  visualIntentStartedAtMs: number | null;
  firstPaintRecorded: boolean;
};

type SubmittedMetric = {
  input: MetricInput;
  context: MetricContext;
};

const identity = {
  sessionId: 'session-1',
  connectionEpoch: 2,
  turnId: 'turn-3',
  generationId: 'generation-4',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Drawing vNext runtime telemetry', () => {
  it('records first paint once from ops_presented using server-owned timing and lane', () => {
    vi.spyOn(Date, 'now').mockReturnValue(9_400);
    const run: TestRun = {
      source: 'anchor',
      pendingStepEventId: 41,
      visualIntentStartedAtMs: 5_000,
      firstPaintRecorded: false,
    };
    const { ctx, submitted } = contextWithRun(run);

    recordVisualClientEventTiming(ctx, { type: 'metric', event_id: 41 });
    recordVisualClientEventTiming(ctx, { type: 'ops_presented', event_id: 99 });
    expect(submitted).toEqual([]);

    recordVisualClientEventTiming(ctx, { type: 'ops_presented', event_id: 41 });
    recordVisualClientEventTiming(ctx, { type: 'ops_shown', event_id: 41 });

    expect(submitted).toEqual([{
      input: {
        schemaVersion: '1.0.0',
        name: 'visual_first_paint',
        unit: 'ms',
        value: 4_400,
        dimensions: { lane: 'anchor' },
      },
      context: {
        connectionEpoch: 2,
        turnId: 'turn-3',
        generationId: 'generation-4',
      },
    }]);
    expect(run.firstPaintRecorded).toBe(true);
  });

  it('uses ops_shown as a compatibility fallback and omits reconnect-relative timing', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const fallbackRun: TestRun = {
      source: 'director',
      pendingStepEventId: 7,
      visualIntentStartedAtMs: 8_500,
      firstPaintRecorded: false,
    };
    const fallback = contextWithRun(fallbackRun);
    recordVisualClientEventTiming(fallback.ctx, { type: 'ops_shown', event_id: 7 });
    expect(fallback.submitted[0]?.input).toMatchObject({
      name: 'visual_first_paint',
      value: 1_500,
      dimensions: { lane: 'director' },
    });

    const restoredRun: TestRun = {
      source: 'anchor',
      pendingStepEventId: 8,
      visualIntentStartedAtMs: null,
      firstPaintRecorded: false,
    };
    const restored = contextWithRun(restoredRun);
    recordVisualClientEventTiming(restored.ctx, { type: 'ops_presented', event_id: 8 });
    expect(restored.submitted).toEqual([]);
    expect(restoredRun.firstPaintRecorded).toBe(true);
  });

  it('records scene completion and model-role timings with closed dimensions', () => {
    vi.spyOn(Date, 'now').mockReturnValue(20_000);
    const run: TestRun = {
      source: 'director',
      pendingStepEventId: null,
      visualIntentStartedAtMs: 14_000,
      firstPaintRecorded: true,
    };
    const { ctx, submitted } = contextWithRun(run);

    recordVisualSceneComplete(ctx, run);
    recordDirectorStreamFirstOp(ctx, {
      startedAtMs: 15_500,
      model: 'gpt-5.6-terra',
      reasoningEffort: 'low',
    });
    recordVisionAuditOutcome(ctx, {
      startedAtMs: 18_500,
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      outcome: 'approved',
    });

    expect(submitted.map((entry) => entry.input)).toEqual([
      expect.objectContaining({
        name: 'visual_scene_complete',
        value: 6_000,
        dimensions: { lane: 'director' },
      }),
      expect.objectContaining({
        name: 'director_stream_first_op',
        value: 4_500,
        dimensions: { model: 'gpt-5.6-terra', reasoningEffort: 'low' },
      }),
      expect.objectContaining({
        name: 'vision_audit_outcome',
        value: 1_500,
        dimensions: {
          model: 'gpt-5.6-luna',
          reasoningEffort: 'low',
          outcome: 'approved',
        },
      }),
    ]);
  });

  it('strips free-form audit issues at the streaming event boundary', () => {
    const input = visionAuditTelemetryInput({
      startedAtMs: 18_000,
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      outcome: 'rejected',
      issues: ['PRIVATE FREE-FORM JUDGE TEXT'],
    }, identity);

    expect(input).toEqual({
      startedAtMs: 18_000,
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      outcome: 'rejected',
      identity,
    });
    expect(JSON.stringify(input)).not.toContain('PRIVATE FREE-FORM JUDGE TEXT');
  });

  it('attributes a late audit completion to the identity captured at dispatch', () => {
    vi.spyOn(Date, 'now').mockReturnValue(20_000);
    const { ctx, submitted } = contextWithRun({
      source: 'director', pendingStepEventId: null,
      visualIntentStartedAtMs: 10_000, firstPaintRecorded: false,
    });
    const captured = { ...identity };
    ctx.state.clientIdentity = { ...identity, turnId: 'new-turn', generationId: 'new-generation' };
    recordVisionAuditOutcome(ctx, {
      startedAtMs: 18_000,
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      outcome: 'approved',
      identity: captured,
    });
    expect(submitted[0].context).toMatchObject({
      turnId: 'turn-3',
      generationId: 'generation-4',
    });
  });
});

function contextWithRun(run: TestRun): {
  ctx: CoordinatorContext;
  submitted: SubmittedMetric[];
} {
  const submitted: SubmittedMetric[] = [];
  const ctx = {
    state: {
      clientIdentity: identity,
      storyboardRun: run,
    },
    telemetryWriter: {
      submit(input: unknown, context: MetricContext) {
        submitted.push({ input: MetricInputSchema.parse(input), context });
        return true;
      },
    },
  } as unknown as CoordinatorContext;
  return { ctx, submitted };
}
