import {
  TELEMETRY_SCHEMA_VERSION,
  type DirectorReasoningEffort,
  type OpenAiTelemetryModel,
  type VisionAuditOutcome,
  type VisualTelemetryLane,
} from '../../shared/sessionTelemetry.js';
import { metricContextFromIdentity } from '../session/telemetryRecorder.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import type { GenerationIdentity } from '../../shared/runtimeProtocol.js';

type VisualTimingRun = {
  source: 'anchor' | 'director';
  pendingStepEventId: number | null;
  visualIntentStartedAtMs: number | null;
  firstPaintRecorded: boolean;
};

type VisualTimingClientMessage = {
  type: string;
  event_id?: unknown;
};

/** Observe first-paint acknowledgements before the ordinary client-event
 * dispatcher. This remains independent of whether the runtime also mirrors
 * presented-but-not-yet-durable board state. `ops_shown` is a compatibility
 * fallback for clients that predate `ops_presented`. */
export function recordVisualClientEventTiming(
  ctx: CoordinatorContext,
  message: VisualTimingClientMessage,
): void {
  if (message.type !== 'ops_presented' && message.type !== 'ops_shown') return;
  if (typeof message.event_id !== 'number') return;
  recordVisualFirstPaintForEvent(ctx, message.event_id);
}

/** Records intent→committed-browser-paint exactly once for the active run.
 * The browser supplies only the event acknowledgement; elapsed time and lane
 * are derived from server-owned state. */
export function recordVisualFirstPaintForEvent(
  ctx: CoordinatorContext,
  eventId: number,
): void {
  const run = ctx.state.storyboardRun as VisualTimingRun | null;
  if (!run || run.pendingStepEventId !== eventId || run.firstPaintRecorded) return;
  run.firstPaintRecorded = true;
  submitVisualTiming(ctx, 'visual_first_paint', run.visualIntentStartedAtMs, run.source);
}

export function recordVisualSceneComplete(
  ctx: CoordinatorContext,
  run: Pick<VisualTimingRun, 'source' | 'visualIntentStartedAtMs'>,
): void {
  submitVisualTiming(ctx, 'visual_scene_complete', run.visualIntentStartedAtMs, run.source);
}

export function recordDirectorStreamFirstOp(
  ctx: CoordinatorContext,
  input: {
    startedAtMs: number;
    model: OpenAiTelemetryModel;
    reasoningEffort: DirectorReasoningEffort;
    identity?: GenerationIdentity | null;
  },
): void {
  submitModelTiming(ctx, 'director_stream_first_op', input.startedAtMs, input);
}

export function recordVisionAuditOutcome(
  ctx: CoordinatorContext,
  input: {
    startedAtMs: number;
    model: OpenAiTelemetryModel;
    reasoningEffort: DirectorReasoningEffort;
    outcome: VisionAuditOutcome;
    identity?: GenerationIdentity | null;
  },
): void {
  submitModelTiming(ctx, 'vision_audit_outcome', input.startedAtMs, input);
}

function submitVisualTiming(
  ctx: CoordinatorContext,
  name: 'visual_first_paint' | 'visual_scene_complete',
  startedAtMs: number | null,
  lane: VisualTelemetryLane,
): void {
  const identity = ctx.state.clientIdentity;
  if (!identity || startedAtMs === null) return;
  ctx.telemetryWriter.submit({
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    name,
    unit: 'ms',
    value: elapsedMs(startedAtMs),
    dimensions: { lane },
  }, metricContextFromIdentity(identity));
}

function submitModelTiming(
  ctx: CoordinatorContext,
  name: 'director_stream_first_op' | 'vision_audit_outcome',
  startedAtMs: number,
  input: {
    model: OpenAiTelemetryModel;
    reasoningEffort: DirectorReasoningEffort;
    outcome?: VisionAuditOutcome;
    identity?: GenerationIdentity | null;
  },
): void {
  const identity = Object.hasOwn(input, 'identity')
    ? input.identity ?? null
    : ctx.state.clientIdentity;
  if (!identity) return;
  ctx.telemetryWriter.submit({
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    name,
    unit: 'ms',
    value: elapsedMs(startedAtMs),
    dimensions: {
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      ...(input.outcome ? { outcome: input.outcome } : {}),
    },
  }, metricContextFromIdentity(identity));
}

function elapsedMs(startedAtMs: number): number {
  return Math.max(0, Math.round(Date.now() - startedAtMs));
}
