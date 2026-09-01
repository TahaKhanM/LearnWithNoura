import { z } from 'zod';
import type { BoardOp } from '../../shared/boardOps.js';
import { currentStage } from '../lesson/orchestrator.js';
import { startAnchorStoryboard } from './anchorStoryboard.js';
import { anchorGroupId, preflightWithClient, renderWithClient, stageAndConfirmPlan } from './boardStaging.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import {
  startStoryboardRun,
  storyboardRunSteps,
} from './storyboardRunner.js';
import { startStreamingDirectedScene } from './streamingVisualRequest.js';
import { finishTool } from './turnFloor.js';
import {
  abandonStaleVisualRequest,
  failDirectedScene,
  recordIllustrationMetric,
  recordVisualRequestOutcome,
} from './visualRequestOutcomes.js';

export { anchorHandoff } from './anchorStoryboard.js';

/**
 * The `request_visual` tool: the voice model supplies INTENT, never
 * geometry. The fast tier (emphasize, extend guidance) answers sub-second
 * exactly as before. The slow tier (new scenes and representations) resolves
 * to the pre-compiled anchor when one exists, and otherwise goes to the
 * Board Director asynchronously while the tutor keeps teaching with what is
 * visible; the storyboard runner then reveals the result beat by beat.
 */

export const VisualRequestSchema = z.object({
  schemaVersion: z.literal('3.0.0'),
  requestId: z.string().min(1).max(120),
  action: z.enum(['establish', 'extend', 'emphasize', 'compare', 'none']),
  purpose: z.string().min(1).max(300),
  idea: z.string().min(1).max(300),
  constraints: z.string().max(300).optional(),
  targetGroupId: z.string().min(1).max(160).optional(),
  targetObjectIds: z.array(z.string().min(1).max(160)).max(12).default([]),
  density: z.enum(['minimal', 'standard']),
  noBoardReason: z.string().max(300).optional(),
});
export type VisualRequest = z.infer<typeof VisualRequestSchema>;

export async function handleVisualRequest(
  ctx: CoordinatorContext,
  args: Record<string, unknown>,
  callId: string,
  responseId: string,
): Promise<void> {
  const { state } = ctx;
  const parsed = VisualRequestSchema.safeParse(args);
  if (!parsed.success) {
    finishTool(ctx, callId, responseId, {
      ok: false,
      accepted: false,
      error: `The visual request failed schema validation: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`).join('; ')}`.slice(0, 400),
    });
    return;
  }
  const request = parsed.data;

  if (request.action === 'none') {
    finishTool(ctx, callId, responseId, {
      ok: true,
      accepted: true,
      action: 'none',
      noBoard: true,
      board: state.boardContext.toolSnapshot(),
    });
    return;
  }

  if (request.action === 'extend') {
    // Extensions are small, incremental, and belong in board_ops so they
    // attach to existing visible objects rather than a new scene.
    finishTool(ctx, callId, responseId, {
      ok: true,
      accepted: false,
      action: 'extend',
      reason: 'Extend the visible work with small board_ops increments that reference visible IDs; no new section is created.',
      anchorGroupId: anchorGroupId(ctx),
      board: state.boardContext.toolSnapshot(),
    });
    return;
  }

  if (request.action === 'emphasize') {
    const targets = request.targetObjectIds
      .filter((id) => state.boardContext.hasObject(id))
      .slice(0, 12);
    if (targets.length === 0) {
      finishTool(ctx, callId, responseId, {
        ok: false,
        accepted: false,
        reason: 'Emphasize needs visible target object ids. Inspect the board and name the objects to highlight.',
        board: state.boardContext.toolSnapshot(),
      });
      return;
    }
    const group = state.boardContext.groupOfObject(targets[0]) ?? anchorGroupId(ctx) ?? undefined;
    stageAndConfirmPlan(ctx, callId, responseId, {
      ops: targets.map((id) => ({ op: 'highlight', id } as BoardOp)),
      checkpoints: [{
        id: `emphasize-${responseId}-${targets.join('-')}`.slice(0, 120),
        semanticObjectId: group ?? 'board',
        groupLabel: state.boardContext.groupLabelOf(group) ?? 'Board',
        reveal: 'emphasis',
        ops: targets.map((id) => ({ op: 'highlight', id } as BoardOp)),
      }],
      action: 'emphasize',
      skipPreflight: true,
    });
    return;
  }

  // establish | compare: structural scene work. One build at a time, one
  // plan per tutor turn; the server owns sections and all geometry.
  if (state.storyboardRun) {
    finishTool(ctx, callId, responseId, {
      ok: false,
      accepted: false,
      reason: 'A board build is already in progress. Narrate the beats you are prompted with and wait for it to finish.',
      board: state.boardContext.toolSnapshot(),
    });
    return;
  }
  const planActiveThisTurn = state.planStagedThisTurn && state.visualPlanState !== 'failed';
  if (planActiveThisTurn || state.planAttemptsThisTurn >= 2) {
    finishTool(ctx, callId, responseId, {
      ok: false,
      accepted: false,
      reason: 'One visual plan per teaching turn. Teach with what is on the board now, then wait for the learner.',
      visualPlanState: state.visualPlanState,
      anchorGroupId: anchorGroupId(ctx),
      board: state.boardContext.toolSnapshot(),
    });
    return;
  }
  if (!state.lessonState.blueprint) {
    finishTool(ctx, callId, responseId, {
      ok: false,
      accepted: false,
      reason: 'This lesson has no blueprint loaded; teach conversationally and use small board_ops increments only.',
      board: state.boardContext.toolSnapshot(),
    });
    return;
  }

  const anchor = anchorGroupId(ctx) ?? 'lesson-anchor';
  if (request.action === 'establish') {
    if (state.boardContext.hasGroup(anchor)) {
      finishTool(ctx, callId, responseId, {
        ok: false,
        accepted: false,
        reason: `The anchor section ${anchor} is already on the board. Extend or emphasize it; do not rebuild it.`,
        anchorGroupId: anchor,
        board: state.boardContext.toolSnapshot(),
      });
      return;
    }
    const compiledAnchor = ctx.compiledLesson?.anchorScene;
    if (compiledAnchor && compiledAnchor.groupId === anchor) {
      startAnchorStoryboard(ctx, callId, responseId, request, compiledAnchor);
      return;
    }
  }
  startDirectedScene(ctx, { callId, responseId }, request, anchor);
}

/**
 * True when async visual work that started under `epoch` no longer belongs
 * to the current teaching moment: a genuine learner turn advanced the epoch,
 * or another build took the board. Checked after EVERY await, before any
 * state mutation or run start — stale completions are abandoned explicitly.
 */
function visualRequestIsStale(ctx: CoordinatorContext, epoch: number): boolean {
  return ctx.state.visualRequestEpoch !== epoch || ctx.state.storyboardRun !== null;
}

/**
 * The slow tier. The tool result returns immediately so the voice model
 * keeps teaching with what is visible while the Director designs, renders,
 * and inspects the scene; the reveal begins when it is ready. Failure is a
 * clean, honest note — never a silent stall and never unvalidated geometry.
 */
function startDirectedScene(
  ctx: CoordinatorContext,
  tool: { callId: string; responseId: string } | null,
  request: VisualRequest,
  anchor: string,
): void {
  if (ctx.streamVisual) {
    startStreamingDirectedScene(ctx, tool, request, anchor, {
      directorHandoff: directorHandoff(),
      fallbackToClassic: (sectionId) => startClassicDirectedScene(ctx, null, request, anchor, {
        sectionId,
        alreadyPreparing: true,
      }),
    });
    return;
  }
  startClassicDirectedScene(ctx, tool, request, anchor);
}

function startClassicDirectedScene(
  ctx: CoordinatorContext,
  tool: { callId: string; responseId: string } | null,
  request: VisualRequest,
  anchor: string,
  resume?: { sectionId: string; alreadyPreparing: true },
): void {
  const { state } = ctx;
  const directVisual = ctx.directVisual;
  const startedAt = Date.now();
  const recordOutcome = (status: string, reasons: string[] = []) => {
    recordVisualRequestOutcome(ctx, request, status, Date.now() - startedAt, reasons);
  };
  if (!directVisual) {
    recordOutcome('unavailable');
    if (tool) {
      finishTool(ctx, tool.callId, tool.responseId, {
        ok: false,
        accepted: false,
        reason: 'No scene service is available; the scene-planning service is unavailable in this session. Nothing was drawn. Continue the explanation with what is visible and do not claim that a picture appeared; do not use fast board_ops to improvise a whole replacement scene.',
        board: state.boardContext.toolSnapshot(),
      });
    } else {
      ctx.sendClient({ type: 'illustration_status', status: 'failed' });
      ctx.sendUpstream({
        type: 'conversation.item.create',
        item: {
          type: 'message', role: 'system', content: [{
            type: 'input_text',
            text: '[The learner-requested visual service is unavailable and nothing new will appear.] Continue honestly with what is already visible; do not claim the requested picture appeared.',
          }],
        },
      });
    }
    return;
  }
  if (!resume?.alreadyPreparing) {
    state.planStagedThisTurn = true;
    state.planAttemptsThisTurn += 1;
    state.visualPlanState = 'preparing';
  }
  const visualIntentStartedAtMs = Date.now();
  const sectionId = resume?.sectionId ?? (request.action === 'establish'
    ? anchor
    : `${anchor}-alt${++state.comparisonSectionCounter}`);
  if (tool && !resume?.alreadyPreparing) {
    finishTool(ctx, tool.callId, tool.responseId, {
      ok: true,
      accepted: true,
      status: 'preparing',
      semanticGroupId: sectionId,
      guidance: 'The picture is being designed and checked. Keep teaching naturally about what is already visible — do not say you are waiting, do not describe the new picture, and do not call this tool again. When it is ready the board builds step by step and you will be prompted to narrate each part.',
      board: state.boardContext.toolSnapshot(),
    });
  }
  const stage = currentStage(state.lessonState);
  const epoch = state.visualRequestEpoch;
  const staleAbandon = (totalSteps: number) => {
    // The tutor was told "preparing", so honesty demands the "will not
    // appear" bridge even when the completion is stale — scoped to THIS
    // request, exactly once, never touching the active run's state.
    abandonStaleVisualRequest(ctx, request.requestId, 'director', totalSteps, { injectNote: true });
  };
  let acceptedPreflightFingerprint: string | null = null;
  const task = (async () => {
    const result = await directVisual({
      purpose: request.purpose,
      idea: request.idea,
      constraints: request.constraints ?? null,
      density: request.density,
      targetObjectIds: request.targetObjectIds.filter((id) => state.boardContext.hasObject(id)),
      sectionId,
      sectionLabel: request.idea.slice(0, 160),
      boardSummary: state.boardContext.toolSnapshot().summary,
      visibleObjectIds: state.boardContext.visibleObjectIdList(),
      currentBoardOps: state.boardContext.visibleOps(),
      stageBrief: stage ? `${stage.id} (${stage.kind}) — ${stage.objective}` : `Lesson goal: ${ctx.lessonGoal}`,
      learnerContext: `Lesson goal: ${ctx.lessonGoal}`,
      illustrationHooks: {
        onPreparing: (alt) => ctx.sendClient({ type: 'illustration_status', status: 'preparing', alt }),
        onPartial: (dataUrl, alt) => ctx.sendClient({
          type: 'illustration_status',
          status: 'partial',
          alt,
          partialDataUrl: dataUrl,
        }),
      },
      assetOwner: await resolveAssetOwner(ctx),
      validateScene: async (ops) => {
        const result = await preflightWithClient(ctx, {
          ops,
          semanticGroupId: sectionId,
          groupLabel: request.idea.slice(0, 160),
        });
        if (result.accepted) acceptedPreflightFingerprint = JSON.stringify(ops);
        return result.accepted ? { ok: true } : { ok: false, issues: result.reasons };
      },
      renderScene: (ops, semanticGroupId) => renderWithClient(ctx, ops, semanticGroupId),
    });
    recordIllustrationMetric(ctx, result.illustration);
    if (visualRequestIsStale(ctx, epoch)) {
      recordOutcome('stale');
      staleAbandon(result.ok ? result.scene.storyboard.length : 0);
      return;
    }
    if (result.ok === false) {
      recordOutcome('director_rejected', result.reasons);
      failDirectedScene(ctx, result.reasons);
      return;
    }
    const scene = result.scene;
    const equivalent = state.boardContext.equivalentTutorScene(scene.ops);
    if (equivalent.equivalent) {
      recordOutcome('equivalent');
      failDirectedScene(ctx, ['An equivalent visual is already visible on the board; reuse its objects instead.']);
      return;
    }
    // Production Directors validate each candidate through the request-bound
    // browser port. Scripted/legacy BoardDirector implementations may not;
    // keep one final fail-closed preflight only when the exact returned scene
    // lacks evidence, avoiding the former duplicate browser round-trip.
    if (acceptedPreflightFingerprint !== JSON.stringify(scene.ops)) {
      const preflight = await preflightWithClient(ctx, {
        ops: scene.ops,
        semanticGroupId: scene.groupId,
        groupLabel: scene.groupLabel,
      });
      if (visualRequestIsStale(ctx, epoch)) {
        recordOutcome('stale');
        staleAbandon(scene.storyboard.length);
        return;
      }
      if (!preflight.accepted) {
        recordOutcome('client_rejected', preflight.reasons);
        failDirectedScene(ctx, preflight.reasons.length > 0 ? preflight.reasons : ['The scene failed the deterministic layout preflight.']);
        return;
      }
    }
    // Persisted so a reconnect can rebuild and resume the run.
    const runId = `run-${request.requestId}`.slice(0, 120);
    await ctx.repo.addEvent(ctx.sessionId, 'directed_scene', { runId, scene });
    if (visualRequestIsStale(ctx, epoch)) {
      // The dangling directed_scene event is harmless: restores only
      // follow an ACTIVE storyboard_progress run, which never started.
      recordOutcome('stale');
      staleAbandon(scene.storyboard.length);
      return;
    }
    state.visualPlanState = 'rendering';
    if (request.action === 'establish' && !state.lessonState.activeSemanticObjectId) {
      state.lessonState = { ...state.lessonState, activeSemanticObjectId: scene.groupId };
    }
    recordOutcome('ready');
    ctx.sendClient({ type: 'illustration_status', status: 'ready' });
    const floorBusy = state.childHoldsFloor || state.speechInProgress || state.draftOpen;
    startStoryboardRun(ctx, {
      runId,
      source: 'director',
      groupId: scene.groupId,
      groupLabel: scene.groupLabel,
      steps: storyboardRunSteps(scene),
      revealAfterResponseId: floorBusy ? null : state.activeResponseId ?? state.lastCompletedResponseId,
      firstBeatFraming: request.action === 'compare'
        ? [`A new board section called “${scene.groupLabel}” was just added beside the current work; the learner's view does not switch by itself. Tell the learner it is there and where to look before this beat.`]
        : [],
      handoff: directorHandoff(),
      visualIntentStartedAtMs,
    });
  })().catch((error) => {
    ctx.log(`session ${ctx.sessionId}: directed scene error ${String(error).slice(0, 200)}`);
    if (visualRequestIsStale(ctx, epoch)) {
      recordOutcome('stale');
      staleAbandon(0);
      return;
    }
    recordOutcome('error', [String(error).slice(0, 160)]);
    failDirectedScene(ctx, [String(error).slice(0, 260)]);
  });
  ctx.trackSideEffect(task);
}

export function directorHandoff(): string {
  return 'Then connect the picture to what you were teaching in one short sentence, and ask the learner one small, concrete question about what they can see, delivered via propose_teaching_move with the exact wording as questionOrTask. Stop after asking.';
}

async function resolveAssetOwner(
  ctx: CoordinatorContext,
): Promise<{ parentId?: string; sessionId: string }> {
  const session = await ctx.repo.getSession(ctx.sessionId);
  const child = session ? await ctx.repo.getChild(session.childId) : null;
  return {
    sessionId: ctx.sessionId,
    ...(child?.parentId ? { parentId: child.parentId } : {}),
  };
}
