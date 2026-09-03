import type { AddOp, BoardOp } from '../../shared/boardOps.js';
import {
  decideIllustrationArrival,
  generationsSpent,
  ILLUSTRATION_GENERATION_BUDGET,
} from '../board/illustrationArrival.js';
import type { IllustrationBrief, IllustrationPrepareOk } from '../board/illustration.js';
import { persistIllustrationRecord } from '../board/illustration.js';
import { preflightWithClient, stageServerInitiatedCheckpoint } from './boardStaging.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import {
  appendStoryboardRunStep,
  closeStoryboardRunIntake,
  type StoryboardRunStep,
} from './storyboardRunner.js';
import { sendResponseCreate, tutorFloorIsFree } from './turnFloor.js';
import { recordIllustrationMetric } from './visualRequestOutcomes.js';

const ILLUSTRATION_FAIL_NOTE = '[The illustration will not appear.] Keep teaching with the overlay marks that are already visible; do not describe a picture that is not on the board.';
const ILLUSTRATION_ARRIVED_NOTE = '[An illustration just arrived on the board.] Refer to it only from the current board snapshot; do not claim it appeared earlier.';

export interface PendingIllustrationLane {
  runId: string;
  groupId: string;
  groupLabel: string;
  overlayOps: BoardOp[];
  overlayComplete: boolean;
  prepare: 'pending' | 'ok' | 'fail';
  prepared: IllustrationPrepareOk | null;
  epoch: number;
}

export function startIllustrationLane(ctx: CoordinatorContext, input: {
  runId: string;
  groupId: string;
  groupLabel: string;
  overlayOps: BoardOp[];
  overlayComplete: boolean;
  brief: IllustrationBrief;
  epoch: number;
  assetOwner?: { parentId?: string; sessionId?: string };
}): void {
  const port = ctx.illustrations;
  if (!port?.enabled) {
    noteIllustrationFailure(ctx, ['illustrations_unavailable']);
    return;
  }
  ctx.state.pendingIllustration = {
    runId: input.runId,
    groupId: input.groupId,
    groupLabel: input.groupLabel,
    overlayOps: input.overlayOps,
    overlayComplete: input.overlayComplete,
    prepare: 'pending',
    prepared: null,
    epoch: input.epoch,
  };
  const remaining = ILLUSTRATION_GENERATION_BUDGET - ctx.state.illustrationGenerationsUsed;
  const task = (async () => {
    const session = await ctx.repo.getSession(ctx.sessionId);
    const child = session ? await ctx.repo.getChild(session.childId) : null;
    const assetOwner = input.assetOwner ?? {
      sessionId: ctx.sessionId,
      ...(child?.parentId ? { parentId: child.parentId } : {}),
    };
    const result = await port.prepare(input.brief, {
      onPreparing: (alt) => ctx.sendClient({ type: 'illustration_status', status: 'preparing', alt }),
      onPartial: (dataUrl, alt) => ctx.sendClient({
        type: 'illustration_status',
        status: 'partial',
        alt,
        partialDataUrl: dataUrl,
      }),
    }, { generationBudgetRemaining: remaining });
    recordIllustrationMetric(ctx, result);
    ctx.state.illustrationGenerationsUsed += generationsSpent(result);
    const lane = ctx.state.pendingIllustration;
    if (!lane || lane.runId !== input.runId || lane.epoch !== ctx.state.visualRequestEpoch) return;
    if (result.ok === false) {
      lane.prepare = 'fail';
      settleIllustrationLane(ctx);
      return;
    }
    if (port.persist) await port.persist(result, assetOwner);
    else if (port.store) await persistIllustrationRecord(port.store, result, assetOwner);
    if (ctx.state.pendingIllustration?.runId !== input.runId) return;
    ctx.state.pendingIllustration.prepare = 'ok';
    ctx.state.pendingIllustration.prepared = result;
    settleIllustrationLane(ctx);
  })().catch((error) => {
    ctx.log(`session ${ctx.sessionId}: illustration lane failed ${String(error).slice(0, 200)}`);
    const lane = ctx.state.pendingIllustration;
    if (!lane || lane.runId !== input.runId) return;
    lane.prepare = 'fail';
    settleIllustrationLane(ctx);
  });
  ctx.trackSideEffect(task);
  if (input.overlayComplete) settleIllustrationLane(ctx);
}

export function markIllustrationOverlaysComplete(ctx: CoordinatorContext, runId: string): void {
  const lane = ctx.state.pendingIllustration;
  if (!lane || lane.runId !== runId) return;
  lane.overlayComplete = true;
  settleIllustrationLane(ctx);
}

function settleIllustrationLane(ctx: CoordinatorContext): void {
  const lane = ctx.state.pendingIllustration;
  if (!lane) return;
  if (lane.epoch !== ctx.state.visualRequestEpoch) {
    ctx.state.pendingIllustration = null;
    return;
  }
  const run = ctx.state.storyboardRun;
  const runActiveForRequest = Boolean(run && run.runId === lane.runId);
  const decision = decideIllustrationArrival({
    runActiveForRequest,
    overlayComplete: lane.overlayComplete,
    prepare: lane.prepare,
  });
  if (decision.action === 'wait') return;
  if (decision.action === 'fail_honest') {
    ctx.state.pendingIllustration = null;
    noteIllustrationFailure(ctx, ['illustration_prepare_failed']);
    if (runActiveForRequest && run?.streamOpen) closeStoryboardRunIntake(ctx, lane.runId);
    return;
  }
  const prepared = lane.prepared;
  if (!prepared) return;
  ctx.state.pendingIllustration = null;
  const step = illustrationRevealStep(prepared);
  if (decision.action === 'append_final_step') {
    ctx.trackSideEffect(arriveAsFinalStep(ctx, lane, step));
    return;
  }
  ctx.trackSideEffect(arriveAsCheckpoint(ctx, lane, step, true));
}

async function arriveAsFinalStep(
  ctx: CoordinatorContext,
  lane: PendingIllustrationLane,
  step: StoryboardRunStep,
): Promise<void> {
  const accepted = await preflightImage(ctx, lane, step.ops);
  if (!accepted) {
    noteIllustrationFailure(ctx, ['illustration_preflight_failed']);
    const run = ctx.state.storyboardRun;
    if (run?.runId === lane.runId && run.streamOpen) closeStoryboardRunIntake(ctx, lane.runId);
    return;
  }
  const run = ctx.state.storyboardRun;
  if (!run || run.runId !== lane.runId || run.handoffResponseId !== null) {
    await arriveAsCheckpoint(ctx, lane, step, false);
    return;
  }
  const wasStreamOpen = run.streamOpen;
  run.streamOpen = true;
  if (!appendStoryboardRunStep(ctx, lane.runId, step)) {
    run.streamOpen = wasStreamOpen;
    await arriveAsCheckpoint(ctx, lane, step, false);
    return;
  }
  closeStoryboardRunIntake(ctx, lane.runId);
  ctx.sendClient({ type: 'illustration_status', status: 'ready' });
}

async function arriveAsCheckpoint(
  ctx: CoordinatorContext,
  lane: PendingIllustrationLane,
  step: StoryboardRunStep,
  preflight: boolean,
): Promise<void> {
  if (preflight) {
    const accepted = await preflightImage(ctx, lane, step.ops);
    if (!accepted) {
      noteIllustrationFailure(ctx, ['illustration_preflight_failed']);
      return;
    }
  }
  const shown = await stageServerInitiatedCheckpoint(ctx, {
    ops: step.ops,
    groupId: lane.groupId,
    groupLabel: lane.groupLabel,
    checkpointId: step.id,
    reveal: 'outline',
  });
  if (!shown) {
    noteIllustrationFailure(ctx, ['illustration_visibility_failed']);
    return;
  }
  ctx.sendClient({ type: 'illustration_status', status: 'ready' });
  ctx.sendUpstream({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: ILLUSTRATION_ARRIVED_NOTE }],
    },
  });
  if (tutorFloorIsFree(ctx)) sendResponseCreate(ctx, 'board');
}

async function preflightImage(
  ctx: CoordinatorContext,
  lane: PendingIllustrationLane,
  imageOps: BoardOp[],
): Promise<boolean> {
  const result = await preflightWithClient(ctx, {
    ops: [...lane.overlayOps, ...imageOps],
    semanticGroupId: lane.groupId,
    groupLabel: lane.groupLabel,
  });
  return result.accepted;
}

function illustrationRevealStep(prepared: IllustrationPrepareOk): StoryboardRunStep {
  const imageOp: AddOp = { op: 'add', id: prepared.objectId, spec: prepared.spec };
  return {
    id: `illust-arrive-${prepared.objectId}`.slice(0, 120),
    reveal: 'outline',
    narration: 'Look at the picture — it shows the idea we asked for.',
    objectIds: [prepared.objectId],
    ops: [imageOp],
  };
}

function noteIllustrationFailure(ctx: CoordinatorContext, reasons: string[]): void {
  ctx.log(`session ${ctx.sessionId}: illustration failed ${reasons.join('; ').slice(0, 200)}`);
  ctx.sendClient({ type: 'illustration_status', status: 'failed' });
  ctx.sendUpstream({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: ILLUSTRATION_FAIL_NOTE }],
    },
  });
  if (tutorFloorIsFree(ctx)) sendResponseCreate(ctx, 'tool');
}

export function illustrationBriefFromStreamHeader(illustration: {
  purpose: string;
  subject: string;
  style: string | null;
  requiredElements: string[];
  forbiddenElements: string[];
  alt: string | null;
}): IllustrationBrief {
  return {
    purpose: illustration.purpose,
    subject: illustration.subject,
    requiredElements: illustration.requiredElements,
    forbiddenElements: illustration.forbiddenElements,
    ...(illustration.style ? { style: illustration.style } : {}),
    ...(illustration.alt ? { alt: illustration.alt } : {}),
  };
}
