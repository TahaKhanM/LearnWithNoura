import { z } from 'zod';
import type { BoardOp } from '../../shared/boardOps.js';
import type { AnchorScene } from '../../shared/compiledLesson.js';
import { TELEMETRY_SCHEMA_VERSION } from '../../shared/sessionTelemetry.js';
import { currentStage } from '../lesson/orchestrator.js';
import { metricContextFromIdentity } from '../session/telemetryRecorder.js';
import { anchorGroupId, preflightWithClient, stageAndConfirmPlan } from './boardStaging.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import { addBounded } from './responseRegistry.js';
import { refreshBoardInstructions } from './sessionConfig.js';
import { startStoryboardRun, storyboardRunSteps, type StoryboardSource } from './storyboardRunner.js';
import { finishTool, sendResponseCreate, tutorFloorIsFree } from './turnFloor.js';

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
  startDirectedScene(ctx, callId, responseId, request, anchor);
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
 * Explicit scoped abandonment of a stale completion (High 1/High 2 of the
 * Phase 3a review). Scoped to THAT request: the active turn's plan state and
 * any running build are untouched, the honest note fires at most once per
 * request, and no response is created — a conversation item cannot interrupt
 * an active beat; the note simply contextualizes whatever speaks next.
 */
function abandonStaleVisualRequest(
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
        text: '[The visual you asked for earlier could not be prepared in time and will not appear.] The lesson has moved on \u2014 keep teaching with what is visible now and do not mention that picture.',
      }],
    },
  });
}

/**
 * Establish resolves to the pre-compiled, pre-validated anchor scene: the
 * voice model triggers the build but never invents the geometry. The whole
 * scene is preflighted fail-closed, then the runner reveals it step by step
 * with a narration beat between reveals. The tool result deliberately does
 * NOT continue the response: the beats are the continuation.
 */
function startAnchorStoryboard(
  ctx: CoordinatorContext,
  callId: string,
  responseId: string,
  request: VisualRequest,
  scene: AnchorScene,
): void {
  const { state } = ctx;
  state.planStagedThisTurn = true;
  state.planAttemptsThisTurn += 1;
  state.visualPlanState = 'preparing';
  const epoch = state.visualRequestEpoch;
  const staleAbandon = () => {
    // A learner turn completed (or another build started) while the
    // preflight was in flight: nothing may build mid-turn. The tool result
    // is still pending, so IT is the honest channel — no system note.
    abandonStaleVisualRequest(ctx, request.requestId, 'anchor', scene.storyboard.length, { injectNote: false });
    finishTool(ctx, callId, responseId, {
      ok: false,
      accepted: false,
      reason: 'The lesson moved on before the scene was ready; nothing was drawn. If the visual is still needed, request it again in your next teaching turn.',
    }, { continueResponse: false });
  };
  const addOps = scene.ops.filter((op) => op.op === 'add');
  const task = (async () => {
    const preflight = await preflightWithClient(ctx, {
      ops: addOps,
      semanticGroupId: scene.groupId,
      groupLabel: scene.groupLabel,
    });
    if (visualRequestIsStale(ctx, epoch)) {
      staleAbandon();
      return;
    }
    if (!preflight.accepted) {
      state.visualPlanState = 'failed';
      state.boardContext.observeBoardRejection(preflight.reasons.join('; ').slice(0, 300) || 'Complete-plan preflight failed.');
      refreshBoardInstructions(ctx);
      finishTool(ctx, callId, responseId, {
        ok: false,
        accepted: false,
        reason: `The scene failed deterministic layout preflight: ${preflight.reasons.join('; ').slice(0, 240)}. Nothing was drawn. Continue without the visual.`,
        board: state.boardContext.toolSnapshot(),
      });
      return;
    }
    // Recheck at first-beat scheduling: speech may have started after the
    // post-await stale check and before the run is armed.
    if (visualRequestIsStale(ctx, epoch)) {
      staleAbandon();
      return;
    }
    state.visualPlanState = 'rendering';
    const steps = storyboardRunSteps(scene);
    finishTool(ctx, callId, responseId, {
      ok: true,
      accepted: true,
      status: 'building',
      semanticGroupId: scene.groupId,
      storyboard: steps.map((step) => ({ id: step.id, reveal: step.reveal, narration: step.narration })),
      guidance: 'The pre-validated scene now appears step by step. The application will prompt you to narrate each beat as its objects appear — do not describe the scene yet and do not call this tool again.',
    }, { continueResponse: false });
    // An unconfirmed speech blip is not a learner turn (the epoch has not
    // moved), but the first reveal must still not land mid-speech: with no
    // safe boundary to bind to, it waits for a genuinely free floor.
    const floorBusy = state.childHoldsFloor || state.speechInProgress || state.draftOpen;
    startStoryboardRun(ctx, {
      runId: `run-${responseId}`.slice(0, 120),
      source: 'anchor',
      groupId: scene.groupId,
      groupLabel: scene.groupLabel,
      steps,
      revealAfterResponseId: floorBusy ? null : responseId,
      handoff: anchorHandoff(ctx),
    });
  })().catch((error) => {
    ctx.log(`session ${ctx.sessionId}: anchor storyboard staging error ${String(error).slice(0, 200)}`);
    if (visualRequestIsStale(ctx, epoch)) {
      staleAbandon();
      return;
    }
    state.visualPlanState = 'failed';
    finishTool(ctx, callId, responseId, { ok: false, accepted: false, error: String(error).slice(0, 260) });
  });
  ctx.trackSideEffect(task);
}

/**
 * The slow tier. The tool result returns immediately so the voice model
 * keeps teaching with what is visible while the Director designs, renders,
 * and inspects the scene; the reveal begins when it is ready. Failure is a
 * clean, honest note — never a silent stall and never unvalidated geometry.
 */
function startDirectedScene(
  ctx: CoordinatorContext,
  callId: string,
  responseId: string,
  request: VisualRequest,
  anchor: string,
): void {
  const { state } = ctx;
  const directVisual = ctx.directVisual;
  if (!directVisual) {
    finishTool(ctx, callId, responseId, {
      ok: false,
      accepted: false,
      reason: 'No scene service is available for new visuals in this session. Call board_ops now with the first objects — a blank board is allowed. Do not tell the learner you cannot draw.',
      board: state.boardContext.toolSnapshot(),
    });
    return;
  }
  state.planStagedThisTurn = true;
  state.planAttemptsThisTurn += 1;
  state.visualPlanState = 'preparing';
  const sectionId = request.action === 'establish'
    ? anchor
    : `${anchor}-alt${++state.comparisonSectionCounter}`;
  finishTool(ctx, callId, responseId, {
    ok: true,
    accepted: true,
    status: 'preparing',
    semanticGroupId: sectionId,
    guidance: 'The picture is being designed and checked. Keep teaching naturally about what is already visible — do not say you are waiting, do not describe the new picture, and do not call this tool again. When it is ready the board builds step by step and you will be prompted to narrate each part.',
    board: state.boardContext.toolSnapshot(),
  });
  const stage = currentStage(state.lessonState);
  const epoch = state.visualRequestEpoch;
  const staleAbandon = (totalSteps: number) => {
    // The tutor was told "preparing", so honesty demands the "will not
    // appear" bridge even when the completion is stale — scoped to THIS
    // request, exactly once, never touching the active run's state.
    abandonStaleVisualRequest(ctx, request.requestId, 'director', totalSteps, { injectNote: true });
  };
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
    });
    recordIllustrationMetric(ctx, result.illustration);
    if (visualRequestIsStale(ctx, epoch)) {
      staleAbandon(result.ok ? result.scene.storyboard.length : 0);
      return;
    }
    if (!result.ok) {
      failDirectedScene(ctx, result.reasons);
      return;
    }
    const scene = result.scene;
    const equivalent = state.boardContext.equivalentTutorScene(scene.ops);
    if (equivalent.equivalent) {
      failDirectedScene(ctx, ['An equivalent visual is already visible on the board; reuse its objects instead.']);
      return;
    }
    const preflight = await preflightWithClient(ctx, {
      ops: scene.ops,
      semanticGroupId: scene.groupId,
      groupLabel: scene.groupLabel,
    });
    if (visualRequestIsStale(ctx, epoch)) {
      staleAbandon(scene.storyboard.length);
      return;
    }
    if (!preflight.accepted) {
      failDirectedScene(ctx, preflight.reasons.length > 0 ? preflight.reasons : ['The scene failed the deterministic layout preflight.']);
      return;
    }
    // Persisted so a reconnect can rebuild and resume the run.
    const runId = `run-${request.requestId}`.slice(0, 120);
    await ctx.repo.addEvent(ctx.sessionId, 'directed_scene', { runId, scene });
    if (visualRequestIsStale(ctx, epoch)) {
      // The dangling directed_scene event is harmless: restores only
      // follow an ACTIVE storyboard_progress run, which never started.
      staleAbandon(scene.storyboard.length);
      return;
    }
    state.visualPlanState = 'rendering';
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
    });
  })().catch((error) => {
    ctx.log(`session ${ctx.sessionId}: directed scene error ${String(error).slice(0, 200)}`);
    if (visualRequestIsStale(ctx, epoch)) {
      staleAbandon(0);
      return;
    }
    failDirectedScene(ctx, [String(error).slice(0, 260)]);
  });
  ctx.trackSideEffect(task);
}

/** Fail closed with an honest bridge: the tutor was told the visual was
 * being prepared, so it must also hear that it will not appear. */
function recordIllustrationMetric(
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

function failDirectedScene(ctx: CoordinatorContext, reasons: string[]): void {
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
        text: '[The requested visual could not be prepared and will not appear.] Continue teaching with what is visible now; do not mention the failed picture. If a visual is still essential, request one simpler alternative after the learner\u2019s next turn.',
      }],
    },
  });
  if (tutorFloorIsFree(ctx)) sendResponseCreate(ctx, 'tool');
}

/** The closing move of an anchor build delivers the stage's check through
 * the existing delivered-task contract; handoff responses replace the
 * session instructions, so the exact wording rides inside these lines. */
export function anchorHandoff(ctx: CoordinatorContext): string {
  const stage = currentStage(ctx.state.lessonState);
  const check = stage?.checks?.[0];
  if (check) {
    const targets = check.targetObjectIds?.length ? ` and targetObjectIds ${JSON.stringify(check.targetObjectIds)}` : '';
    return `Then hand the learner this stage's check task: call propose_teaching_move with questionOrTask exactly "${check.questionOrTask}" (taskId "${check.id}", responseMode "${check.responseMode}"${targets}, proposedAction "question") and ask it aloud in those words. Stop after asking.`;
  }
  return 'Then invite the learner into the picture with one small, concrete question about what they can see, delivered via propose_teaching_move with the exact wording as questionOrTask. Stop after asking.';
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
