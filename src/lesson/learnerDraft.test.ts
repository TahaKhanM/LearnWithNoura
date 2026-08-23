import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddOp } from '../../shared/boardOps';
import { LearnerDraftController } from './learnerDraft';

beforeEach(() => window.sessionStorage.clear());

function stroke(id: string): AddOp {
  return { op: 'add', id, color: '#2C5BE0', spec: { kind: 'path', points: [[10, 10], [40, 40], [70, 20]] } };
}

describe('LearnerDraftController', () => {
  it('never auto-submits: arbitrary pauses leave the draft open and untouched', () => {
    vi.useFakeTimers();
    try {
      const controller = new LearnerDraftController();
      controller.begin();
      controller.addStroke(stroke('sketch-1'), 'first stroke');
      vi.advanceTimersByTime(30_000);
      controller.addStroke(stroke('sketch-2'), 'second stroke');
      vi.advanceTimersByTime(120_000);
      const snapshot = controller.getSnapshot();
      expect(snapshot.status).toBe('open');
      expect(snapshot.entryCount).toBe(2);
      expect(snapshot.pendingSubmissionId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('undo, redo, and clear edit the draft and shape the final submission', () => {
    const controller = new LearnerDraftController();
    controller.begin();
    controller.addStroke(stroke('sketch-1'), 'first');
    controller.addStroke(stroke('sketch-2'), 'second');
    expect(controller.undo()).toEqual({ op: 'erase', id: 'sketch-2' });
    expect(controller.getSnapshot().canRedo).toBe(true);
    expect(controller.redo()).toMatchObject({ op: 'add', id: 'sketch-2' });
    controller.addStroke(stroke('sketch-3'), 'third');
    expect(controller.undo()).toEqual({ op: 'erase', id: 'sketch-3' });
    const frozen = controller.beginSubmit();
    expect(frozen?.ops.map((op) => 'id' in op ? op.id : '')).toEqual(['sketch-1', 'sketch-2']);

    const clearing = new LearnerDraftController();
    clearing.begin();
    clearing.addStroke(stroke('sketch-a'), 'a');
    clearing.addStroke(stroke('sketch-b'), 'b');
    expect(clearing.clear()).toEqual([{ op: 'erase', id: 'sketch-b' }, { op: 'erase', id: 'sketch-a' }]);
    expect(clearing.getSnapshot().entryCount).toBe(0);
    expect(clearing.getSnapshot().status).toBe('open');
    // An empty draft cannot be submitted.
    expect(clearing.beginSubmit()).toBeNull();
  });

  it('erase entries are undoable back to the original stroke', () => {
    const controller = new LearnerDraftController();
    controller.begin();
    const original = stroke('sketch-old');
    controller.addErase({ op: 'erase', id: 'sketch-old' }, original, 'erased a mark');
    expect(controller.undo()).toEqual(original);
  });

  it('submission is idempotent per frozen revision; new edits mint a new id', () => {
    const controller = new LearnerDraftController();
    controller.begin();
    controller.addStroke(stroke('sketch-1'), 'first');
    const first = controller.beginSubmit();
    expect(first).not.toBeNull();
    controller.submitFailed('offline');
    expect(controller.getSnapshot().status).toBe('error');
    // Retrying the identical drawing reuses the same submission id.
    const retry = controller.beginSubmit();
    expect(retry?.submissionId).toBe(first?.submissionId);
    controller.submitFailed('offline again');
    // Editing after a failure invalidates the frozen id.
    controller.resumeEditing();
    controller.addStroke(stroke('sketch-2'), 'second');
    const edited = controller.beginSubmit();
    expect(edited?.submissionId).not.toBe(first?.submissionId);
    controller.submitSucceeded();
    expect(controller.getSnapshot().status).toBe('idle');
    expect(controller.isOpen).toBe(false);
  });

  it('cancel reverts every mark and closes the draft', () => {
    const controller = new LearnerDraftController();
    controller.begin();
    controller.addStroke(stroke('sketch-1'), 'first');
    controller.addStroke(stroke('sketch-2'), 'second');
    expect(controller.cancel()).toEqual([{ op: 'erase', id: 'sketch-2' }, { op: 'erase', id: 'sketch-1' }]);
    expect(controller.isOpen).toBe(false);
  });

  it('restores an unsubmitted draft after a reload and clears storage on success', () => {
    const key = 'noura.draft.session-restore';
    const first = new LearnerDraftController(key);
    first.begin({ semanticGroupId: 'fraction-scale', taskId: 'compare-task' });
    first.addStroke(stroke('sketch-1'), 'first');
    first.addStroke(stroke('sketch-2'), 'second');

    const reloaded = new LearnerDraftController(key);
    const restored = reloaded.restore();
    expect(restored?.ops.map((op) => 'id' in op ? op.id : '')).toEqual(['sketch-1', 'sketch-2']);
    expect(restored?.semanticGroupId).toBe('fraction-scale');
    expect(reloaded.getSnapshot().status).toBe('open');
    expect(reloaded.getSnapshot().taskId).toBe('compare-task');

    reloaded.beginSubmit();
    reloaded.submitSucceeded();
    expect(window.sessionStorage.getItem(key)).toBeNull();
    expect(new LearnerDraftController(key).restore()).toBeNull();
  });
});
