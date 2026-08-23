import { randomUUID } from 'node:crypto';
import { TeachingMoveSchema, type ResponseTaxonomy, type TeachingMove } from '../../shared/pedagogy.js';
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
}

export type OrchestratorEvent =
  | { type: 'MOVE_PROPOSED'; move: TeachingMove }
  | { type: 'QUESTION_DELIVERED'; taskId: string; text: string; responseMode?: ResponseMode }
  | { type: 'LEARNER_RESPONSE_RECEIVED' }
  | { type: 'ASSESSED'; classification: ResponseTaxonomy; evidenceId?: string }
  | { type: 'INTERRUPTED' }
  | { type: 'RECOVERED'; generationId: string }
  | { type: 'COMPLETE' }
  | { type: 'STRETCH' };

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
  };
}

export function reduceLesson(state: LessonOrchestrationState, event: OrchestratorEvent): LessonOrchestrationState {
  switch (event.type) {
    case 'MOVE_PROPOSED': {
      const move = TeachingMoveSchema.parse(event.move);
      const phaseByAction: Record<TeachingMove['proposedAction'], LessonPhase> = {
        explain: 'EXPLAIN', visual: 'VISUALIZE', question: 'ASK', wait: 'AWAIT_LEARNER', feedback: 'FEEDBACK', practice: 'PRACTICE', reteach: 'RETEACH', advance: 'ADVANCE', complete: 'COMPLETE',
      };
      if (move.proposedAction === 'wait' && (!state.deliveredQuestionTaskId || !state.deliveredQuestionText?.trim())) {
        throw new Error('AWAIT_LEARNER requires a delivered non-empty question or task.');
      }
      return {
        ...state,
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
      return { ...state, phase: nextPhase, owedAction: nextPhase === 'RETEACH' ? 'reteach' : 'feedback', turnOwner: 'tutor', lastClassification: event.classification, conceptEvidenceIds: event.evidenceId ? [...state.conceptEvidenceIds, event.evidenceId] : state.conceptEvidenceIds, prerequisiteState: event.classification === 'missing_prerequisite' ? 'gap' : state.prerequisiteState };
    }
    case 'INTERRUPTED':
      return { ...state, interruptionState: 'interrupted', turnOwner: 'learner', characterAttentionTarget: 'learner' };
    case 'RECOVERED':
      return { ...state, interruptionState: 'recovering', activeGenerationId: event.generationId, turnOwner: 'tutor' };
    case 'COMPLETE':
      return { ...state, phase: 'COMPLETE', owedAction: 'complete', turnOwner: 'tutor' };
    case 'STRETCH':
      if (state.phase !== 'COMPLETE') throw new Error('Stretch is only legal after completion.');
      return { ...state, phase: 'STRETCH', owedAction: 'question', turnOwner: 'tutor' };
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
