import { TELEMETRY_SCHEMA_VERSION } from '../../shared/sessionTelemetry.js';
import { metricContextFromIdentity } from '../session/telemetryRecorder.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import { addBounded } from './responseRegistry.js';
import { refreshBoardInstructions } from './sessionConfig.js';
import type { StoryboardSource } from './storyboardRunner.js';
import { sendResponseCreate, tutorFloorIsFree } from './turnFloor.js';
import type { VisualRequest } from './visualRequests.js';

/**
 * Explicit scoped abandonment of a stale completion. This is scoped to the
 * request that went stale: the active turn and any newer storyboard remain
 * untouched, while the honest note is emitted at most once per request.
 */
export function abandonStaleVisualRequest(
  ctx: CoordinatorContext,
  requestId: string,
  source: StoryboardSource,
  totalSteps: number,
  options: { injectNote: boolean },
): void {
  const { state } = ctx;
  if (state.abandonedVisualRequests.has(requestId)) return;
  addBounded(state.abandonedVisualRequests, requestId, 64);
  ctx.log(`session ${ctx.sessionId}: stale ${source} visual request ${requestId} abandoned`);
  const identity = state.clientIdentity;
  if (identity) {
    ctx.telemetryWriter.submit({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      name: 'storyboard_outcome',
      unit: 'count',
      value: 1,
      dimensions: { outcome: 'abandoned', source, revealedSteps: 0, totalSteps },
    }, metricContextFromIdentity(identity));
  }
  if (!options.injectNote) return;
  ctx.sendUpstream({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [{
        type: 'input_text',
        text: '[The visual you asked for earlier could not be prepared in time and will not appear.] The lesson has moved on — keep teaching with what is visible now and do not mention that picture.',
      }],
    },
  });
}

export function recordVisualRequestOutcome(
  ctx: CoordinatorContext,
  request: VisualRequest,
  status: string,
  latencyMs: number,
  reasons: string[] = [],
): void {
  const write = Promise.resolve(ctx.repo.addEvent(ctx.sessionId, 'visual_request_outcome', {
    requestId: request.requestId,
    action: request.action,
    status,
    latencyMs: Math.max(0, latencyMs),
    reasonCategories: reasons.slice(0, 5).map((reason) => reason.split(':', 1)[0].slice(0, 120)),
  })).then(() => undefined).catch((error) => {
    ctx.log(`session ${ctx.sessionId}: visual request outcome write failed ${String(error).slice(0, 160)}`);
  });
  ctx.trackSideEffect(write);
}

export function recordIllustrationMetric(
  ctx: CoordinatorContext,
  illustration: { ok: boolean; cacheHit: boolean; latencyMs: number; imageCount: number; totalTokens: number; refused?: boolean } | undefined,
): void {
  const identity = ctx.state.clientIdentity;
  if (!identity || !illustration) return;
  ctx.telemetryWriter.submit({
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    name: 'illustration_generation',
    unit: 'ms',
    value: illustration.latencyMs,
    dimensions: {
      cache: illustration.cacheHit ? 'hit' : 'miss',
      outcome: illustration.ok ? 'accepted' : illustration.refused ? 'refused' : 'failed',
      imageCount: illustration.imageCount,
      totalTokens: illustration.totalTokens,
    },
  }, metricContextFromIdentity(identity));
}

/** Fail closed with an honest bridge after the tutor was told a visual was
 * being prepared. */
export function failDirectedScene(ctx: CoordinatorContext, reasons: string[]): void {
  const { state } = ctx;
  state.visualPlanState = 'failed';
  ctx.sendClient({ type: 'illustration_status', status: 'failed' });
  state.boardContext.observeBoardRejection(reasons.join('; ').slice(0, 300));
  refreshBoardInstructions(ctx);
  ctx.sendUpstream({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [{
        type: 'input_text',
        text: '[The requested visual could not be prepared and will not appear.] Continue teaching with what is visible now; do not mention the failed picture. If a visual is still essential, request one simpler alternative after the learner’s next turn.',
      }],
    },
  });
  if (tutorFloorIsFree(ctx)) sendResponseCreate(ctx, 'tool');
}
