import { describe, expect, it } from 'vitest';
import type { LessonBlueprint } from '../../shared/pedagogy';
import { createLessonState, currentStage, reduceLesson, responseHandoff } from './orchestrator';

const blueprint: LessonBlueprint = {
  blueprintId: 'blueprint-1',
  goal: 'Compare two fractions on one number line',
  mode: 'board_led',
  successCriteria: ['Learner places fractions on one shared scale', 'Learner explains which is larger'],
  anchor: { semanticGroupId: 'lesson-anchor', template: 'fraction_comparison', instructionalQuestion: 'Which fraction is larger?', invariantObjectIds: [] },
  stages: [
    { id: 'orient', kind: 'orient', objective: 'Recall what a fraction shows', boardPurpose: 'establish_anchor', allowedBoardMutation: 'establish', learnerOpportunity: 'Say what the parts mean', evidenceExpected: 'recall' },
    { id: 'model', kind: 'model', objective: 'Place the fractions on the scale', boardPurpose: 'reveal_relation', allowedBoardMutation: 'extend', learnerOpportunity: 'Predict which mark is farther right', evidenceExpected: 'comparison reasoning' },
    { id: 'check', kind: 'guided_check', objective: 'Compare the marks', boardPurpose: 'elicit_learner_work', allowedBoardMutation: 'emphasize', learnerOpportunity: 'Circle the larger fraction', evidenceExpected: 'correct identification' },
  ],
  currentStageIndex: 0,
  detourStack: [],
};

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

  it('holds one durable blueprint: no regeneration, no stage jumps, no anchor changes', () => {
    let state = createLessonState('fractions', 'generation-1');
    state = reduceLesson(state, { type: 'BLUEPRINT_CREATED', blueprint });
    expect(currentStage(state)?.id).toBe('orient');
    expect(state.activeSemanticObjectId).toBe('lesson-anchor');
    // The blueprint is created once; a second one is illegal.
    expect(() => reduceLesson(state, { type: 'BLUEPRINT_CREATED', blueprint: { ...blueprint, blueprintId: 'blueprint-2' } })).toThrow(/already exists/i);
    // A move naming a non-current stage is an illegal jump.
    expect(() => reduceLesson(state, {
      type: 'MOVE_PROPOSED',
      move: { rationale: 'skip', microObjective: 'closure', strategy: 'jump', childFacingText: 'Done!', proposedAction: 'explain', blueprintId: 'blueprint-1', stageId: 'check' },
    })).toThrow(/illegal stage jump/i);
    // The anchor representation cannot change mid-lesson.
    expect(() => reduceLesson(state, {
      type: 'MOVE_PROPOSED',
      move: { rationale: 'new picture', microObjective: 'new diagram', strategy: 'restart', childFacingText: 'New board!', proposedAction: 'visual', anchorGroupId: 'other-anchor' },
    })).toThrow(/anchor/i);
    // A visual move with no board purpose is decorative and rejected.
    expect(() => reduceLesson(state, {
      type: 'MOVE_PROPOSED',
      move: { rationale: 'decoration', microObjective: 'a picture', strategy: 'draw', childFacingText: 'Look!', proposedAction: 'visual', boardPurpose: 'none' },
    })).toThrow(/board purpose/i);
    // Executing the current stage is legal and advances only via evidence.
    state = reduceLesson(state, {
      type: 'MOVE_PROPOSED',
      move: { rationale: 'orient', microObjective: 'Recall what a fraction shows', strategy: 'anchor first', childFacingText: 'Here is our scale.', proposedAction: 'explain', blueprintId: 'blueprint-1', stageId: 'orient', boardPurpose: 'establish_anchor' },
    });
    expect(currentStage(state)?.id).toBe('orient');
  });

  it('advances stages on correct evidence, detours on missing prerequisites, and returns afterwards', () => {
    let state = createLessonState('fractions', 'generation-1');
    state = reduceLesson(state, { type: 'BLUEPRINT_CREATED', blueprint });
    state = reduceLesson(state, { type: 'QUESTION_DELIVERED', taskId: 'task-1', text: 'What does the bottom number mean?' });
    state = reduceLesson(state, { type: 'LEARNER_RESPONSE_RECEIVED' });
    state = reduceLesson(state, { type: 'ASSESSED', classification: 'correct', evidenceId: 'evidence-1' });
    expect(currentStage(state)?.id).toBe('model');

    // A partial answer stays on the stage — the tactic changes, not the plan.
    state = reduceLesson(state, { type: 'QUESTION_DELIVERED', taskId: 'task-2', text: 'Where does one half go?' });
    state = reduceLesson(state, { type: 'LEARNER_RESPONSE_RECEIVED' });
    state = reduceLesson(state, { type: 'ASSESSED', classification: 'partially_correct', evidenceId: 'evidence-2' });
    expect(currentStage(state)?.id).toBe('model');

    // A missing prerequisite records a bounded detour and returns to the
    // recorded stage when resolved — the goal is never replaced.
    state = reduceLesson(state, { type: 'QUESTION_DELIVERED', taskId: 'task-3', text: 'Which is farther right?' });
    state = reduceLesson(state, { type: 'LEARNER_RESPONSE_RECEIVED' });
    state = reduceLesson(state, { type: 'ASSESSED', classification: 'missing_prerequisite', evidenceId: 'evidence-3' });
    expect(state.blueprint?.detourStack).toHaveLength(1);
    expect(currentStage(state)?.id).toBe('model');
    state = reduceLesson(state, { type: 'QUESTION_DELIVERED', taskId: 'task-4', text: 'What does the bottom number count?' });
    state = reduceLesson(state, { type: 'LEARNER_RESPONSE_RECEIVED' });
    state = reduceLesson(state, { type: 'ASSESSED', classification: 'correct', evidenceId: 'evidence-4' });
    expect(state.blueprint?.detourStack).toHaveLength(0);
    expect(currentStage(state)?.id).toBe('model');
  });

  it('upgrades a recorded detour with a compiled mini-plan, travels it, and returns to the recorded stage', () => {
    let state = createLessonState('fractions', 'generation-1');
    state = reduceLesson(state, { type: 'BLUEPRINT_CREATED', blueprint: { ...blueprint, currentStageIndex: 1 } });
    state = reduceLesson(state, { type: 'QUESTION_DELIVERED', taskId: 'task-1', text: 'Where does two thirds go?' });
    state = reduceLesson(state, { type: 'LEARNER_RESPONSE_RECEIVED' });
    state = reduceLesson(state, { type: 'ASSESSED', classification: 'missing_prerequisite', evidenceId: 'evidence-1' });
    expect(state.blueprint?.detourStack).toHaveLength(1);

    // The compiler's mini-plan upgrades the already-recorded simple detour
    // in place; the stack does not grow and the main route is untouched.
    state = reduceLesson(state, {
      type: 'DETOUR_PLANNED',
      reason: 'missing prerequisite',
      stages: [
        { id: 'detour-parts', kind: 'orient', objective: 'What the denominator counts', boardPurpose: 'none', allowedBoardMutation: 'none', learnerOpportunity: 'Say what the bottom number means', evidenceExpected: 'recall' },
        { id: 'detour-thirds', kind: 'guided_check', objective: 'Split a whole into thirds', boardPurpose: 'none', allowedBoardMutation: 'none', learnerOpportunity: 'Mark one third', evidenceExpected: 'application' },
      ],
    });
    expect(state.blueprint?.detourStack).toHaveLength(1);
    expect(currentStage(state)?.id).toBe('detour-parts');
    expect(state.microObjective).toBe('What the denominator counts');

    // Correct evidence advances through the detour plan, one stage at a time.
    state = reduceLesson(state, { type: 'QUESTION_DELIVERED', taskId: 'task-2', text: 'What does the bottom number count?' });
    state = reduceLesson(state, { type: 'LEARNER_RESPONSE_RECEIVED' });
    state = reduceLesson(state, { type: 'ASSESSED', classification: 'correct', evidenceId: 'evidence-2' });
    expect(state.blueprint?.detourStack).toHaveLength(1);
    expect(currentStage(state)?.id).toBe('detour-thirds');

    // Finishing the last detour stage pops the detour and returns to the
    // recorded main stage, exactly like a simple detour resolution.
    state = reduceLesson(state, { type: 'QUESTION_DELIVERED', taskId: 'task-3', text: 'Mark one third.' });
    state = reduceLesson(state, { type: 'LEARNER_RESPONSE_RECEIVED' });
    state = reduceLesson(state, { type: 'ASSESSED', classification: 'correct', evidenceId: 'evidence-3' });
    expect(state.blueprint?.detourStack).toHaveLength(0);
    expect(currentStage(state)?.id).toBe('model');
  });

  it('allows a conversation-led visual move even when the stage has no required scene', () => {
    const conversation: LessonBlueprint = {
      ...blueprint,
      mode: 'conversation_led',
      anchor: null,
      stages: blueprint.stages.map((stage) => ({
        ...stage,
        boardPurpose: 'none',
        allowedBoardMutation: 'none',
      })),
    };
    let state = reduceLesson(createLessonState('fractions', 'generation-1'), { type: 'BLUEPRINT_CREATED', blueprint: conversation });
    state = reduceLesson(state, {
      type: 'MOVE_PROPOSED',
      move: {
        rationale: 'Learner asked for a picture',
        microObjective: 'Sketch the idea',
        strategy: 'draw',
        childFacingText: 'Here is a simple picture.',
        proposedAction: 'visual',
        blueprintId: conversation.blueprintId,
        stageId: 'orient',
        boardPurpose: 'none',
      },
    });
    expect(state.phase).toBe('VISUALIZE');
    expect(state.owedAction).toBe('visual');
  });

  it('rejects detour plans without a blueprint and enforces the one-to-two stage bound', () => {
    const bare = createLessonState('fractions', 'generation-1');
    const stage = { id: 'detour', kind: 'orient' as const, objective: 'Prerequisite', boardPurpose: 'none' as const, allowedBoardMutation: 'none' as const, learnerOpportunity: 'Try', evidenceExpected: 'recall' };
    expect(() => reduceLesson(bare, { type: 'DETOUR_PLANNED', reason: 'gap', stages: [stage] })).toThrow(/blueprint/i);
    let state = reduceLesson(createLessonState('fractions', 'generation-1'), { type: 'BLUEPRINT_CREATED', blueprint });
    expect(() => reduceLesson(state, {
      type: 'DETOUR_PLANNED',
      reason: 'gap',
      stages: [stage, { ...stage, id: 'detour-2' }, { ...stage, id: 'detour-3' }],
    })).toThrow();
    // Without a prior simple detour the plan opens its own bounded entry.
    state = reduceLesson(state, { type: 'DETOUR_PLANNED', reason: 'gap', stages: [stage] });
    expect(state.blueprint?.detourStack).toHaveLength(1);
    expect(currentStage(state)?.id).toBe('detour');
    // While a planned detour is open, a move naming the main stage is an
    // illegal jump; the detour stage is the current stage.
    expect(() => reduceLesson(state, {
      type: 'MOVE_PROPOSED',
      move: { rationale: 'jump', microObjective: 'skip ahead', strategy: 'jump', childFacingText: 'Back to the scale.', proposedAction: 'explain', stageId: 'orient' },
    })).toThrow(/illegal stage jump/i);
  });

  it('refuses completion before the blueprint route and evidence exist', () => {
    let state = createLessonState('fractions', 'generation-1');
    state = reduceLesson(state, { type: 'BLUEPRINT_CREATED', blueprint });
    expect(() => reduceLesson(state, { type: 'COMPLETE' })).toThrow(/final stage/i);
    state = { ...state, blueprint: { ...blueprint, currentStageIndex: 2 } };
    expect(() => reduceLesson(state, { type: 'COMPLETE' })).toThrow(/evidence/i);
    state = { ...state, conceptEvidenceIds: ['evidence-1', 'evidence-2'] };
    expect(reduceLesson(state, { type: 'COMPLETE' }).phase).toBe('COMPLETE');
    // An open detour also blocks completion.
    const detoured = { ...state, blueprint: { ...state.blueprint as LessonBlueprint, detourStack: [{ reason: 'gap', returnStageIndex: 2 }] } };
    expect(() => reduceLesson(detoured, { type: 'COMPLETE' })).toThrow(/detour/i);
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
