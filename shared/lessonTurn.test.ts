import { describe, expect, it } from 'vitest';
import {
  createLessonTurnState,
  mayCreateResponse,
  reduceLessonTurn,
  submitPolicyForMode,
  BoardSubmissionSchema,
  DeliveredTaskSchema,
  type LessonTurnState,
} from './lessonTurn';

const drawTask = DeliveredTaskSchema.parse({
  taskId: 'circle-acute',
  prompt: 'Circle the acute angle.',
  responseMode: 'draw',
  submitPolicy: 'explicit',
});

describe('lesson turn state machine', () => {
  it('derives explicit submission for drawing and mixed tasks', () => {
    expect(submitPolicyForMode('draw')).toBe('explicit');
    expect(submitPolicyForMode('mixed')).toBe('explicit');
    expect(submitPolicyForMode('manipulate')).toBe('explicit');
    expect(submitPolicyForMode('voice')).toBe('vad');
    expect(submitPolicyForMode('text')).toBe('vad');
  });

  it('keeps a draft open across speech commits — a pause never completes the turn', () => {
    let state = createLessonTurnState();
    state = reduceLessonTurn(state, { type: 'TASK_DELIVERED', task: drawTask });
    expect(state.phase).toBe('awaiting_learner');
    state = reduceLessonTurn(state, { type: 'DRAFT_STARTED', draftId: 'draft-1' });
    expect(state.phase).toBe('learner_composing');
    // Speech stopping while composing does not end the turn.
    const afterSpeech = reduceLessonTurn(state, { type: 'VOICE_TURN_COMMITTED' });
    expect(afterSpeech.phase).toBe('learner_composing');
    expect(afterSpeech.draft?.draftId).toBe('draft-1');
    expect(mayCreateResponse(afterSpeech, 'voice')).toBe(false);
    expect(mayCreateResponse(afterSpeech, 'board')).toBe(false);
  });

  it('submits exactly once: duplicate submissions are illegal', () => {
    let state = createLessonTurnState();
    state = reduceLessonTurn(state, { type: 'TASK_DELIVERED', task: drawTask });
    state = reduceLessonTurn(state, { type: 'DRAFT_STARTED', draftId: 'draft-1' });
    state = reduceLessonTurn(state, { type: 'SUBMISSION_STARTED', submissionId: 'submission-1', draftId: 'draft-1' });
    expect(state.phase).toBe('learner_submitting');
    expect(mayCreateResponse(state, 'board')).toBe(true);
    state = reduceLessonTurn(state, { type: 'SUBMISSION_SETTLED', submissionId: 'submission-1', accepted: true });
    expect(state.phase).toBe('tutor_thinking');
    expect(state.task).toBeNull();
    expect(state.draft).toBeNull();
    expect(() => reduceLessonTurn(
      reduceLessonTurn(state, { type: 'DRAFT_STARTED', draftId: 'draft-2' }),
      { type: 'SUBMISSION_STARTED', submissionId: 'submission-1', draftId: 'draft-2' },
    )).toThrow(/already sent/i);
  });

  it('recovers a failed submission into an editable draft', () => {
    let state = createLessonTurnState();
    state = reduceLessonTurn(state, { type: 'DRAFT_STARTED', draftId: 'draft-1' });
    state = reduceLessonTurn(state, { type: 'SUBMISSION_STARTED', submissionId: 'submission-1', draftId: 'draft-1' });
    state = reduceLessonTurn(state, { type: 'SUBMISSION_SETTLED', submissionId: 'submission-1', accepted: false });
    expect(state.phase).toBe('learner_composing');
    expect(state.draft?.status).toBe('open');
  });

  it('rejects submissions without an open draft and duplicate drafts', () => {
    const state = createLessonTurnState();
    expect(() => reduceLessonTurn(state, { type: 'SUBMISSION_STARTED', submissionId: 'submission-1', draftId: 'ghost' })).toThrow(/open draft/i);
    let composing = reduceLessonTurn(state, { type: 'DRAFT_STARTED', draftId: 'draft-1' });
    // Idempotent for the same draft, illegal for a different one.
    composing = reduceLessonTurn(composing, { type: 'DRAFT_STARTED', draftId: 'draft-1' });
    expect(composing.draft?.draftId).toBe('draft-1');
    expect(() => reduceLessonTurn(composing, { type: 'DRAFT_STARTED', draftId: 'draft-2' })).toThrow(/already open/i);
  });

  it('cancelling a draft returns to the delivered task, not to the tutor', () => {
    let state = createLessonTurnState();
    state = reduceLessonTurn(state, { type: 'TASK_DELIVERED', task: drawTask });
    state = reduceLessonTurn(state, { type: 'DRAFT_STARTED', draftId: 'draft-1' });
    state = reduceLessonTurn(state, { type: 'DRAFT_CANCELLED', draftId: 'draft-1' });
    expect(state.phase).toBe('awaiting_learner');
    expect(state.task?.taskId).toBe('circle-acute');
  });

  it('tool continuations require the tutor floor; text is always a legal turn', () => {
    let state = createLessonTurnState();
    expect(mayCreateResponse(state, 'tool')).toBe(true);
    state = reduceLessonTurn(state, { type: 'TASK_DELIVERED', task: drawTask });
    expect(mayCreateResponse(state, 'tool')).toBe(false);
    expect(mayCreateResponse(state, 'text')).toBe(true);
    state = reduceLessonTurn(state, { type: 'ENDED' });
    expect(mayCreateResponse(state, 'text')).toBe(false);
  });

  it('validates the board submission envelope', () => {
    expect(BoardSubmissionSchema.safeParse({ submissionId: 'x', draftId: 'draft' }).success).toBe(false);
    const parsed = BoardSubmissionSchema.safeParse({
      submissionId: 'submission-abc-123',
      draftId: 'draft-1',
      description: 'a circle around the acute angle',
      ops: [{ op: 'add', id: 'sketch-1', spec: { kind: 'path', points: [[1, 1], [2, 2]] } }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('turn/floor invariants', () => {
  it('a tutor response starting never closes an open draft', () => {
    let state: LessonTurnState = createLessonTurnState();
    state = reduceLessonTurn(state, { type: 'DRAFT_STARTED', draftId: 'draft-1' });
    state = reduceLessonTurn(state, { type: 'TUTOR_RESPONSE_STARTED' });
    expect(state.draft?.draftId).toBe('draft-1');
    expect(state.phase).toBe('learner_composing');
  });
});
