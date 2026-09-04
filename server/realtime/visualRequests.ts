import { z } from 'zod';
import type { BoardOp } from '../../shared/boardOps.js';
import { currentStage } from '../lesson/orchestrator.js';
import { startAnchorStoryboard, startTemplateStoryboard } from './anchorStoryboard.js';
import { anchorGroupId, preflightWithClient, renderWithClient, stageAndConfirmPlan } from './boardStaging.js';
import { extractIntentTemplateScene } from '../board/templateLane.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import {
  abandonStoryboardRun,
  startStoryboardRun,
  storyboardRunSteps,
} from './storyboardRunner.js';
import { startStreamingDirectedScene } from './streamingVisualRequest.js';
import { startIllustrationLane } from './illustrationLane.js';
import { finishTool } from './turnFloor.js';
import {
  abandonStaleVisualRequest,
  failDirectedScene,
  recordVisualRequestOutcome,
} from './visualRequestOutcomes.js';
import { formatRealtimeIncident } from './incidentLogging.js';

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

const EXPLICIT_VISUAL_NOUN = /\b(?:number\s*line|graph|diagram|picture|drawing|sketch|shape|triangle|circle|polygon|chart|table|timeline|fraction\s*(?:bar|strip|model)|array|ten[- ]frame|coordinate\s*(?:plane|grid)|axis|axes|model)\b/i;
const EXPLICIT_VISUAL_VERB = /\b(?:draw|sketch|plot|diagram|illustrate|visuali[sz]e)\b/i;
const REQUESTED_VISUAL_VERB = /(?:^|\b)(?:please\s+)?(?:can|could|would|will)\s+(?:you\s+)?(?:please\s+)?(?:draw|sketch|plot|show|make|create|add|put)|\bplease\s+(?:draw|sketch|plot|show|make|create|add|put)\b|(?:^|[.!?;:—-]\s*)(?:please\s+)?(?:draw|sketch|plot|show|make|create|add|put)\b/i;
const REQUESTED_VISUAL_DESIRE = /\b(?:i\s+(?:want|need|would\s+like)|we\s+(?:want|need))\b/i;
const SECONDARY_VISUAL = /\b(?:second|another|alternative|instead|compare|beside|side[- ]by[- ]side)\b/i;

/**
 * Conservative command routing for an explicit learner-requested picture.
 * This is deliberately narrower than general visual helpfulness: it catches
 * direct requests for a structural representation while ordinary pedagogy
 * remains with the realtime tutor. Once matched, the application—not prompt
 * compliance—owns creating a tracked, validated Director request.
 */
export function explicitVisualRequestFromText(
  text: string,
  requestKey: string,
  boardHasVisibleObjects: boolean,
): VisualRequest | null {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 2_000);
  if (!clean) return null;
  const visualNoun = EXPLICIT_VISUAL_NOUN.test(clean);
  const directVisualVerb = EXPLICIT_VISUAL_VERB.test(clean);
  const requested = REQUESTED_VISUAL_VERB.test(clean)
    || (REQUESTED_VISUAL_DESIRE.test(clean) && visualNoun);
  if (!requested || (!visualNoun && !directVisualVerb)) return null;
  const action = boardHasVisibleObjects || SECONDARY_VISUAL.test(clean)
    ? 'compare' as const
    : 'establish' as const;
  return {
    schemaVersion: '3.0.0',
    requestId: `learner-${requestKey}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120),
    action,
    purpose: 'Honor the learner’s explicit request for a visual representation.',
    idea: clean.slice(0, 300),
    constraints: clean.slice(0, 300),
    targetObjectIds: [],
    density: 'standard',
  };
}

/** Records and contextualizes an explicit command before response.create.
 * Any older storyboard is superseded, but its revealed marks remain. */
export function prepareExplicitLearnerVisualRequest(
  ctx: CoordinatorContext,
  text: string,
  requestKey: string,
): VisualRequest | null {
  const request = explicitVisualRequestFromText(
    text,
    requestKey,
    ctx.state.boardContext.visibleObjectIdList().length > 0,
  );
  if (!request) return null;
  if (ctx.state.storyboardRun) {
    abandonStoryboardRun(ctx, {
      injectNote: false,
      stage: 'visual_request',
      reason: 'superseded_by_explicit_learner_request',
    });
  }
  const persisted = Promise.resolve(ctx.repo.addEvent(ctx.sessionId, 'learner_visual_request', {
    requestId: request.requestId,
    action: request.action,
    text: text.slice(0, 2_000),
    status: 'accepted',
  })).then(() => undefined).catch((error) => {
    ctx.log(`session ${ctx.sessionId}: learner visual request audit failed ${String(error).slice(0, 160)}`);
  });
  ctx.trackSideEffect(persisted);
  ctx.sendUpstream({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [{
        type: 'input_text',
        text: `[The learner explicitly requested this visual: “${text.slice(0, 300)}”] The application accepted it and is preparing a new validated board section. Acknowledge the learner briefly and keep teaching with what is visible. Do not call request_visual for this request, do not resume an older storyboard, and do not claim the new picture is visible until the application prompts its narration beats.`,
      }],
    },
  });
  return request;
}

/** Starts the application-owned Director request after the genuine learner
 * turn reset. No model tool call is required or synthesized. */
export function scheduleExplicitLearnerVisualRequest(
  ctx: CoordinatorContext,
  request: VisualRequest,
): void {
  if (ctx.state.storyboardRun) {
    abandonStoryboardRun(ctx, {
      injectNote: false,
      stage: 'visual_request',
      reason: 'superseded_before_explicit_schedule',
    });
  }
  if (ctx.state.planStagedThisTurn || ctx.state.planAttemptsThisTurn >= 2) return;
  const anchor = anchorGroupId(ctx) ?? 'lesson-anchor';
  startDirectedScene(ctx, null, request, anchor);
}

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
    logVisualToolRejection(ctx, request, callId, responseId, 'build_in_progress');
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
    logVisualToolRejection(ctx, request, callId, responseId, 'one_plan_per_turn');
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
  const anchor = anchorGroupId(ctx) ?? 'lesson-anchor';
  if (request.action === 'establish') {
    if (state.boardContext.hasGroup(anchor)) {
      logVisualToolRejection(ctx, request, callId, responseId, 'anchor_already_present');
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

function logVisualToolRejection(
  ctx: CoordinatorContext,
  request: VisualRequest,
  callId: string,
  responseId: string,
  reason: 'build_in_progress' | 'one_plan_per_turn' | 'anchor_already_present',
): void {
  ctx.log(formatRealtimeIncident('visual_tool_rejected', {
    sessionId: ctx.sessionId,
    requestId: request.requestId,
    callId,
    responseId,
    action: request.action,
    stage: 'request_visual',
    reason,
    planAttempts: ctx.state.planAttemptsThisTurn,
  }));
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
  const templateSectionId = request.action === 'establish'
    ? anchor
    : `${anchor}-alt${ctx.state.comparisonSectionCounter + 1}`;
  const templateScene = extractIntentTemplateScene({
    idea: request.idea,
    constraints: request.constraints ?? null,
    sectionId: templateSectionId,
  });
  if (templateScene) {
    if (request.action === 'compare') ctx.state.comparisonSectionCounter += 1;
    startTemplateStoryboard(ctx, tool, request, templateScene, directorHandoff());
    return;
  }
  if (ctx.streamVisual) {
    startStreamingDirectedScene(ctx, tool, request, anchor, {
      directorHandoff: directorHandoff(),
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
      guidance: 'A visual is being designed and checked. Keep teaching what is already visible — do not say you are waiting, do not describe a picture that is not yet on the board, and do not call this tool again. Overlay marks may appear first; narrate only the beats the application supplies.',
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
      assetOwner: await resolveAssetOwner(ctx),
      validateScene: async (ops) => {
        const result = await preflightWithClient(ctx, {
          ops,
          semanticGroupId: sectionId,
          groupLabel: request.idea.slice(0, 160),
        });
        if (result.accepted) acceptedPreflightFingerprint = JSON.stringify(ops);
        return result.accepted
          ? { ok: true }
          : { ok: false, issues: result.reasons, layoutIssues: result.layoutIssues };
      },
      renderScene: (ops, semanticGroupId) => renderWithClient(ctx, ops, semanticGroupId),
    });
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
    if (!result.illustrationBrief) {
      ctx.sendClient({ type: 'illustration_status', status: 'ready' });
    }
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
    if (result.illustrationBrief) {
      startIllustrationLane(ctx, {
        runId,
        groupId: scene.groupId,
        groupLabel: scene.groupLabel,
        overlayOps: scene.ops,
        overlayComplete: true,
        brief: result.illustrationBrief,
        epoch,
        assetOwner: await resolveAssetOwner(ctx),
      });
    }
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
