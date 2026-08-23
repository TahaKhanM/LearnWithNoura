import { describe, expect, it } from 'vitest';
import { BoardContextTracker, loadReleasedBoardContext } from './boardContext';
import { openTestDb } from '../store/db';
import { Repo } from '../store/repo';

describe('released board context', () => {
  it('reconstructs only visible tutor/learner state and exposes reusable IDs', async () => {
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'angles');
    repo.addEvent(session.id, 'board_ops', { ops: [{ op: 'add', id: 'visible-triangle', spec: { kind: 'polygon', points: [[0, 0], [10, 20], [20, 0]] } }] }, true);
    repo.addEvent(session.id, 'board_ops', { ops: [{ op: 'add', id: 'unheard-label', spec: { kind: 'text', at: [20, 20], text: 'future' } }] }, false);
    repo.addEvent(session.id, 'learner_board', { ops: [{ op: 'add', id: 'sketch-arrow', spec: { kind: 'path', points: [[1, 1], [2, 3], [4, 4]] } }] }, true);

    const board = await loadReleasedBoardContext(repo, session.id);
    const snapshot = board.toolSnapshot();
    expect(snapshot.visibleObjectIds).toEqual(['visible-triangle', 'sketch-arrow']);
    expect(snapshot.summary).toContain('sketch-arrow [learner]');
    expect(snapshot.summary).not.toContain('unheard-label');
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
});
