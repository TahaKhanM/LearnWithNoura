import { describe, expect, it } from 'vitest';
import { applyOps, emptyScene } from './scene';
import { LearnerDraftController } from '../lesson/learnerDraft';

describe('manipulative draft lifecycle', () => {
  it('records one draft entry per completed drag gesture', () => {
    const draft = new LearnerDraftController();
    draft.begin({ taskId: 'place-marker' });
    draft.addManipulativeUpdate(
      { op: 'update', id: 'marker', props: { at: [685, 300] } },
      { op: 'update', id: 'marker', props: { at: [200, 300] } },
      'moved marker',
    );
    expect(draft.getSnapshot().entryCount).toBe(1);
  });

  it('undo and redo restore draggable position during an open draft', () => {
    const scene = applyOps(emptyScene, [{
      op: 'add',
      id: 'marker',
      spec: { kind: 'draggable', handle: 'token', at: [200, 300], size: 44 },
    }], 'tutor').scene;
    const draft = new LearnerDraftController();
    draft.begin({ taskId: 'place-marker' });
    const move = { op: 'update' as const, id: 'marker', props: { at: [685, 300] } };
    const inverse = { op: 'update' as const, id: 'marker', props: { at: [200, 300] } };
    draft.addManipulativeUpdate(move, inverse, 'moved marker');
    expect(draft.getSnapshot().entryCount).toBe(1);
    const undoOp = draft.undo();
    expect(undoOp).toEqual(inverse);
    const afterUndo = applyOps(scene, [undoOp as typeof move], 'learner', undefined, { manipulativeDraft: true }).scene;
    expect(afterUndo.items[0].spec.kind === 'draggable' ? afterUndo.items[0].spec.at : null).toEqual([200, 300]);
    const redoOp = draft.redo();
    expect(redoOp).toEqual(move);
  });

  it('allows Done with no moves for manipulate tasks', () => {
    const draft = new LearnerDraftController();
    draft.begin({ taskId: 'tap-angle' });
    const frozen = draft.beginSubmit({ allowEmpty: true });
    expect(frozen?.ops).toEqual([]);
  });
});
