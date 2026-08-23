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

  it('issues continuation instead of silently listening after an unresolved promise', () => {
    const state = createLessonState('water cycle', 'generation-1');
    expect(responseHandoff(state, 'Next, we will connect evaporation to clouds.')).toBe('bounded_continuation');
    expect(responseHandoff({ ...state, continuationAttempts: 1 }, 'Next, we will connect it.')).toBe('safe_question');
    expect(responseHandoff(state, 'Where does the water go next?')).toBe('wait');
  });
});
