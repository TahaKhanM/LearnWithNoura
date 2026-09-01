import type { AnchorScene } from '../../shared/compiledLesson.js';
import { currentStage } from '../lesson/orchestrator.js';
import { preflightWithClient } from './boardStaging.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import { refreshBoardInstructions } from './sessionConfig.js';
import { startStoryboardRun, storyboardRunSteps } from './storyboardRunner.js';
import { finishTool } from './turnFloor.js';
import { abandonStaleVisualRequest } from './visualRequestOutcomes.js';

/**
 * Preflights and reveals a compiled anchor scene without allowing the voice
 * model to invent geometry. The tool response is held for the storyboard
 * runner, which owns every narration beat after acceptance.
 */
export function startAnchorStoryboard(
  ctx: CoordinatorContext,
  callId: string,
  responseId: string,
  request: { requestId: string },
  scene: AnchorScene,
): void {
  const { state } = ctx;
  const visualIntentStartedAtMs = Date.now();
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
      visualIntentStartedAtMs,
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

function visualRequestIsStale(ctx: CoordinatorContext, epoch: number): boolean {
  return ctx.state.visualRequestEpoch !== epoch || ctx.state.storyboardRun !== null;
}
