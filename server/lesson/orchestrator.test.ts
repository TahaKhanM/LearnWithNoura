import { describe, expect, it } from 'vitest';
import { createLessonState, reduceLesson, responseHandoff } from './orchestrator';

describe('lesson orchestrator', () => {
  it('forbids waiting without a delivered question or task', () => {
    const state = createLessonState('fractions', 'generation-1');
    expect(() => reduceLesson(state, { type: 'MOVE_PROPOSED', move: { rationale: 'pause', microObjective: 'compare', strategy: 'diagnose', childFacingText: 'Think.', proposedAction: 'wait' } })).toThrow(/requires a delivered/i);
  });

  it('owns the legal ask, await, assess, feedback loop', () => {
    let state = createLessonState('fractions', 'generation-1');
    state = reduceLesson(state, { type: 'QUESTION_DELIVERED', taskId: 'task-1', text: 'Which mark is farther right?' });
    expect(state.phase).toBe('AWAIT_LEARNER');
    state = reduceLesson(state, { type: 'LEARNER_RESPONSE_RECEIVED' });
    expect(state.phase).toBe('ASSESS');
    state = reduceLesson(state, { type: 'ASSESSED', classification: 'partially_correct', evidenceId: 'evidence-1' });
    expect(state.phase).toBe('FEEDBACK');
    expect(state.conceptEvidenceIds).toEqual(['evidence-1']);
  });

  it('never injects a question after an explanation; only a promised question continues once', () => {
    const state = createLessonState('water cycle', 'generation-1');
    // A plain explanation without a promised question simply waits — the
    // tutor is not forced to end every response with a question.
    expect(responseHandoff(state, 'Next, we will connect evaporation to clouds.')).toBe('wait');
    // A question the model explicitly promised but failed to ask continues
    // exactly once, and never a second time.
    const promisedQuestion = { ...state, owedAction: 'question' as const };
    expect(responseHandoff(promisedQuestion, 'Evaporation lifts the water.')).toBe('bounded_continuation');
    expect(responseHandoff({ ...promisedQuestion, continuationAttempts: 1 }, 'Evaporation lifts the water.')).toBe('wait');
    expect(responseHandoff(state, 'Where does the water go next?')).toBe('wait');
  });

  it('treats an imperative drawing task as a delivered handoff with an explicit submit policy', () => {
    let state = createLessonState('angles', 'generation-1');
    state = reduceLesson(state, { type: 'QUESTION_DELIVERED', taskId: 'circle-acute', text: 'Circle the acute angle.', responseMode: 'draw' });
    expect(state.phase).toBe('AWAIT_LEARNER');
    expect(state.turnOwner).toBe('learner');
    expect(state.deliveredResponseMode).toBe('draw');
    expect(state.deliveredSubmitPolicy).toBe('explicit');
    // Once the task is delivered, a completed explanation response waits for
    // the learner instead of injecting another question.
    expect(responseHandoff(state, 'Take your time.')).toBe('wait');
  });
});
