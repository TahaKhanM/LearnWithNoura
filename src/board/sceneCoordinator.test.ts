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

  it('inspects overlapping semantic groups independently', () => {
    const board = new BoardSceneCoordinator();
    expect(board.applyTutorCheckpoint([
      { op: 'add', id: 'group-one-box', spec: { kind: 'box', at: [500, 300], text: 'First page' } },
    ], 'group-one')).not.toBeNull();
    expect(board.applyTutorCheckpoint([
      { op: 'add', id: 'group-two-box', spec: { kind: 'box', at: [500, 300], text: 'Second page' } },
    ], 'group-two')).not.toBeNull();
    expect(board.current.items.map((item) => [item.id, item.semanticGroupId])).toEqual([
      ['group-one-box', 'group-one'], ['group-two-box', 'group-two'],
    ]);
  });

  it('replays released historical work even when it exceeds the new live density budget', () => {
    const board = new BoardSceneCoordinator();
    const ops = Array.from({ length: 31 }, (_, index) => ({
      op: 'add' as const, id: `historical-${index}`,
      spec: { kind: 'line' as const, from: [40 + index, 100] as [number, number], to: [40 + index, 300] as [number, number] },
    }));
    expect(board.applyReplay(ops, 'tutor', 'historical')).not.toBeNull();
    expect(board.current.items).toHaveLength(31);
  });

  it('replaces one section atomically in a single commit, preserving other sections and learner marks', () => {
    const board = new BoardSceneCoordinator();
    board.applyTutorCheckpoint([{ op: 'add', id: 'model-box', spec: { kind: 'box', at: [500, 300], text: 'Old model' } }], 'working-model');
    board.applyTutorCheckpoint([{ op: 'add', id: 'other-box', spec: { kind: 'box', at: [500, 300], text: 'Other page' } }], 'other-section');
    board.applyLearner([{ op: 'add', id: 'sketch-kept', spec: { kind: 'path', points: [[120, 140], [180, 160]] } }], 'working-model');

    const applied = board.applyTutorCheckpoint([
      { op: 'add', id: 'new-model-box', spec: { kind: 'box', at: [500, 300], text: 'New model' } },
    ], 'working-model', 'working-model');
    // The committed scene simultaneously drops the old tutor content and
    // shows the replacement — the swap is one state, never a blank interim.
    expect(applied).not.toBeNull();
    const ids = applied?.scene.items.map((item) => item.id);
    expect(ids).not.toContain('model-box');
    expect(ids).toContain('new-model-box');
    expect(ids).toContain('other-box');
    expect(ids).toContain('sketch-kept');
  });

  it('preflights a complete candidate plan without mutating the visible scene', () => {
    const board = new BoardSceneCoordinator();
    board.applyTutorCheckpoint([{ op: 'add', id: 'base-box', spec: { kind: 'box', at: [500, 300], text: 'Base' } }], 'base');
    const before = board.current;

    const good = board.preflightTutorOps([
      { op: 'add', id: 'plan-box', spec: { kind: 'box', at: [500, 300], text: 'Planned idea' } },
    ], 'plan-section');
    expect(good.accepted).toBe(true);
    expect(board.current).toBe(before);

    // A plan violating the density budget is rejected — before anything is
    // shown or the model is told it was accepted.
    const dense = board.preflightTutorOps(Array.from({ length: 31 }, (_, index) => ({
      op: 'add' as const, id: `dense-${index}`,
      spec: { kind: 'line' as const, from: [40 + index * 4, 100] as [number, number], to: [40 + index * 4, 300] as [number, number] },
    })), 'dense-section');
    expect(dense.accepted).toBe(false);
    expect(dense.reasons.join(' ')).toMatch(/density/);
    expect(board.current).toBe(before);
  });
});
