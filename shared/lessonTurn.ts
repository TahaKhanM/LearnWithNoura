import { z } from 'zod';
import { LearnerBoardAnalysisSchema } from './learnerBoard.js';

/**
 * The shared logical-turn contract between the browser, the proxy, and
 * durable storage.
 *
 * The core product invariant lives here: a learner drawing is a *draft*
 * until the learner explicitly submits it. Pointer-up and inactivity never
 * mean "done". Exactly one model response may be created per submitted
 * learner turn, and the server-side coordinator is the only owner of
 * `response.create`.
 */

export const ResponseModeSchema = z.enum(['voice', 'text', 'draw', 'choice', 'mixed']);
export type ResponseMode = z.infer<typeof ResponseModeSchema>;

export const SubmitPolicySchema = z.enum(['vad', 'explicit']);
export type SubmitPolicy = z.infer<typeof SubmitPolicySchema>;

/** A task Noura has actually asked (question or imperative), heard by the learner. */
export const DeliveredTaskSchema = z.object({
  taskId: z.string().min(1).max(160),
  prompt: z.string().min(1).max(500),
  responseMode: ResponseModeSchema,
  submitPolicy: SubmitPolicySchema,
  semanticGroupId: z.string().min(1).max(160).optional(),
  targetObjectIds: z.array(z.string().min(1).max(160)).max(12).default([]),
  boardRevision: z.number().int().nonnegative().default(0),
  allowVoiceWhileDrawing: z.boolean().default(true),
});
export type DeliveredTask = z.infer<typeof DeliveredTaskSchema>;

/** Drawing tasks require an explicit Done; spoken/typed tasks may use VAD. */
export function submitPolicyForMode(mode: ResponseMode): SubmitPolicy {
  return mode === 'draw' || mode === 'mixed' ? 'explicit' : 'vad';
}

/** One frozen learner board answer. Idempotent by submissionId. */
export const BoardSubmissionSchema = z.object({
  submissionId: z.string().regex(/^[\w-]{8,160}$/),
  draftId: z.string().min(1).max(160),
  taskId: z.string().min(1).max(160).optional(),
  semanticGroupId: z.string().min(1).max(160).optional(),
  semanticGroupLabel: z.string().min(1).max(160).optional(),
  baseBoardRevision: z.number().int().nonnegative().default(0),
  submittedBoardRevision: z.number().int().nonnegative().default(0),
  description: z.string().max(4_000).default(''),
  ops: z.array(z.unknown()).max(80).default([]),
  analysis: LearnerBoardAnalysisSchema.optional(),
  imageDataUrl: z.string().max(320_000).optional(),
});
export type BoardSubmission = z.infer<typeof BoardSubmissionSchema>;

export type LessonTurnPhase =
  | 'tutor_turn'
  | 'awaiting_learner'
  | 'learner_composing'
  | 'learner_submitting'
  | 'tutor_thinking'
  | 'ended';

export type FloorOwner = 'tutor' | 'learner';

export interface LearnerDraftState {
  draftId: string;
  taskId?: string;
  semanticGroupId?: string;
  baseBoardRevision: number;
  status: 'open' | 'submitting';
}

export interface LessonTurnState {
  phase: LessonTurnPhase;
  floor: FloorOwner;
  task: DeliveredTask | null;
  draft: LearnerDraftState | null;
  /** Submission ids that already produced (or will produce) one response. */
  respondedSubmissionIds: string[];
}

export type LessonTurnEvent =
  | { type: 'TUTOR_RESPONSE_STARTED' }
  | { type: 'TASK_DELIVERED'; task: DeliveredTask }
  | { type: 'DRAFT_STARTED'; draftId: string; baseBoardRevision?: number; semanticGroupId?: string; taskId?: string }
  | { type: 'DRAFT_CANCELLED'; draftId: string }
  | { type: 'SUBMISSION_STARTED'; submissionId: string; draftId: string }
  | { type: 'SUBMISSION_SETTLED'; submissionId: string; accepted: boolean }
  | { type: 'VOICE_TURN_COMMITTED' }
  | { type: 'TEXT_TURN_COMMITTED' }
  | { type: 'ENDED' };

export function createLessonTurnState(): LessonTurnState {
  return { phase: 'tutor_turn', floor: 'tutor', task: null, draft: null, respondedSubmissionIds: [] };
}

/**
 * Total reducer: every event produces a defined next state. Illegal
 * transitions (submitting a draft that is not open, duplicate submissions)
 * throw so callers cannot silently double-submit or double-respond.
 */
export function reduceLessonTurn(state: LessonTurnState, event: LessonTurnEvent): LessonTurnState {
  if (state.phase === 'ended' && event.type !== 'ENDED') return state;
  switch (event.type) {
    case 'TUTOR_RESPONSE_STARTED':
      // A new tutor response never closes an open drawing draft.
      return state.draft
        ? { ...state, phase: 'learner_composing' }
        : { ...state, phase: 'tutor_turn', floor: 'tutor' };
    case 'TASK_DELIVERED':
      return { ...state, phase: state.draft ? 'learner_composing' : 'awaiting_learner', floor: 'learner', task: event.task };
    case 'DRAFT_STARTED': {
      if (state.draft?.draftId === event.draftId) return state;
      if (state.draft) throw new Error('A drawing draft is already open.');
      return {
        ...state,
        phase: 'learner_composing',
        floor: 'learner',
        draft: {
          draftId: event.draftId,
          baseBoardRevision: event.baseBoardRevision ?? 0,
          status: 'open',
          ...(event.semanticGroupId ? { semanticGroupId: event.semanticGroupId } : {}),
          ...(event.taskId ?? state.task?.taskId ? { taskId: event.taskId ?? state.task?.taskId } : {}),
        },
      };
    }
    case 'DRAFT_CANCELLED':
      if (!state.draft || state.draft.draftId !== event.draftId) return state;
      return { ...state, phase: state.task ? 'awaiting_learner' : 'tutor_turn', draft: null };
    case 'SUBMISSION_STARTED': {
      if (!state.draft || state.draft.draftId !== event.draftId) throw new Error('Cannot submit without an open draft.');
      if (state.respondedSubmissionIds.includes(event.submissionId)) throw new Error('This submission was already sent.');
      return { ...state, phase: 'learner_submitting', draft: { ...state.draft, status: 'submitting' } };
    }
    case 'SUBMISSION_SETTLED': {
      if (state.respondedSubmissionIds.includes(event.submissionId)) return state;
      if (!event.accepted) {
        // The draft stays recoverable so the learner can retry.
        return { ...state, phase: 'learner_composing', draft: state.draft ? { ...state.draft, status: 'open' } : null };
      }
      return {
        ...state,
        phase: 'tutor_thinking',
        floor: 'tutor',
        task: null,
        draft: null,
        respondedSubmissionIds: [...state.respondedSubmissionIds, event.submissionId].slice(-64),
      };
    }
    case 'VOICE_TURN_COMMITTED':
      // Speech never completes a turn while a drawing draft is open; the
      // transcript accumulates as context for the explicit submission.
      if (state.draft) return state;
      return { ...state, phase: 'tutor_thinking', floor: 'tutor', task: null };
    case 'TEXT_TURN_COMMITTED':
      return { ...state, phase: 'tutor_thinking', floor: 'tutor', task: null, draft: null };
    case 'ENDED':
      return { ...state, phase: 'ended' };
  }
}

/**
 * The single gate for `response.create`. Only these transitions may create a
 * model response; everything else (pointer-up, inactivity, stroke count,
 * tool chatter) must not.
 */
export function mayCreateResponse(state: LessonTurnState, source: 'voice' | 'text' | 'board' | 'tool' | 'start'): boolean {
  if (state.phase === 'ended') return false;
  switch (source) {
    case 'voice':
      return state.draft === null;
    case 'text':
      return true;
    case 'board':
      return state.phase === 'tutor_thinking' || state.phase === 'learner_submitting';
    case 'tool':
      return state.floor === 'tutor';
    case 'start':
      return true;
  }
}
