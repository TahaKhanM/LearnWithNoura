import {
  anchorRefTargetIds,
  validateAnchorRef,
  type AddOp,
  type AnnotationStyle,
  type ImageRegionSelector,
} from '../../shared/boardOps.js';
import { groundImageRegion, type ImageGroundingResult } from '../board/imageGrounding.js';
import { preflightWithClient, renderWithClient, waitForCheckpointPresentation } from './boardStaging.js';
import type { ClientMessage } from './clientEvents.js';
import type { CoordinatorContext, PendingImageGrounding } from './coordinatorContext.js';
import { identityForResponse } from './responseRegistry.js';
import { refreshBoardInstructions } from './sessionConfig.js';
import { finishTool, requestModelResponse } from './turnFloor.js';

const STYLES = new Set<AnnotationStyle>(['circle', 'underline', 'arrow', 'tick', 'cross', 'bracket', 'callout', 'highlighter']);

export async function handleGroundImageRegionTool(
  ctx: CoordinatorContext,
  args: Record<string, unknown>,
  callId: string,
  responseId: string,
): Promise<void> {
  const requestId = safeId(args.requestId, 120);
  const imageId = safeId(args.imageId, 40);
  const hint = safeText(args.hint, 200);
  const style = STYLES.has(args.style as AnnotationStyle) ? args.style as AnnotationStyle : null;
  const note = safeText(args.note, 120);
  if (!requestId || !imageId || !hint || !style || (style === 'callout' && !note)) {
    finishTool(ctx, callId, responseId, { ok: false, status: 'rejected', reason: 'Image grounding arguments failed validation.' });
    return;
  }
  const image = ctx.state.boardContext.visibleImage(imageId);
  if (!image) {
    finishTool(ctx, callId, responseId, { ok: false, status: 'rejected', reason: 'Image grounding requires a visible image id.' });
    return;
  }
  const pending: PendingImageGrounding = {
    requestId, imageId, hint, style,
    ...(note ? { note } : {}),
    ...(image.semanticGroupId ? { semanticGroupId: image.semanticGroupId } : {}),
  };
  const fallback = (reason: Extract<ImageGroundingResult, { status: 'tap_required' }>['reason']) => {
    ctx.state.pendingImageGroundings.set(requestId, pending);
    ctx.sendClient({
      type: 'image_region_tap_request',
      request_id: requestId,
      image_id: imageId,
      hint,
    });
    finishTool(ctx, callId, responseId, {
      ok: true,
      accepted: false,
      status: 'tap_required',
      reason,
      guidance: 'Ask the learner to tap the requested part of the image. Do not guess its location.',
    });
  };
  if (!ctx.imageGroundingProposal || !ctx.visionAudit) {
    fallback('grounding_unavailable');
    return;
  }
  const boardImage = await renderWithClient(ctx, []);
  if (!boardImage) {
    fallback('render_failed');
    return;
  }
  const controller = new AbortController();
  const result = await groundImageRegion({
    imageId,
    hint,
    boardImage,
    proposal: ctx.imageGroundingProposal,
    audit: ctx.visionAudit,
    signal: controller.signal,
    renderCandidate: async (selector) => {
      const annotation = annotationOp(pending, selector);
      const groupId = pending.semanticGroupId ?? `image-${imageId}`;
      const preflight = await preflightWithClient(ctx, {
        ops: [annotation],
        semanticGroupId: groupId,
        groupLabel: 'Grounded image annotation',
      });
      if (!preflight.accepted) return null;
      return renderWithClient(ctx, [...ctx.state.boardContext.visibleOps(), annotation], groupId);
    },
  });
  if (result.status === 'tap_required') {
    fallback(result.reason);
    return;
  }
  const presented = await stageAnnotation(ctx, pending, result.selector, responseId);
  finishTool(ctx, callId, responseId, presented
    ? {
        ok: true,
        accepted: true,
        status: 'visible',
        guidance: 'The verified annotation is visible. Speak about the target, not the grounding process.',
        board: ctx.state.boardContext.toolSnapshot(imageId),
      }
    : {
        ok: false,
        accepted: false,
        status: 'not_presented',
        reason: 'The browser did not confirm the grounded annotation.',
      });
}

export function handleImageRegionTap(
  ctx: CoordinatorContext,
  message: ClientMessage,
): void {
  const requestId = safeId(message.request_id, 120);
  const imageId = safeId(message.image_id, 40);
  if (!requestId || !imageId) return;
  const pending = ctx.state.pendingImageGroundings.get(requestId);
  if (!pending || pending.imageId !== imageId) return;
  const ref = validateAnchorRef({
    type: 'image_region',
    imageId,
    selector: message.selector,
  });
  if (!ref || ref.type !== 'image_region' || ref.selector.type !== 'PointSelector') return;
  ctx.state.pendingImageGroundings.delete(requestId);
  const responseId = ctx.state.lastCompletedResponseId ?? ctx.state.activeResponseId ?? '';
  const task = (async () => {
    const presented = await stageAnnotation(ctx, pending, ref.selector, responseId);
    ctx.sendClient({
      type: 'image_region_grounded',
      request_id: requestId,
      accepted: presented,
    });
    if (!presented) return;
    ctx.sendUpstream({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: '[The learner tapped the requested image target and the application added the annotation.] Respond to the teaching idea without mentioning coordinates or vision internals.' }],
      },
    });
    refreshBoardInstructions(ctx);
    requestModelResponse(ctx, 'board', `image-grounding-${requestId}`);
  })();
  ctx.trackSideEffect(task);
}

function annotationOp(pending: PendingImageGrounding, selector: ImageRegionSelector): AddOp {
  return {
    op: 'add',
    id: `annotation-${pending.requestId}`.replace(/[^a-z0-9_-]/gi, '-').slice(0, 40),
    color: '#E14B3C',
    spec: {
      kind: 'annotate',
      style: pending.style,
      target: { type: 'image_region', imageId: pending.imageId, selector },
      ...(pending.note ? { note: pending.note } : {}),
    },
  };
}

async function stageAnnotation(
  ctx: CoordinatorContext,
  pending: PendingImageGrounding,
  selector: ImageRegionSelector,
  responseId: string,
): Promise<boolean> {
  const op = annotationOp(pending, selector);
  if (op.spec.kind !== 'annotate' || anchorRefTargetIds(op.spec.target).some((id) => !ctx.state.boardContext.hasObject(id))) return false;
  const semanticGroupId = pending.semanticGroupId ?? `image-${pending.imageId}`;
  const eventId = await ctx.repo.addEvent(ctx.sessionId, 'board_ops', {
    ops: [op],
    semanticObjectId: semanticGroupId,
    groupLabel: 'Grounded image annotation',
  }, false);
  ctx.state.pendingBoardOps.set(eventId, {
    ops: [op], semanticGroupId, groupLabel: 'Grounded image annotation',
  });
  ctx.state.objectsCreatedThisTurn.add(op.id);
  ctx.sendClient({
    type: 'board_ops',
    ops: [op],
    response_id: responseId,
    event_id: eventId,
    groupLabel: 'Grounded image annotation',
  }, responseId ? identityForResponse(ctx, responseId) : ctx.state.clientIdentity, {
    semanticObjectId: semanticGroupId,
    visualCueId: `image-grounding-${pending.requestId}`,
  });
  const presented = await waitForCheckpointPresentation(ctx, [eventId]);
  if (!presented) ctx.state.pendingBoardOps.delete(eventId);
  return presented;
}

function safeId(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim().slice(0, max);
  return /^[a-z0-9_-]+$/i.test(result) ? result : null;
}
function safeText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim().slice(0, max);
  return result || null;
}
