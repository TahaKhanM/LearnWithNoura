import { describe, expect, it } from 'vitest';
import type { BoardOp } from '../../shared/boardOps';
import { BoardSceneCoordinator } from './sceneCoordinator';

describe('BoardSceneCoordinator', () => {
  it('keeps a released tutor checkpoint while learner and later tutor updates interleave', () => {
    const board = new BoardSceneCoordinator();
    const tutor: BoardOp = {
      op: 'add', id: 'tutor-axis', spec: { kind: 'line', from: [100, 250], to: [800, 250] },
    };
    const learner: BoardOp = {
      op: 'add', id: 'sketch-learner', spec: { kind: 'path', points: [[220, 180], [260, 220], [300, 190]] },
    };
    const tutorLabel: BoardOp = {
      op: 'add', id: 'tutor-label', spec: { kind: 'text', at: [120, 180], text: 'Shared scale' },
    };

    expect(board.applyTutorCheckpoint([tutor])).not.toBeNull();
    board.applyLearner([learner]);
    expect(board.applyTutorCheckpoint([tutorLabel])).not.toBeNull();

    expect(board.current.items.map((item) => [item.id, item.owner])).toEqual([
      ['tutor-axis', 'tutor'],
      ['sketch-learner', 'learner'],
      ['tutor-label', 'tutor'],
    ]);
  });

  it('keeps learner marks when the tutor clears its own layer', () => {
    const board = new BoardSceneCoordinator();
    board.applyTutorCheckpoint([{ op: 'add', id: 'tutor-line', spec: { kind: 'line', from: [100, 100], to: [300, 100] } }]);
    board.applyLearner([{ op: 'add', id: 'sketch-kept', spec: { kind: 'path', points: [[120, 140], [180, 160]] } }]);

    expect(board.applyTutorCheckpoint([{ op: 'clear' }])).not.toBeNull();
    expect(board.current.items.map((item) => item.id)).toEqual(['sketch-kept']);
  });

  it('never moves an edge-drawn learner stroke while inspecting a tutor checkpoint', () => {
    const board = new BoardSceneCoordinator();
    const points: [number, number][] = [[0, 0], [12, 8], [24, 4]];
    board.applyLearner([{ op: 'add', id: 'sketch-edge', spec: { kind: 'path', points } }]);

    expect(board.applyTutorCheckpoint([
      { op: 'add', id: 'tutor-center', spec: { kind: 'text', at: [450, 260], text: 'Centre idea' } },
    ])).not.toBeNull();
    expect(board.current.items.find((item) => item.id === 'sketch-edge')?.spec).toEqual({ kind: 'path', points });
  });
});
