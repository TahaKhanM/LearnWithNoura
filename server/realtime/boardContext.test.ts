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

  it('describes handwritten text in the board summary', () => {
    const board = new BoardContextTracker();
    board.apply([{
      op: 'add',
      id: 'margin-note',
      spec: { kind: 'text', at: [80, 80], text: 'watch this', style: 'handwritten' },
    }], 'tutor', 'notes', 'Notes');
    expect(board.toolSnapshot().summary).toContain('text “watch this”, handwritten');
  });

  it('replays persisted manipulative marker updates on reconnect', () => {
    const board = new BoardContextTracker();
    board.apply([
      { op: 'add', id: 'fraction-line', spec: { kind: 'numberline', at: [130, 300], w: 740, min: 0, max: 1 } },
      { op: 'add', id: 'fraction-marker', spec: { kind: 'draggable', handle: 'token', at: [200, 300], size: 44 } },
    ], 'tutor', 'fractions', 'Fractions');
    board.apply([
      { op: 'update', id: 'fraction-marker', props: { at: [685, 300] } },
    ], 'learner', 'fractions', 'Fractions');
    const marker = board.manipulativeSceneItems().find((item) => item.id === 'fraction-marker');
    expect(marker?.spec.kind === 'draggable' ? marker.spec.at : null).toEqual([685, 300]);
  });

  it('applies a live fast-tier point update of at and refuses authored image mutation', () => {
    const board = new BoardContextTracker();
    board.apply([
      { op: 'add', id: 'p1', spec: { kind: 'point', at: [10, 20] } },
      { op: 'add', id: 'pond', spec: { kind: 'image', assetId: 'img-a1b2c3d4e5f67890', at: [80, 60], w: 840, h: 420, alt: 'A pond' } },
    ], 'tutor', 'scene', 'Scene', { tier: 'authored' });
    board.apply([{ op: 'update', id: 'p1', props: { at: [120, 80] } }], 'tutor');
    board.apply([{ op: 'update', id: 'pond', props: { at: [100, 80] } }], 'tutor');
    const items = board.manipulativeSceneItems();
    expect(items.find((item) => item.id === 'p1')?.spec).toMatchObject({ kind: 'point', at: [120, 80] });
    expect(items.find((item) => item.id === 'pond')?.spec).toMatchObject({ kind: 'image', at: [80, 60] });
  });

  it('honors op.semanticGroupId on add when apply is not given a group', () => {
    const board = new BoardContextTracker();
    board.apply([
      { op: 'add', id: 'op-grouped', spec: { kind: 'box', at: [500, 300], text: 'one' }, semanticGroupId: 'from-op' },
    ], 'tutor');
    expect(board.visibleOps()).toEqual([
      expect.objectContaining({ id: 'op-grouped', semanticGroupId: 'from-op' }),
    ]);
  });

  it('emits visible ops that preserve region membership for the current-board raster', () => {
    const board = new BoardContextTracker();
    board.apply([{ op: 'add', id: 'one-box', spec: { kind: 'box', at: [500, 300], text: 'one' } }], 'tutor', 'region-one');
    board.apply([{ op: 'add', id: 'two-box', spec: { kind: 'box', at: [500, 300], text: 'two' } }], 'tutor', 'region-two');
    expect(board.visibleOps()).toEqual([
      expect.objectContaining({ id: 'one-box', semanticGroupId: 'region-one' }),
      expect.objectContaining({ id: 'two-box', semanticGroupId: 'region-two' }),
    ]);
  });
});
