import { describe, expect, it } from 'vitest';
import { BoardContextTracker, loadReleasedBoardContext } from './boardContext';
import { openTestDb } from '../store/db';
import { Repo } from '../store/repo';

describe('released board context', () => {
  it('reconstructs only visible tutor/learner state and exposes reusable IDs', async () => {
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'angles');
    repo.addEvent(session.id, 'board_ops', { semanticObjectId: 'angle-proof', ops: [{ op: 'add', id: 'visible-triangle', spec: { kind: 'polygon', points: [[0, 0], [10, 20], [20, 0]] } }] }, true);
    repo.addEvent(session.id, 'board_ops', { ops: [{ op: 'add', id: 'unheard-label', spec: { kind: 'text', at: [20, 20], text: 'future' } }] }, false);
    repo.addEvent(session.id, 'learner_board', {
      semanticObjectId: 'angle-proof',
      ops: [{ op: 'add', id: 'sketch-arrow', spec: { kind: 'path', points: [[1, 1], [2, 3], [4, 4]] } }],
      analysis: {
        version: '1.0.0', semanticGroupId: 'angle-proof', erasedIds: [], summary: 'pointing_mark sketch-arrow near visible-triangle',
        strokes: [{ id: 'sketch-arrow', gesture: 'pointing_mark', bounds: { x: 1, y: 1, w: 3, h: 3 }, centroid: [2, 3], length: 5, straightness: 0.8, closure: 1, corners: 2, nearestObjectIds: ['visible-triangle'], touchedObjectIds: ['visible-triangle'] }],
      },
    }, true);
    repo.addEvent(session.id, 'board_rejected', { reason: 'Too many labels in the section.' }, true);

    const board = await loadReleasedBoardContext(repo, session.id);
    const snapshot = board.toolSnapshot();
    expect(snapshot.visibleObjectIds).toEqual(['visible-triangle', 'sketch-arrow']);
    expect(snapshot.summary).toContain('sketch-arrow [region 1 of 1: angle-proof] [learner]');
    expect(snapshot.summary).not.toContain('unheard-label');
    expect(snapshot.visibleGroups).toEqual([{ id: 'angle-proof', objectCount: 2, learnerMarkCount: 1 }]);
    expect(snapshot.recentLearnerObservations).toEqual(['pointing_mark sketch-arrow near visible-triangle']);
    expect(snapshot.recentRejections).toEqual(['Too many labels in the section.']);
  });

  it('suppresses exact redraws under new IDs and retains true additions', () => {
    const board = new BoardContextTracker();
    board.apply([{ op: 'add', id: 'existing-line', spec: { kind: 'line', from: [10, 10], to: [90, 90] } }], 'tutor');
    const result = board.novelTutorOps([
      { op: 'add', id: 'duplicate-line', spec: { kind: 'line', from: [10, 10], to: [90, 90] } },
      { op: 'add', id: 'new-line', spec: { kind: 'line', from: [10, 90], to: [90, 10] } },
    ]);
    expect(result.ops).toEqual([expect.objectContaining({ id: 'new-line' })]);
    expect(result.duplicates).toEqual([{ requestedId: 'duplicate-line', existingId: 'existing-line' }]);
  });

  it('recognizes a mostly equivalent scene so the agent can reuse the visible group', () => {
    const board = new BoardContextTracker();
    board.apply([
      { op: 'add', id: 'old-triangle', spec: { kind: 'polygon', points: [[0, 0], [10, 20], [20, 0]] } },
      { op: 'add', id: 'old-base', spec: { kind: 'line', from: [0, 0], to: [20, 0] } },
    ], 'tutor');
    expect(board.equivalentTutorScene([
      { op: 'add', id: 'new-triangle', spec: { kind: 'polygon', points: [[0, 0], [10, 20], [20, 0]] } },
      { op: 'add', id: 'new-base', spec: { kind: 'line', from: [0, 0], to: [20, 0] } },
      { op: 'add', id: 'new-label', spec: { kind: 'text', at: [30, 30], text: 'extra' } },
    ]).equivalent).toBe(true);
  });

  it('focuses inspection on one requested section without losing the authoritative fallback', () => {
    const board = new BoardContextTracker();
    board.apply([{ op: 'add', id: 'fraction-line', spec: { kind: 'line', from: [1, 1], to: [2, 2] } }], 'tutor', 'fractions', 'Fractions');
    board.apply([{ op: 'add', id: 'angle-line', spec: { kind: 'line', from: [3, 3], to: [4, 4] } }], 'tutor', 'angles', 'Angles');
    expect(board.toolSnapshot('angles').visibleObjectIds).toEqual(['angle-line']);
    expect(board.toolSnapshot('missing').visibleObjectIds).toEqual(['fraction-line', 'angle-line']);
  });
});
