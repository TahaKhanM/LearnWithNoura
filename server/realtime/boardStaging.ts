import type { BoardOp } from '../../shared/boardOps.js';
import type { SemanticCheckpoint } from '../../shared/semanticScene.js';
import type { LayoutPreflightResult } from '../../shared/layoutFeedback.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import { identityForResponse } from './responseRegistry.js';
import { refreshBoardInstructions } from './sessionConfig.js';
import { finishTool } from './turnFloor.js';

/**
 * Board plan staging: preflight, checkpoint persistence, and the visibility
 * barrier that keeps continuation speech honest about what the learner can
 * actually see. Storyboard-bearing scenes are sequenced step by step by
 * `storyboardRunner.ts`; this module serves fast-tier confirmations (such
 * as emphasize) that reveal in one committed batch.
 */

export function anchorGroupId(ctx: CoordinatorContext): string | null {
  return ctx.state.lessonState.blueprint?.anchor?.semanticGroupId ?? null;
}

/** Resolves when the browser has confirmed every staged checkpoint is
 * actually on screen (`ops_shown`), or fails closed on rejection/timeout. */
export function waitForCheckpointVisibility(ctx: CoordinatorContext, eventIds: number[]): Promise<boolean> {
  if (eventIds.length === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let remaining = eventIds.length;
    let settled = false;
    const timer = setTimeout(() => finish(false), ctx.visibilityTimeoutMs);
    const finish = (shown: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const eventId of eventIds) ctx.state.pendingVisibility.delete(eventId);
      resolve(shown);
    };
    for (const eventId of eventIds) {
      ctx.state.pendingVisibility.set(eventId, (shown) => {
        if (!shown) { finish(false); return; }
        remaining -= 1;
        if (remaining <= 0) finish(true);
      });
    }
  });
}

/** Resolves at the first committed browser paint, before draw-on animation
 * completion. This is the semantic visibility barrier for tool results. */
export function waitForCheckpointPresentation(ctx: CoordinatorContext, eventIds: number[]): Promise<boolean> {
  if (eventIds.length === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let remaining = eventIds.length;
    let settled = false;
    const timer = setTimeout(() => finish(false), ctx.visibilityTimeoutMs);
    const finish = (presented: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const eventId of eventIds) ctx.state.pendingPresentation.delete(eventId);
      resolve(presented);
    };
    for (const eventId of eventIds) {
      if (ctx.state.presentedBoardOps.has(eventId)) {
        remaining -= 1;
        continue;
      }
      ctx.state.pendingPresentation.set(eventId, (presented) => {
        if (!presented) { finish(false); return; }
        remaining -= 1;
        if (remaining <= 0) finish(true);
      });
    }
    if (remaining <= 0) finish(true);
  });
}

/**
 * Asks the browser to compile-check a complete candidate plan offscreen.
 * Fails closed: no connected client or a timeout means "not shown" — the
 * model may continue without a visual or retry a simpler plan, but missing
 * evidence is never turned into acceptance.
 */
export function preflightWithClient(
  ctx: CoordinatorContext,
  input: { ops: BoardOp[]; semanticGroupId: string; groupLabel?: string; replacesGroup?: string },
): Promise<LayoutPreflightResult> {
  if (!ctx.state.clientIdentity || !ctx.clientConnected()) return Promise.resolve({ accepted: false, reasons: ['no browser is connected to validate the plan'], layoutIssues: [] });
  const preflightId = `preflight-${++ctx.state.preflightCounter}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ctx.state.pendingPreflights.delete(preflightId);
      resolve({ accepted: false, reasons: ['the browser did not confirm the plan in time'], layoutIssues: [] });
    }, ctx.preflightTimeoutMs);
    ctx.state.pendingPreflights.set(preflightId, (result) => {
      clearTimeout(timer);
      ctx.state.pendingPreflights.delete(preflightId);
      resolve(result);
    });
    ctx.sendClient({
      type: 'visual_preflight',
      preflight_id: preflightId,
      ops: input.ops,
      semanticObjectId: input.semanticGroupId,
      ...(input.groupLabel ? { groupLabel: input.groupLabel } : {}),
      ...(input.replacesGroup ? { replacesGroup: input.replacesGroup } : {}),
    });
  });
}

/** Renders immutable BoardOps in the connected learner browser. The same
 * client compiler, fonts, asset URLs, and canvas implementation that will
 * display the scene therefore provide the Director's vision image. */
export function renderWithClient(
  ctx: CoordinatorContext,
  ops: BoardOp[],
  semanticGroupId?: string,
): Promise<string | null> {
  if (!ctx.state.clientIdentity || !ctx.clientConnected()) return Promise.resolve(null);
  const renderId = `render-${++ctx.state.visualRenderCounter}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ctx.state.pendingVisualRenders.delete(renderId);
      resolve(null);
    }, Math.max(5_000, ctx.preflightTimeoutMs));
    ctx.state.pendingVisualRenders.set(renderId, (imageDataUrl) => {
      clearTimeout(timer);
      ctx.state.pendingVisualRenders.delete(renderId);
      resolve(imageDataUrl);
    });
    ctx.sendClient({
      type: 'visual_render',
      render_id: renderId,
      ops,
      ...(semanticGroupId ? { semanticObjectId: semanticGroupId } : {}),
    });
  });
}

/**
 * The visibility barrier for fast-tier board confirmations: validate →
 * preflight (fail closed) → stage exactly one plan → wait until the browser
 * confirms it is actually on screen (`ops_shown`) → only then return the
 * successful tool result (with the now-authoritative visible board) so
 * continuation speech can refer to what the learner can really see.
 */
export function stageAndConfirmPlan(ctx: CoordinatorContext, callId: string, responseId: string, input: {
  ops: BoardOp[];
  checkpoints: SemanticCheckpoint[];
  action: string;
  skipPreflight?: boolean;
}): void {
  const { state } = ctx;
  const groupId = input.checkpoints[0]?.semanticObjectId ?? '';
  const groupLabel = input.checkpoints[0]?.groupLabel;
  const stagingTask = (async () => {
    if (!input.skipPreflight && input.ops.length > 0 && groupId) {
      const preflight = await preflightWithClient(ctx, { ops: input.ops, semanticGroupId: groupId, groupLabel });
      if (!preflight.accepted) {
        state.boardContext.observeBoardRejection(preflight.reasons.join('; ').slice(0, 300) || 'Complete-plan preflight failed.');
        refreshBoardInstructions(ctx);
        finishTool(ctx, callId, responseId, {
          ok: false,
          accepted: false,
          reason: `The complete visual failed deterministic layout preflight: ${preflight.reasons.join('; ').slice(0, 240)}. Nothing was drawn. Continue without the visual or retry once with a simpler plan.`,
          board: state.boardContext.toolSnapshot(),
        });
        return;
      }
    }
    const eventIds: number[] = [];
    for (const checkpoint of input.checkpoints) {
      const eventId = await ctx.repo.addEvent(ctx.sessionId, 'semantic_scene', {
        ops: checkpoint.ops,
        checkpointId: checkpoint.id,
        reveal: checkpoint.reveal,
        semanticObjectId: checkpoint.semanticObjectId,
        groupLabel: checkpoint.groupLabel,
      }, false);
      eventIds.push(eventId);
      state.pendingBoardOps.set(eventId, {
        ops: checkpoint.ops,
        semanticGroupId: checkpoint.semanticObjectId,
        groupLabel: checkpoint.groupLabel,
      });
      const cuePayload = {
        type: 'board_ops',
        ops: checkpoint.ops,
        response_id: responseId,
        event_id: eventId,
        groupLabel: checkpoint.groupLabel,
        checkpoint: checkpoint.reveal,
      };
      // Sent immediately, tagged with its response: the browser binds the
      // reveal to the playback boundaries it observes on its data channel.
      if (!state.cancelledResponses.has(responseId)) {
        ctx.sendClient(cuePayload, identityForResponse(ctx, responseId), {
          visualCueId: checkpoint.id,
          semanticObjectId: checkpoint.semanticObjectId,
        });
      }
    }
    for (const op of input.ops) if (op.op === 'add') state.objectsCreatedThisTurn.add(op.id);
    const visible = await waitForCheckpointVisibility(ctx, eventIds);
    if (!visible) {
      for (const eventId of eventIds) state.pendingBoardOps.delete(eventId);
      finishTool(ctx, callId, responseId, {
        ok: false,
        accepted: false,
        reason: 'The visual was not confirmed on the learner’s screen. It is not visible; do not refer to it. Continue without it or retry once with a simpler plan.',
        board: state.boardContext.toolSnapshot(),
      });
      return;
    }
    // The board context was advanced by the acknowledgements, so this
    // snapshot is the authoritative, actually-visible board.
    finishTool(ctx, callId, responseId, {
      ok: true,
      accepted: true,
      visible: true,
      applied: input.ops.length,
      checkpoints: input.checkpoints.length,
      action: input.action,
      visibleObjectIds: input.ops.filter((op) => op.op === 'add').map((op) => op.id),
      ...(groupId ? { semanticGroupId: groupId } : {}),
      board: state.boardContext.toolSnapshot(),
    });
  })().catch((error) => {
    ctx.log(`session ${ctx.sessionId}: semantic plan staging error ${String(error).slice(0, 200)}`);
    finishTool(ctx, callId, responseId, { ok: false, accepted: false, error: String(error).slice(0, 260) });
  });
  ctx.trackSideEffect(stagingTask);
}

/**
 * Server-initiated late illustration arrival after the overlay storyboard
 * has already finished. Uses the ordinary semantic_scene → board_ops →
 * ops_shown protocol, without a tool call to finish.
 */
export async function stageServerInitiatedCheckpoint(ctx: CoordinatorContext, input: {
  ops: BoardOp[];
  groupId: string;
  groupLabel: string;
  checkpointId: string;
  reveal: SemanticCheckpoint['reveal'];
}): Promise<boolean> {
  const { state } = ctx;
  const eventId = await ctx.repo.addEvent(ctx.sessionId, 'semantic_scene', {
    ops: input.ops,
    checkpointId: input.checkpointId,
    reveal: input.reveal,
    semanticObjectId: input.groupId,
    groupLabel: input.groupLabel,
  }, false);
  state.pendingBoardOps.set(eventId, {
    ops: input.ops,
    semanticGroupId: input.groupId,
    groupLabel: input.groupLabel,
  });
  for (const op of input.ops) if (op.op === 'add') state.objectsCreatedThisTurn.add(op.id);
  ctx.sendClient({
    type: 'board_ops',
    ops: input.ops,
    event_id: eventId,
    groupLabel: input.groupLabel,
    checkpoint: input.reveal,
  }, state.clientIdentity, {
    visualCueId: input.checkpointId,
    semanticObjectId: input.groupId,
  });
  const visible = await waitForCheckpointVisibility(ctx, [eventId]);
  if (!visible) {
    state.pendingBoardOps.delete(eventId);
    return false;
  }
  return true;
}

