import { describe, expect, it } from 'vitest';
import { evaluateManipulativeCheck } from '../../shared/manipulativeCheck';
import { createLessonState } from '../lesson/orchestrator';
import { BoardContextTracker } from './boardContext';
import { evaluateBoardSubmissionCheck, serverOwnedManipulativeCheck } from './manipulativeSubmission';

const deliveredCheck = {
  targetId: 'fraction-marker',
  predicate: 'snapped' as const,
  snapZoneId: 'zone-three-quarters',
  tolerance: 12,
};

const trivialClientCheck = {
  targetId: 'fraction-marker',
  predicate: 'within' as const,
  bounds: { at: [200, 300] as [number, number], w: 800, h: 400 },
  tolerance: 200,
};

function boardWithMarkerAt(at: [number, number]): BoardContextTracker {
  const board = new BoardContextTracker();
  board.apply([
    { op: 'add', id: 'fraction-line', spec: { kind: 'numberline', at: [130, 300], w: 740, min: 0, max: 1 } },
    { op: 'add', id: 'zone-three-quarters', spec: { kind: 'snapZone', shape: 'interval', at: [685, 300], from: 0.7, to: 0.8, numberlineId: 'fraction-line' } },
    { op: 'add', id: 'fraction-marker', spec: { kind: 'draggable', handle: 'token', at, size: 44 } },
  ], 'tutor', 'fractions', 'Fractions');
  return board;
}

describe('server-owned manipulative re-eval', () => {
  it('ignores a trivial client within spec when the delivered check would fail', () => {
    const lessonState = createLessonState('Compare fractions');
    lessonState.blueprint = {
      blueprintId: 'bp-1',
      goal: 'Compare fractions',
      mode: 'board_led',
      successCriteria: ['Place the marker on three quarters'],
      anchor: {
        semanticGroupId: 'lesson-anchor',
        template: 'fraction_comparison',
        instructionalQuestion: 'Move the marker',
        invariantObjectIds: [],
      },
      stages: [{
        id: 'check',
        kind: 'guided_check',
        objective: 'Place three quarters',
        boardPurpose: 'elicit_learner_work',
        allowedBoardMutation: 'emphasize',
        learnerOpportunity: 'Move the marker',
        evidenceExpected: 'placement',
        checks: [{
          id: 'place-three-quarters',
          questionOrTask: 'Move the marker to three quarters',
          responseMode: 'manipulate',
          manipulativeCheck: deliveredCheck,
        }],
      }],
      currentStageIndex: 0,
      detourStack: [],
    };

    const board = boardWithMarkerAt([200, 300]);
    const clientWouldPass = evaluateManipulativeCheck({
      check: trivialClientCheck,
      items: board.manipulativeSceneItems(),
    });
    expect(clientWouldPass.passed).toBe(true);

    const serverCheck = serverOwnedManipulativeCheck({
      taskId: 'place-three-quarters',
      lessonState,
      pendingTask: null,
    });
    expect(serverCheck).toEqual(deliveredCheck);

    const result = evaluateBoardSubmissionCheck({
      taskId: 'place-three-quarters',
      clientCheck: trivialClientCheck,
      lessonState,
      pendingTask: null,
      items: board.manipulativeSceneItems(),
    });
    expect(result).not.toBeNull();
    expect(result?.passed).toBe(false);
    expect(result?.localCheckPassed).toBe(false);
  });

  it('fails closed when no server-owned check exists for the task', () => {
    const result = evaluateBoardSubmissionCheck({
      taskId: 'unknown-task',
      clientCheck: trivialClientCheck,
      lessonState: createLessonState('Compare fractions'),
      pendingTask: null,
      items: boardWithMarkerAt([200, 300]).manipulativeSceneItems(),
    });
    expect(result).toBeNull();
  });
});
