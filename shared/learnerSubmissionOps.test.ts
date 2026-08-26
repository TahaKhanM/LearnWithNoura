import { describe, expect, it } from 'vitest';
import { learnerBoardOps } from './learnerSubmissionOps.js';

describe('learnerBoardOps manipulative updates', () => {
  const markerId = 'lesson-anchor-marker';
  const targets = new Set([markerId]);

  it('persists Done marker updates when the target is a visible manipulative', () => {
    const ops = learnerBoardOps([
      { op: 'update', id: markerId, props: { at: [685, 300] } },
    ], { manipulativeTargetIds: targets });
    expect(ops).toEqual([{ op: 'update', id: markerId, props: { at: [685, 300] } }]);
  });

  it('rejects forged snap-zone interval props even when the zone id is listed', () => {
    const ops = learnerBoardOps([
      { op: 'update', id: 'lesson-anchor-zone-three-quarters', props: { from: 0, to: 1 } },
    ], { manipulativeTargetIds: new Set(['lesson-anchor-zone-three-quarters']) });
    expect(ops).toEqual([]);
  });

  it('rejects manipulative updates to ids that are not visible learner targets', () => {
    const ops = learnerBoardOps([
      { op: 'update', id: markerId, props: { at: [685, 300] } },
    ]);
    expect(ops).toEqual([]);
  });

  it('replays stored manipulative updates without re-checking membership', () => {
    const ops = learnerBoardOps([
      { op: 'update', id: markerId, props: { at: [685, 300] } },
    ], { trustPersistedManipulativeUpdates: true });
    expect(ops).toEqual([{ op: 'update', id: markerId, props: { at: [685, 300] } }]);
  });

  it('still accepts sketch path add and erase ops', () => {
    const ops = learnerBoardOps([
      { op: 'add', id: 'sketch-a', spec: { kind: 'path', points: [[1, 1], [2, 2]] } },
      { op: 'erase', id: 'sketch-a' },
    ]);
    expect(ops).toHaveLength(2);
  });
});
