import type { GenerationIdentity } from '../../shared/runtimeProtocol.js';
import type { VisionAuditEvent } from '../board/visionAudit.js';
import { StreamingDirectorPrecommitError } from '../board/streamingDirector.js';
import { currentStage } from '../lesson/orchestrator.js';
import { createAdaptiveVisionAuditGate, type AdaptiveVisionAuditGate } from './adaptiveVisionAuditGate.js';
import { preflightWithClient, renderWithClient } from './boardStaging.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import {
  abandonStoryboardRun,
  appendStoryboardRunStep,
  closeStoryboardRunIntake,
  startStoryboardRun,
} from './storyboardRunner.js';
import { streamedStepDuplicateReasons } from './streamingVisualPolicy.js';
import { finishTool } from './turnFloor.js';
import type { VisualRequest } from './visualRequests.js';
import {
  abandonStaleVisualRequest,
  failDirectedScene,
  recordVisualRequestOutcome,
} from './visualRequestOutcomes.js';
import { recordDirectorStreamFirstOp, recordVisionAuditOutcome } from './visualTelemetry.js';

type VisualToolCall = { callId: string; responseId: string } | null;

interface StreamingVisualRequestOptions {
  directorHandoff: string;
  fallbackToClassic(sectionId: string): void;
}

export function visionAuditTelemetryInput(
  event: VisionAuditEvent,
  identity: GenerationIdentity | null,
) {
  return {
    startedAtMs: event.startedAtMs,
    model: event.model,
    reasoningEffort: event.reasoningEffort,
    outcome: event.outcome,
    identity,
  };
}

/**
 * Owns one incremental Director request from composition through durable
 * storyboard intake. The classic fallback is injected by the caller so this
 * module remains independent of the visual-request router at runtime.
 */
export function startStreamingDirectedScene(
  ctx: CoordinatorContext,
  tool: VisualToolCall,
  request: VisualRequest,
  anchor: string,
  options: StreamingVisualRequestOptions,
): void {
  const { state } = ctx;
  const streamVisual = ctx.streamVisual;
  if (!streamVisual) return;
  state.activeVisualRequestAbortController?.abort('new visual request');
  const controller = new AbortController();
  state.activeVisualRequestAbortController = controller;
  state.planStagedThisTurn = true;
  state.planAttemptsThisTurn += 1;
  state.visualPlanState = 'preparing';
  const startedAt = Date.now();
  const visualIntentStartedAtMs = Date.now();
  const timingIdentity = state.clientIdentity ? { ...state.clientIdentity } : null;
  const epoch = state.visualRequestEpoch;
  const sectionId = request.action === 'establish'
    ? anchor
    : `${anchor}-alt${++state.comparisonSectionCounter}`;
  const runId = `run-${request.requestId}`.slice(0, 120);
  let intakeStarted = false;
  const auditGateRef: { current: AdaptiveVisionAuditGate | null } = { current: null };
  let auditRejected = false;
  let runnerAbandoned = false;
  const recordOutcome = (status: string, reasons: string[] = []) => {
    recordVisualRequestOutcome(ctx, request, status, Date.now() - startedAt, reasons);
  };
  if (tool) {
    finishTool(ctx, tool.callId, tool.responseId, {
      ok: true,
      accepted: true,
      status: 'preparing',
      semanticGroupId: sectionId,
      guidance: 'The validated picture will arrive step by step. Keep teaching with what is already visible and narrate only the beats the application supplies.',
      board: state.boardContext.toolSnapshot(),
    });
  }
  const stage = currentStage(state.lessonState);
  const isStale = () => state.visualRequestEpoch !== epoch || controller.signal.aborted;
  const task = (async () => {
    const result = await streamVisual({
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
      validateScene: async (ops) => {
        const verdict = await preflightWithClient(ctx, {
          ops,
          semanticGroupId: sectionId,
          groupLabel: request.idea.slice(0, 160),
        });
        return verdict.accepted
          ? { ok: true }
          : { ok: false, issues: verdict.reasons, layoutIssues: verdict.layoutIssues };
      },
      renderScene: (ops, semanticGroupId) => renderWithClient(ctx, ops, semanticGroupId),
    }, {
      signal: controller.signal,
      onFirstValidatedOp: ({ model, reasoningEffort }) => recordDirectorStreamFirstOp(ctx, {
        startedAtMs: visualIntentStartedAtMs,
        model,
        reasoningEffort,
        identity: timingIdentity,
      }),
      onStep: async (parsed) => {
        if (isStale()) throw abortError();
        const duplicateReasons = streamedStepDuplicateReasons(state.boardContext, parsed.ops);
        if (duplicateReasons.length > 0) {
          throw new StreamingDirectorPrecommitError(`Streaming novelty policy rejected the step: ${duplicateReasons.join('; ')}`);
        }
        const step = {
          id: parsed.step.id,
          reveal: parsed.step.reveal,
          narration: parsed.step.narration,
          objectIds: parsed.ops.map((op) => op.id),
          ops: parsed.ops,
        };
        if (!intakeStarted) {
          intakeStarted = true;
          state.visualPlanState = 'rendering';
          if (request.action === 'establish' && !state.lessonState.activeSemanticObjectId) {
            state.lessonState = { ...state.lessonState, activeSemanticObjectId: sectionId };
          }
          const floorBusy = state.childHoldsFloor || state.speechInProgress || state.draftOpen;
          startStoryboardRun(ctx, {
            runId,
            source: 'director',
            groupId: sectionId,
            groupLabel: parsed.header.groupLabel,
            steps: [step],
            streamOpen: true,
            revealAfterResponseId: floorBusy ? null : state.activeResponseId ?? state.lastCompletedResponseId,
            firstBeatFraming: request.action === 'compare'
              ? [`A new board section called “${parsed.header.groupLabel}” was added beside the current work; tell the learner where to look.`]
              : [],
            handoff: options.directorHandoff,
            visualIntentStartedAtMs,
            firstRevealHeld: Boolean(ctx.visionAudit),
            subsequentRevealsHeld: Boolean(ctx.visionAudit),
            onAbandoned: () => {
              runnerAbandoned = true;
              controller.abort('storyboard runner abandoned the streamed scene');
            },
          });
          if (ctx.visionAudit) {
            auditGateRef.current = createAdaptiveVisionAuditGate({
              ctx,
              runId,
              port: ctx.visionAudit,
              request: {
                purpose: request.purpose,
                idea: request.idea,
                constraints: request.constraints ?? null,
              },
              raster: renderWithClient(ctx, parsed.cumulativeOps, sectionId),
              parentSignal: controller.signal,
              abortComposition: () => controller.abort('vision audit rejected the streamed scene'),
              onRejected: () => { auditRejected = true; },
              onOutcome: (event) => recordVisionAuditOutcome(ctx, visionAuditTelemetryInput(event, timingIdentity)),
              budgetMs: ctx.visionAuditBudgetMs,
            });
          }
          ctx.sendClient({ type: 'illustration_status', status: 'ready' });
          return;
        }
        if (!appendStoryboardRunStep(ctx, runId, step)) {
          throw new Error('The incremental storyboard runner rejected a validated Director step.');
        }
      },
    });
    if (!result.ok) {
      if (result.fallback === 'classic_illustration' && !intakeStarted && ctx.directVisual) {
        if (state.activeVisualRequestAbortController === controller) {
          state.activeVisualRequestAbortController = null;
        }
        options.fallbackToClassic(sectionId);
        return;
      }
      controller.abort('streamed composition failed before terminal scene');
      recordOutcome('director_rejected', result.reasons);
      if (intakeStarted && state.storyboardRun?.runId === runId) {
        abandonStoryboardRun(ctx, { injectNote: true });
      } else failDirectedScene(ctx, result.reasons);
      return;
    }
    const auditGate = auditGateRef.current;
    if (auditGate) {
      auditGate.markCompositionComplete(result.scene.storyboard.length);
      const audit = await auditGate.terminal;
      if (audit.aborted) throw abortError();
      if (audit.externalFailure) {
        recordOutcome('runner_abandoned');
        return;
      }
      if (!audit.safe) {
        recordOutcome('audit_rejected');
        return;
      }
    }
    if (isStale()) throw abortError();
    if (!intakeStarted || state.storyboardRun?.runId !== runId) {
      throw new Error('The Director stream completed without an active incremental storyboard.');
    }
    await ctx.repo.addEvent(ctx.sessionId, 'directed_scene', { runId, scene: result.scene });
    if (isStale()) throw abortError();
    if (!closeStoryboardRunIntake(ctx, runId)) {
      throw new Error('The incremental storyboard could not close after stream completion.');
    }
    recordOutcome('ready');
  })().catch((error) => {
    const aborted = error instanceof Error && error.name === 'AbortError';
    ctx.log(`session ${ctx.sessionId}: streaming directed scene ${aborted ? 'aborted' : 'failed'} ${String(error).slice(0, 200)}`);
    if (state.storyboardRun?.runId === runId) {
      abandonStoryboardRun(ctx, { injectNote: true });
    } else if (aborted) {
      if (!intakeStarted) {
        // The tool already promised a preparing visual. Even if cancellation
        // landed before step 1, close that promise with one scoped honest
        // bridge without touching a newer storyboard run.
        abandonStaleVisualRequest(ctx, request.requestId, 'director', 0, { injectNote: true });
      }
      // If intake had started, the epoch/reconnect owner already terminally
      // abandoned that run; do not emit a second failure bridge.
    } else {
      failDirectedScene(ctx, [String(error).slice(0, 260)]);
    }
    recordOutcome(
      auditRejected ? 'audit_rejected' : runnerAbandoned ? 'runner_abandoned' : aborted ? 'stale' : 'error',
      [String(error).slice(0, 160)],
    );
  }).finally(() => {
    if (state.activeVisualRequestAbortController === controller) {
      state.activeVisualRequestAbortController = null;
    }
  });
  ctx.trackSideEffect(task);
}

function abortError(): Error {
  const error = new Error('Director stream aborted by visual request epoch.');
  error.name = 'AbortError';
  return error;
}
