import { randomUUID } from 'node:crypto';
import { DetourPlanSchema, LessonBlueprintSchema, TeachingMoveSchema, type LessonBlueprint, type LessonStage, type ResponseTaxonomy, type TeachingMove } from '../../shared/pedagogy.js';
import { submitPolicyForMode, type ResponseMode, type SubmitPolicy } from '../../shared/lessonTurn.js';

export type LessonPhase = 'ORIENT' | 'EXPLAIN' | 'VISUALIZE' | 'ASK' | 'AWAIT_LEARNER' | 'ASSESS' | 'FEEDBACK' | 'PRACTICE' | 'RETEACH' | 'ADVANCE' | 'COMPLETE' | 'STRETCH';
export type OwedAction = 'explain' | 'visual' | 'question' | 'wait' | 'feedback' | 'practice' | 'reteach' | 'advance' | 'complete';

export interface LessonOrchestrationState {
  lessonGoal: string;
  microObjective: string;
  prerequisiteState: 'unknown' | 'ready' | 'gap';
  strategy: string;
  visualStrategy: string | null;
  conceptEvidenceIds: string[];
  confidenceBasis: string;
  phase: LessonPhase;
  owedAction: OwedAction;
  turnOwner: 'tutor' | 'learner' | 'system';
  deliveredQuestionTaskId: string | null;
  deliveredQuestionText: string | null;
  completionConditions: string[];
  stretchConditions: string[];
  interruptionState: 'none' | 'interrupted' | 'recovering';
  activeGenerationId: string;
  activeSemanticObjectId: string | null;
  characterAttentionTarget: string;
  lastClassification: ResponseTaxonomy | null;
  continuationAttempts: number;
  deliveredResponseMode: ResponseMode | null;
  deliveredSubmitPolicy: SubmitPolicy | null;
  /** The durable lesson plan. Adaptation moves through it; it is never
   * regenerated turn by turn. */
  blueprint: LessonBlueprint | null;
}

export type OrchestratorEvent =
  | { type: 'BLUEPRINT_CREATED'; blueprint: LessonBlueprint }
  | { type: 'MOVE_PROPOSED'; move: TeachingMove }
  | { type: 'QUESTION_DELIVERED'; taskId: string; text: string; responseMode?: ResponseMode }
  | { type: 'LEARNER_RESPONSE_RECEIVED' }
  | { type: 'ASSESSED'; classification: ResponseTaxonomy; evidenceId?: string }
  | { type: 'DETOUR_PLANNED'; reason: string; stages: LessonStage[] }
  | { type: 'INTERRUPTED' }
  | { type: 'RECOVERED'; generationId: string }
  | { type: 'COMPLETE' }
  | { type: 'STRETCH' };

/** The stage the tutor executes right now. While a compiled detour plan is
 * open, that is the active detour stage, not the recorded main stage. */
export function currentStage(state: LessonOrchestrationState): LessonStage | null {
  if (!state.blueprint) return null;
  const detour = state.blueprint.detourStack[state.blueprint.detourStack.length - 1];
  if (detour?.plan) {
    return detour.plan.stages[Math.min(detour.plan.activeIndex, detour.plan.stages.length - 1)] ?? null;
  }
  return state.blueprint.stages[Math.min(state.blueprint.currentStageIndex, state.blueprint.stages.length - 1)] ?? null;
}

export function createLessonState(goal: string, generationId: string = randomUUID()): LessonOrchestrationState {
  return {
    lessonGoal: goal,
    microObjective: goal,
    prerequisiteState: 'unknown',
    strategy: 'orient and diagnose',
    visualStrategy: null,
    conceptEvidenceIds: [],
    confidenceBasis: 'No learner evidence yet.',
    phase: 'ORIENT',
    owedAction: 'explain',
    turnOwner: 'tutor',
    deliveredQuestionTaskId: null,
    deliveredQuestionText: null,
    completionConditions: ['multiple independent opportunities', 'explanation or application', 'later retrieval'],
    stretchConditions: ['lesson goal is complete', 'learner opts into a stretch'],
    interruptionState: 'none',
    activeGenerationId: generationId,
    activeSemanticObjectId: null,
    characterAttentionTarget: 'learner',
    lastClassification: null,
    continuationAttempts: 0,
    deliveredResponseMode: null,
    deliveredSubmitPolicy: null,
    blueprint: null,
  };
}

export function reduceLesson(state: LessonOrchestrationState, event: OrchestratorEvent): LessonOrchestrationState {
  switch (event.type) {
    case 'BLUEPRINT_CREATED': {
      if (state.blueprint) throw new Error('A lesson blueprint already exists; execute its current stage instead of regenerating it.');
      const blueprint = LessonBlueprintSchema.parse(event.blueprint);
      return {
        ...state,
        blueprint,
        microObjective: blueprint.stages[0].objective,
        activeSemanticObjectId: blueprint.anchor?.semanticGroupId ?? state.activeSemanticObjectId,
      };
    }
    case 'MOVE_PROPOSED': {
      const move = TeachingMoveSchema.parse(event.move);
      const phaseByAction: Record<TeachingMove['proposedAction'], LessonPhase> = {
        explain: 'EXPLAIN', visual: 'VISUALIZE', question: 'ASK', wait: 'AWAIT_LEARNER', feedback: 'FEEDBACK', practice: 'PRACTICE', reteach: 'RETEACH', advance: 'ADVANCE', complete: 'COMPLETE',
      };
      if (move.proposedAction === 'wait' && (!state.deliveredQuestionTaskId || !state.deliveredQuestionText?.trim())) {
        throw new Error('AWAIT_LEARNER requires a delivered non-empty question or task.');
      }
      let blueprint = state.blueprint;
      if (blueprint) {
        const stage = currentStage(state);
        if (move.blueprintId && move.blueprintId !== blueprint.blueprintId) {
          throw new Error(`Unknown blueprint ${move.blueprintId}; the active blueprint is ${blueprint.blueprintId}.`);
        }
        if (move.stageId && stage && move.stageId !== stage.id) {
          throw new Error(`Illegal stage jump to ${move.stageId}; the current stage is ${stage.id} (${stage.objective}). Execute the current stage or record a detour.`);
        }
        if (blueprint.mode === 'board_led' && blueprint.anchor && move.anchorGroupId && move.anchorGroupId !== blueprint.anchor.semanticGroupId) {
          throw new Error(`The lesson anchor is ${blueprint.anchor.semanticGroupId}; a move cannot change the anchor representation.`);
        }
        if (move.proposedAction === 'visual' && move.boardPurpose === 'none' && blueprint.mode !== 'conversation_led') {
          throw new Error('A visual move needs a real board purpose; use boardPurpose none only for speech-only moves.');
        }
        if (blueprint.mode === 'board_led' && stage && stage.allowedBoardMutation !== 'none' && move.proposedAction === 'explain' && move.boardPurpose === 'none') {
          throw new Error(`Stage ${stage.id} teaches through the board (${stage.boardPurpose}); speech-only instruction is not enough here.`);
        }
        if (move.proposedAction === 'complete') assertCompletionLegal(state);
        if (move.detourReason) {
          const returnStageIndex = move.returnStageId
            ? Math.max(0, blueprint.stages.findIndex((candidate) => candidate.id === move.returnStageId))
            : blueprint.currentStageIndex;
          blueprint = {
            ...blueprint,
            detourStack: [...blueprint.detourStack, { reason: move.detourReason, returnStageIndex }].slice(-4),
          };
        }
      }
      return {
        ...state,
        blueprint,
        microObjective: move.microObjective,
        strategy: move.strategy,
        visualStrategy: move.visualStrategy ?? state.visualStrategy,
        activeSemanticObjectId: move.semanticObjectId ?? state.activeSemanticObjectId,
        phase: phaseByAction[move.proposedAction],
        owedAction: move.proposedAction,
        turnOwner: move.proposedAction === 'wait' ? 'learner' : 'tutor',
        lastClassification: move.classification ?? state.lastClassification,
      };
    }
    case 'QUESTION_DELIVERED': {
      if (!event.taskId.trim() || !event.text.trim()) throw new Error('A delivered question needs an id and text.');
      const responseMode = event.responseMode ?? 'voice';
      return {
        ...state, phase: 'AWAIT_LEARNER', owedAction: 'wait', turnOwner: 'learner',
        deliveredQuestionTaskId: event.taskId, deliveredQuestionText: event.text, continuationAttempts: 0,
        deliveredResponseMode: responseMode, deliveredSubmitPolicy: submitPolicyForMode(responseMode),
      };
    }
    case 'LEARNER_RESPONSE_RECEIVED':
      if (state.phase !== 'AWAIT_LEARNER') throw new Error('Learner response is only legal while awaiting the learner.');
      return { ...state, phase: 'ASSESS', owedAction: 'feedback', turnOwner: 'system' };
    case 'ASSESSED': {
      const nextPhase = event.classification === 'correct' ? 'FEEDBACK' : ['confident_misconception', 'confusion', 'missing_prerequisite'].includes(event.classification) ? 'RETEACH' : 'FEEDBACK';
      let blueprint = state.blueprint;
      if (blueprint) {
        if (event.classification === 'correct' || event.classification === 'self_corrected') {
          const detour = blueprint.detourStack[blueprint.detourStack.length - 1];
          if (detour?.plan && detour.plan.activeIndex < detour.plan.stages.length - 1) {
            // A multi-stage detour plan advances through its own stages
            // before the lesson returns to the recorded main stage.
            blueprint = {
              ...blueprint,
              detourStack: [
                ...blueprint.detourStack.slice(0, -1),
                { ...detour, plan: { ...detour.plan, activeIndex: detour.plan.activeIndex + 1 } },
              ],
            };
          } else if (detour) {
            // A resolved detour returns to the recorded stage; the lesson
            // goal itself was never replaced.
            blueprint = {
              ...blueprint,
              detourStack: blueprint.detourStack.slice(0, -1),
              currentStageIndex: Math.min(detour.returnStageIndex, blueprint.stages.length - 1),
            };
          } else {
            blueprint = {
              ...blueprint,
              currentStageIndex: Math.min(blueprint.currentStageIndex + 1, blueprint.stages.length - 1),
            };
          }
        } else if (event.classification === 'missing_prerequisite') {
          blueprint = {
            ...blueprint,
            detourStack: [...blueprint.detourStack, { reason: 'missing prerequisite', returnStageIndex: blueprint.currentStageIndex }].slice(-4),
          };
        }
        // Partial/incorrect answers stay on the stage; the tactic changes,
        // never the blueprint.
      }
      return { ...state, blueprint, phase: nextPhase, owedAction: nextPhase === 'RETEACH' ? 'reteach' : 'feedback', turnOwner: 'tutor', lastClassification: event.classification, conceptEvidenceIds: event.evidenceId ? [...state.conceptEvidenceIds, event.evidenceId] : state.conceptEvidenceIds, prerequisiteState: event.classification === 'missing_prerequisite' ? 'gap' : state.prerequisiteState };
    }
    case 'DETOUR_PLANNED': {
      // A deterministic server decision delivered a compiled detour
      // mini-plan. It upgrades the simple detour that evidence already
      // recorded (or opens one) and never touches the main blueprint route.
      const blueprint = state.blueprint;
      if (!blueprint) throw new Error('A detour plan requires an active blueprint.');
      const plan = DetourPlanSchema.parse({ stages: event.stages, activeIndex: 0 });
      const top = blueprint.detourStack[blueprint.detourStack.length - 1];
      const detourStack = top && !top.plan
        ? [...blueprint.detourStack.slice(0, -1), { ...top, plan }]
        : [...blueprint.detourStack, { reason: event.reason.slice(0, 240), returnStageIndex: blueprint.currentStageIndex, plan }].slice(-4);
      return {
        ...state,
        blueprint: { ...blueprint, detourStack },
        microObjective: plan.stages[0].objective,
      };
    }
    case 'INTERRUPTED':
      return { ...state, interruptionState: 'interrupted', turnOwner: 'learner', characterAttentionTarget: 'learner' };
    case 'RECOVERED':
      return { ...state, interruptionState: 'recovering', activeGenerationId: event.generationId, turnOwner: 'tutor' };
    case 'COMPLETE':
      assertCompletionLegal(state);
      return { ...state, phase: 'COMPLETE', owedAction: 'complete', turnOwner: 'tutor' };
    case 'STRETCH':
      if (state.phase !== 'COMPLETE') throw new Error('Stretch is only legal after completion.');
      return { ...state, phase: 'STRETCH', owedAction: 'question', turnOwner: 'tutor' };
  }
}

/** Completion is illegal until the blueprint route has been travelled and
 * its success criteria have real learner evidence behind them. */
function assertCompletionLegal(state: LessonOrchestrationState): void {
  const blueprint = state.blueprint;
  if (!blueprint) return;
  if (blueprint.detourStack.length > 0) throw new Error('An open prerequisite detour must return to its stage before the lesson can complete.');
  if (blueprint.currentStageIndex < blueprint.stages.length - 1) {
    throw new Error(`The lesson is on stage ${blueprint.stages[blueprint.currentStageIndex].id} of ${blueprint.stages.length}; completion is only legal on the final stage.`);
  }
  if (state.conceptEvidenceIds.length < Math.min(2, blueprint.successCriteria.length)) {
    throw new Error('Completion requires recorded learner evidence for the blueprint success criteria.');
  }
}

export type HandoffDecision = 'wait' | 'bounded_continuation';

/**
 * Decides what happens after a completed tutor response.
 *
 * Turn ownership is explicit, not punctuation: a delivered task (question or
 * imperative such as "Circle the acute angle.") already yields the floor. An
 * explanation without a question simply waits — the tutor is never forced to
 * inject a question after every response. The only continuation is when the
 * model explicitly *promised* a question move and then failed to deliver it.
 */
export function responseHandoff(state: LessonOrchestrationState, deliveredText: string): HandoffDecision {
  if (state.phase === 'COMPLETE' || state.phase === 'AWAIT_LEARNER') return 'wait';
  const hasQuestion = deliveredText.trim().length > 0 && /[?？]\s*$/.test(deliveredText.trim());
  if (hasQuestion) return 'wait';
  if (state.owedAction === 'question' && state.continuationAttempts < 1) return 'bounded_continuation';
  return 'wait';
}
