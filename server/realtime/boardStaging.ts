import type { BoardOp } from '../../shared/boardOps.js';
import type { SemanticCheckpoint, SemanticScenePlan } from '../../shared/semanticScene.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import { identityForResponse, responseSegment } from './responseRegistry.js';
import { refreshBoardInstructions } from './sessionConfig.js';
import { finishTool } from './turnFloor.js';

/**
 * Board plan staging: preflight, checkpoint persistence, and the visibility
 * barrier that keeps continuation speech honest about what the learner can
 * actually see.
 */

export function anchorGroupId(ctx: CoordinatorContext): string | null {
  return ctx.state.lessonState.blueprint?.anchor?.semanticGroupId ?? null;
}

/** Resolves when the browser has confirmed every staged checkpoint is
 * actually on screen (`ops_shown`), or fails closed on rejection/timeout. */
function waitForCheckpointVisibility(ctx: CoordinatorContext, eventIds: number[]): Promise<boolean> {
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

/**
 * Asks the browser to compile-check a complete candidate plan offscreen.
 * Fails closed: no connected client or a timeout means "not shown" — the
 * model may continue without a visual or retry a simpler plan, but missing
 * evidence is never turned into acceptance.
 */
function preflightWithClient(
  ctx: CoordinatorContext,
  input: { ops: BoardOp[]; semanticGroupId: string; groupLabel?: string; replacesGroup?: string },
): Promise<{ accepted: boolean; reasons: string[] }> {
  if (!ctx.state.clientIdentity || !ctx.clientConnected()) return Promise.resolve({ accepted: false, reasons: ['no browser is connected to validate the plan'] });
  const preflightId = `preflight-${++ctx.state.preflightCounter}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ctx.state.pendingPreflights.delete(preflightId);
      resolve({ accepted: false, reasons: ['the browser did not confirm the plan in time'] });
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

/**
 * The visibility barrier for board-led moves: validate → preflight (fail
 * closed) → stage exactly one plan → wait until the browser confirms it is
 * actually on screen (`ops_shown`) → only then return the successful tool
 * result (with the now-authoritative visible board) so continuation speech
 * can refer to what the learner can really see.
 */
export function stageAndConfirmPlan(ctx: CoordinatorContext, callId: string, responseId: string, input: {
  ops: BoardOp[];
  checkpoints: SemanticCheckpoint[];
  action: string;
  plan?: SemanticScenePlan;
  announcement?: string;
  skipPreflight?: boolean;
}): void {
  const { state } = ctx;
  const groupId = input.checkpoints[0]?.semanticObjectId ?? '';
  const groupLabel = input.checkpoints[0]?.groupLabel;
  const structural = ['establish', 'compare'].includes(input.action);
  if (structural) {
    state.planStagedThisTurn = true;
    state.planAttemptsThisTurn += 1;
    state.visualPlanState = 'preparing';
  }
  // Captured synchronously: staging may finish after this response seals,
  // in which case cues are delivered directly at its final audio boundary.
  const planSegment = responseSegment(ctx, responseId);
  const stagingTask = (async () => {
    if (!input.skipPreflight && input.ops.length > 0 && groupId) {
      const preflight = await preflightWithClient(ctx, { ops: input.ops, semanticGroupId: groupId, groupLabel });
      if (!preflight.accepted) {
        if (structural) state.visualPlanState = 'failed';
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
    if (structural) state.visualPlanState = 'rendering';
    const eventIds: number[] = [];
    for (const checkpoint of input.checkpoints) {
      const eventId = await ctx.repo.addEvent(ctx.sessionId, 'semantic_scene', {
        ...(input.plan ? { plan: input.plan } : {}),
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
      const cueOptional = {
        visualCueId: checkpoint.id,
        semanticObjectId: checkpoint.semanticObjectId,
      };
      if (!planSegment.isSealed()) planSegment.addSemanticCue(cuePayload, cueOptional);
      else if (!state.cancelledResponses.has(responseId)) {
        const total = planSegment.totalSamples();
        ctx.sendClient(cuePayload, identityForResponse(ctx, responseId), { ...cueOptional, audioSampleOffsets: { start: total, end: total } });
      }
    }
    for (const op of input.ops) if (op.op === 'add') state.objectsCreatedThisTurn.add(op.id);
    const visible = await waitForCheckpointVisibility(ctx, eventIds);
    if (!visible) {
      if (structural) state.visualPlanState = 'failed';
      for (const eventId of eventIds) state.pendingBoardOps.delete(eventId);
      finishTool(ctx, callId, responseId, {
        ok: false,
        accepted: false,
        reason: 'The visual was not confirmed on the learner’s screen. It is not visible; do not refer to it. Continue without it or retry once with a simpler plan.',
        board: state.boardContext.toolSnapshot(),
      });
      return;
    }
    if (structural) state.visualPlanState = 'visible';
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
      ...(input.announcement ? { announcement: input.announcement } : {}),
      board: state.boardContext.toolSnapshot(),
    });
  })().catch((error) => {
    if (structural) state.visualPlanState = 'failed';
    ctx.log(`session ${ctx.sessionId}: semantic plan staging error ${String(error).slice(0, 200)}`);
    finishTool(ctx, callId, responseId, { ok: false, accepted: false, error: String(error).slice(0, 260) });
  });
  ctx.trackSideEffect(stagingTask);
}

/** The server, not the model, decides which section a plan builds. */
export function assignSectionToPlan(rawArgs: Record<string, unknown>, groupId: string): Record<string, unknown> {
  const source = rawArgs as { groups?: Array<Record<string, unknown>> };
  const groups = (source.groups ?? []).map((group, index) => index === 0 ? { ...group, id: groupId } : group);
  return { ...rawArgs, groups };
}
