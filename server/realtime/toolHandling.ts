import { validateOps, type BoardOp } from '../../shared/boardOps.js';
import { ResponseTaxonomySchema, TeachingMoveSchema, type ResponseTaxonomy, type TeachingMove } from '../../shared/pedagogy.js';
import { adaptSemanticScene, normalizeVisualAction, VisualActionSchema } from '../../shared/semanticScene.js';
import { DeliveredTaskSchema, submitPolicyForMode, type DeliveredTask } from '../../shared/lessonTurn.js';
import type { Confidence, Verdict } from '../store/repo.js';
import { currentStage, reduceLesson } from '../lesson/orchestrator.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import { anchorGroupId, assignSectionToPlan, stageAndConfirmPlan } from './boardStaging.js';
import { identityForResponse } from './responseRegistry.js';
import { refreshBoardInstructions } from './sessionConfig.js';
import { finishTool } from './turnFloor.js';

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

    case 'semantic_visual_plan': {
      try {
        const requestedAction = (args as { intent?: { action?: unknown } }).intent?.action;
        const normalizedAction = normalizeVisualAction(VisualActionSchema.catch('establish').parse(requestedAction ?? 'establish'));
        // Object permanence: visible tutor work never disappears. Replace
        // is not a live action in any form.
        if (normalizedAction === 'replace') {
          finishTool(ctx, callId, responseId, {
            ok: false,
            accepted: false,
            reason: 'Visible board work never disappears. Replacement is not available: extend or emphasize the anchor, or add an announced comparison beside it.',
            board: state.boardContext.toolSnapshot(),
          });
          break;
        }
        if (normalizedAction === 'none') {
          finishTool(ctx, callId, responseId, {
            ok: true,
            accepted: true,
            action: 'none',
            noBoard: true,
            board: state.boardContext.toolSnapshot(),
          });
          break;
        }
        // One visual plan per logical tutor turn. The budget resets only
        // when a genuine learner turn begins the next teaching turn; a
        // failed attempt may retry exactly once with a simpler plan.
        const planActiveThisTurn = state.planStagedThisTurn && state.visualPlanState !== 'failed';
        if ((planActiveThisTurn || state.planAttemptsThisTurn >= 2) && ['establish', 'compare'].includes(normalizedAction)) {
          finishTool(ctx, callId, responseId, {
            ok: false,
            accepted: false,
            reason: 'One visual plan per teaching turn. Teach with what is on the board now, then wait for the learner.',
            visualPlanState: state.visualPlanState,
            anchorGroupId: anchorGroupId(ctx),
            board: state.boardContext.toolSnapshot(),
          });
          break;
        }
        const blueprint = state.lessonState.blueprint;
        if (!blueprint && ['establish', 'compare'].includes(normalizedAction)) {
          finishTool(ctx, callId, responseId, {
            ok: false,
            accepted: false,
            reason: 'This lesson has no blueprint loaded; teach conversationally and use small board_ops increments only.',
            board: state.boardContext.toolSnapshot(),
          });
          break;
        }
        if (normalizedAction === 'extend') {
          // Extensions are small, incremental, and belong in board_ops so
          // they attach to existing visible objects rather than a template.
          finishTool(ctx, callId, responseId, {
            ok: true,
            accepted: false,
            action: 'extend',
            reason: 'Extend the anchor with small board_ops increments that reference visible IDs; no new section is created.',
            anchorGroupId: anchorGroupId(ctx),
            board: state.boardContext.toolSnapshot(),
          });
          break;
        }
        if (normalizedAction === 'emphasize') {
          const requestedIds = (args as { intent?: { targetObjectIds?: unknown } }).intent?.targetObjectIds;
          const targets = Array.isArray(requestedIds)
            ? requestedIds.filter((id): id is string => typeof id === 'string' && state.boardContext.hasObject(id)).slice(0, 12)
            : [];
          if (targets.length === 0) {
            finishTool(ctx, callId, responseId, {
              ok: false,
              accepted: false,
              reason: 'Emphasize needs visible target object ids. Inspect the board and name the objects to highlight.',
              board: state.boardContext.toolSnapshot(),
            });
            break;
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
          break;
        }
        // establish | compare: the server, not the model, assigns the
        // section. The anchor is established once; comparisons are added
        // beside it in an announced side section that never auto-switches
        // the learner's view.
        const anchor = anchorGroupId(ctx) ?? 'lesson-anchor';
        let assignedGroupId = anchor;
        if (normalizedAction === 'establish') {
          if (state.boardContext.hasGroup(anchor)) {
            finishTool(ctx, callId, responseId, {
              ok: false,
              accepted: false,
              reason: `The anchor section ${anchor} is already on the board. Extend or emphasize it; do not rebuild it.`,
              anchorGroupId: anchor,
              board: state.boardContext.toolSnapshot(),
            });
            break;
          }
          const compiledAnchor = ctx.compiledLesson?.anchorScene;
          if (compiledAnchor && compiledAnchor.groupId === anchor) {
            // Establish resolves to the pre-compiled, pre-validated anchor
            // scene: the voice model triggers the reveal but never invents
            // the geometry. Runtime preflight still applies, fail closed.
            const addOps = compiledAnchor.ops.filter((op) => op.op === 'add');
            stageAndConfirmPlan(ctx, callId, responseId, {
              ops: addOps,
              checkpoints: compiledAnchor.storyboard.map((step) => ({
                id: step.id,
                semanticObjectId: compiledAnchor.groupId,
                groupLabel: compiledAnchor.groupLabel,
                reveal: step.reveal,
                ops: addOps.filter((op) => step.objectIds.includes(op.id)),
              })),
              action: 'establish',
              storyboard: compiledAnchor.storyboard.map((step) => ({
                id: step.id,
                reveal: step.reveal,
                narration: step.narration,
              })),
            });
            break;
          }
        } else {
          assignedGroupId = `${anchor}-alt${++state.comparisonSectionCounter}`;
        }
        const planInput = assignSectionToPlan(args, assignedGroupId);
        const { plan, ops, checkpoints } = adaptSemanticScene(planInput);
        const densityLimit = plan.intent.density === 'minimal' ? 14 : 30;
        if (ops.length > densityLimit) {
          finishTool(ctx, callId, responseId, {
            ok: false,
            accepted: false,
            reason: `The ${plan.intent.density} visual exceeds its ${densityLimit}-object density budget. Simplify or split the teaching move.`,
            questionAnswered: plan.intent.questionAnswered,
            board: state.boardContext.toolSnapshot(),
          });
          break;
        }
        const equivalent = state.boardContext.equivalentTutorScene(ops);
        if (equivalent.equivalent) {
          finishTool(ctx, callId, responseId, {
            ok: true,
            accepted: false,
            reason: 'An equivalent visual is already visible. Reuse its IDs and adapt it in place.',
            equivalentObjects: equivalent.duplicates,
            board: state.boardContext.toolSnapshot(),
          });
          break;
        }
        stageAndConfirmPlan(ctx, callId, responseId, {
          ops,
          checkpoints,
          action: normalizedAction,
          plan,
          ...(normalizedAction === 'compare' ? { announcement: `A comparison was added beside the anchor as section ${assignedGroupId}. Tell the learner it is there; their view does not switch automatically.` } : {}),
        });
      } catch (error) {
        finishTool(ctx, callId, responseId, {
          ok: false,
          accepted: false,
          error: String(error).slice(0, 260),
        });
      }
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
