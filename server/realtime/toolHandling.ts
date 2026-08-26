import { validateOps } from '../../shared/boardOps.js';
import { ResponseTaxonomySchema, TeachingMoveSchema, type ResponseTaxonomy, type TeachingMove } from '../../shared/pedagogy.js';
import { DeliveredTaskSchema, submitPolicyForMode, type DeliveredTask } from '../../shared/lessonTurn.js';
import type { Confidence, Verdict } from '../store/repo.js';
import { currentStage, reduceLesson } from '../lesson/orchestrator.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import { anchorGroupId } from './boardStaging.js';
import { schedulePlannedDetour } from './detourPlanning.js';
import { identityForResponse } from './responseRegistry.js';
import { refreshBoardInstructions } from './sessionConfig.js';
import { finishTool } from './turnFloor.js';
import { handleVisualRequest } from './visualRequests.js';

/**
 * Tool-call execution. Board operations are validated before a single mark
 * reaches the board, evidence is persisted as it happens, and every tool
 * result honestly reflects what the learner can actually see.
 */

export async function handleToolCall(ctx: CoordinatorContext, name: string, rawArgs: string, callId: string, responseId: string): Promise<void> {
  const { state } = ctx;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    finishTool(ctx, callId, responseId, { ok: false, error: 'arguments were not valid JSON' });
    return;
  }

  switch (name) {
    case 'inspect_board': {
      const focus = typeof args.focus === 'string' ? args.focus.slice(0, 160) : undefined;
      finishTool(ctx, callId, responseId, {
        ok: true,
        focus,
        board: state.boardContext.toolSnapshot(focus),
      });
      break;
    }

    case 'request_visual': {
      await handleVisualRequest(ctx, args, callId, responseId);
      break;
    }

    case 'propose_teaching_move': {
      const parsed = TeachingMoveSchema.safeParse(args);
      if (!parsed.success) {
        finishTool(ctx, callId, responseId, { ok: false, error: 'teaching move failed schema validation' });
        break;
      }
      // Board-led diagnostic questions must be answerable by inspecting or
      // manipulating named visible objects — never by speech alone.
      const stageBefore = currentStage(state.lessonState);
      if (state.lessonState.blueprint?.mode === 'board_led' && stageBefore &&
          ['guided_check', 'independent_check'].includes(stageBefore.kind) && parsed.data.questionOrTask) {
        const visibleTargets = (parsed.data.targetObjectIds ?? []).filter((id) => state.boardContext.hasObject(id));
        if (visibleTargets.length === 0) {
          finishTool(ctx, callId, responseId, {
            ok: false,
            error: `A ${stageBefore.kind} question in a board-led lesson must name visible board objects it asks about (targetObjectIds). Inspect the board and reference real ids.`,
            board: state.boardContext.toolSnapshot(),
          });
          break;
        }
      }
      try {
        state.lessonState = reduceLesson(state.lessonState, { type: 'MOVE_PROPOSED', move: parsed.data });
        const task = taskFromMove(parsed.data, responseId);
        if (task) state.pendingDeliveredTask = task;
        const lessonStatePayload = {
          activeConcept: state.lessonState.microObjective,
          strategy: state.lessonState.strategy,
          nextStep: state.lessonState.owedAction,
          phase: state.lessonState.phase,
          activeSemanticObjectId: state.lessonState.activeSemanticObjectId,
          characterAttentionTarget: state.lessonState.characterAttentionTarget,
        };
        await ctx.repo.addEvent(ctx.sessionId, 'lesson_state', lessonStatePayload);
        ctx.sendClient({ type: 'lesson_state', state: lessonStatePayload, response_id: responseId }, identityForResponse(ctx, responseId), {
          ...(state.lessonState.activeSemanticObjectId ? { semanticObjectId: state.lessonState.activeSemanticObjectId } : {}),
        });
        const stage = currentStage(state.lessonState);
        finishTool(ctx, callId, responseId, {
          ok: true,
          legalPhase: state.lessonState.phase,
          owedAction: state.lessonState.owedAction,
          ...(state.lessonState.blueprint ? {
            blueprintId: state.lessonState.blueprint.blueprintId,
            anchorGroupId: state.lessonState.blueprint.anchor?.semanticGroupId ?? null,
            detourDepth: state.lessonState.blueprint.detourStack.length,
          } : {}),
          ...(stage ? { currentStage: { id: stage.id, kind: stage.kind, objective: stage.objective, boardPurpose: stage.boardPurpose, allowedBoardMutation: stage.allowedBoardMutation } } : {}),
          board: state.boardContext.toolSnapshot(),
        });
      } catch (error) {
        finishTool(ctx, callId, responseId, { ok: false, error: String(error).slice(0, 220) });
      }
      break;
    }

    case 'board_ops': {
      const validated = validateOps(args.ops);
      // Raw destructive clears are not available to the model: visible
      // tutor work never disappears during the ordinary lesson flow.
      const clears = validated.ops.filter((op) => op.op === 'clear');
      if (clears.length > 0) {
        validated.ops = validated.ops.filter((op) => op.op !== 'clear');
        validated.rejected.push({ reason: 'clear is not available; visible work persists — extend or emphasize instead', raw: { op: 'clear' } });
      }
      // Objects created in this logical turn cannot be erased in the same
      // turn; the learner must get to see what was just taught.
      const sameTurnErases = validated.ops.filter((op) => op.op === 'erase' && state.objectsCreatedThisTurn.has(op.id));
      if (sameTurnErases.length > 0) {
        validated.ops = validated.ops.filter((op) => !(op.op === 'erase' && state.objectsCreatedThisTurn.has(op.id)));
        validated.rejected.push({ reason: `erase rejected for objects created this turn (${sameTurnErases.map((op) => op.op === 'erase' ? op.id : '').join(', ')}); visible work persists through the next learner opportunity`, raw: { op: 'erase' } });
      }
      // Raw increments join the active section or the lesson anchor; they
      // never open a fresh freeform section once an anchor exists.
      const semanticGroupId = state.lessonState.activeSemanticObjectId ?? anchorGroupId(ctx) ?? `freeform-${identityForResponse(ctx, responseId)?.turnId ?? 'board'}`;
      const novel = state.boardContext.novelTutorOps(validated.ops, semanticGroupId);
      const { ops } = novel;
      if (ops.length > 0) {
        for (const op of ops) if (op.op === 'add') state.objectsCreatedThisTurn.add(op.id);
        const eventId = await ctx.repo.addEvent(ctx.sessionId, 'board_ops', {
          ops,
          semanticObjectId: semanticGroupId,
          groupLabel: state.lessonState.microObjective || 'Working board',
        }, false);
        state.pendingBoardOps.set(eventId, { ops, semanticGroupId, groupLabel: state.lessonState.microObjective || 'Working board' });
        ctx.sendClient({
          type: 'board_ops',
          ops,
          response_id: responseId,
          event_id: eventId,
          groupLabel: state.lessonState.microObjective || 'Working board',
        }, identityForResponse(ctx, responseId), { semanticObjectId: semanticGroupId });
      }
      finishTool(ctx, callId, responseId, {
        ok: validated.rejected.length === 0,
        applied: ops.length,
        ...(validated.rejected.length > 0
          ? { rejected: validated.rejected.map((r) => r.reason).slice(0, 5) }
          : {}),
        ...(novel.duplicates.length > 0 ? { skippedEquivalentRedraws: novel.duplicates } : {}),
        board: state.boardContext.toolSnapshot(),
      });
      break;
    }

    case 'record_evidence': {
      const verdicts: Verdict[] = ['progressing', 'struggling', 'misconception'];
      const confidences: Confidence[] = ['low', 'medium', 'high'];
      const classification = ResponseTaxonomySchema.safeParse(args.classification).success
        ? (args.classification as ResponseTaxonomy)
        : taxonomyFromLegacyVerdict(args.verdict);
      const projectedVerdict: Verdict = classification === 'confident_misconception'
        ? 'misconception'
        : ['incorrect', 'confusion', 'missing_prerequisite', 'no_meaningful_response'].includes(classification)
          ? 'struggling'
          : 'progressing';
      const entry = {
        concept: String(args.concept ?? '').slice(0, 120),
        observation: String(args.observation ?? '').slice(0, 500),
        verdict: verdicts.includes(projectedVerdict) ? projectedVerdict : 'progressing',
        confidence: confidences.includes(args.confidence as Confidence)
          ? (args.confidence as Confidence)
          : 'low',
        excerpt: args.excerpt ? String(args.excerpt).slice(0, 300) : undefined,
        classification,
        confidenceBasis: String(args.confidence_basis ?? 'Model classification grounded in the latest learner response.').slice(0, 400),
        sourceEventIds: state.lastLearnerEventId === null ? [] : [state.lastLearnerEventId],
        taskId: String(args.task_id ?? state.lessonState.deliveredQuestionTaskId ?? 'unspecified-opportunity').slice(0, 160),
        independenceLevel: classification === 'self_corrected' ? 'reduced' as const : 'independent' as const,
        turnId: identityForResponse(ctx, responseId)?.turnId,
        generationId: identityForResponse(ctx, responseId)?.generationId,
        opportunityKind: ['recall', 'explanation', 'application', 'retrieval'].includes(String(args.opportunity_kind))
          ? args.opportunity_kind as 'recall' | 'explanation' | 'application' | 'retrieval'
          : 'recall' as const,
        retrievalOf: typeof args.retrieval_of === 'string' ? args.retrieval_of.slice(0, 160) : undefined,
        contradicts: Array.isArray(args.contradicts) ? args.contradicts.filter((value): value is string => typeof value === 'string').map((value) => value.slice(0, 160)).slice(0, 8) : [],
        supersedes: Array.isArray(args.supersedes) ? args.supersedes.filter((value): value is string => typeof value === 'string').map((value) => value.slice(0, 160)).slice(0, 8) : [],
      };
      if (entry.concept && entry.observation && entry.sourceEventIds.length > 0) {
        try {
          const stored = await ctx.repo.addEvidence(ctx.sessionId, entry);
          await ctx.repo.addEvent(ctx.sessionId, 'evidence', { evidenceId: stored.evidenceId, concept: stored.concept, verdict: stored.verdict });
          ctx.sendClient({ type: 'evidence', entry: stored }, identityForResponse(ctx, responseId));
          const progressBefore = state.lessonState.blueprint ? `${state.lessonState.blueprint.currentStageIndex}:${state.lessonState.blueprint.detourStack.length}` : null;
          state.lessonState = reduceLesson(state.lessonState, { type: 'ASSESSED', classification, evidenceId: stored.evidenceId });
          const blueprint = state.lessonState.blueprint;
          if (blueprint && progressBefore !== `${blueprint.currentStageIndex}:${blueprint.detourStack.length}`) {
            // Stage progress and detours are durable: a refresh resumes the
            // lesson at the same point of the same blueprint.
            await ctx.repo.addEvent(ctx.sessionId, 'blueprint_progress', {
              blueprintId: blueprint.blueprintId,
              currentStageIndex: blueprint.currentStageIndex,
              detourStack: blueprint.detourStack,
            });
            // The stage changed, so the injected per-stage execution
            // context (objective, checks, storyboard) must change with it.
            refreshBoardInstructions(ctx);
          }
          if (classification === 'missing_prerequisite') {
            // Deterministic trigger: the evidence just recorded a
            // prerequisite gap, so a compiled detour mini-plan is authored
            // asynchronously while the tutor bridges verbally.
            schedulePlannedDetour(ctx);
          }
          const stage = currentStage(state.lessonState);
          finishTool(ctx, callId, responseId, {
            ok: true,
            evidenceId: stored.evidenceId,
            ...(stage ? { currentStage: { id: stage.id, kind: stage.kind, objective: stage.objective } } : {}),
            ...(state.lessonState.blueprint ? { detourDepth: state.lessonState.blueprint.detourStack.length } : {}),
          });
        } catch (error) {
          finishTool(ctx, callId, responseId, { ok: false, error: String(error).slice(0, 220) });
        }
      } else {
        finishTool(ctx, callId, responseId, { ok: false, error: 'concept, observation, and a source learner event are required' });
      }
      break;
    }

    case 'update_lesson_state': {
      const lessonStatePayload = {
        activeConcept: String(args.active_concept ?? '').slice(0, 160),
        strategy: args.strategy ? String(args.strategy).slice(0, 160) : undefined,
        nextStep: args.next_step ? String(args.next_step).slice(0, 240) : undefined,
      };
      await ctx.repo.addEvent(ctx.sessionId, 'lesson_state', lessonStatePayload);
      ctx.sendClient({ type: 'lesson_state', state: lessonStatePayload, response_id: responseId }, identityForResponse(ctx, responseId));
      finishTool(ctx, callId, responseId, { ok: true });
      break;
    }

    default:
      finishTool(ctx, callId, responseId, { ok: false, error: `unknown tool ${name}` });
  }
}

function taxonomyFromLegacyVerdict(value: unknown): ResponseTaxonomy {
  if (value === 'misconception') return 'confident_misconception';
  if (value === 'struggling') return 'incorrect';
  return 'uncertain_or_ambiguous';
}

/** Builds the explicit learner-task contract from a structured teaching move. */
function taskFromMove(move: TeachingMove, responseId: string): DeliveredTask | null {
  if (!move.questionOrTask?.trim()) return null;
  const responseMode = move.responseMode ?? 'voice';
  const parsed = DeliveredTaskSchema.safeParse({
    taskId: (move.taskId?.trim() || `task-${responseId}`).slice(0, 160),
    prompt: move.questionOrTask.trim().slice(0, 500),
    responseMode,
    submitPolicy: submitPolicyForMode(responseMode),
    ...(move.semanticObjectId ? { semanticGroupId: move.semanticObjectId } : {}),
  });
  return parsed.success ? parsed.data : null;
}
