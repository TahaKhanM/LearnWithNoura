import type { AddOp, BoardOp, EraseOp } from '../../shared/boardOps';

/**
 * Owns the learner's drawing draft.
 *
 * A draft is the learner still composing: strokes, pauses (of any length),
 * erases, undo/redo, and clearing are all local edits. Nothing is captured,
 * graded, or sent to the model until the learner explicitly submits. The
 * controller only records intent; callers apply the ops it returns to the
 * visible scene.
 */

export interface DraftEntry {
  /** The op as it was applied to the board. */
  op: BoardOp;
  /** The op that undoes it, or null when it cannot be undone. */
  inverse: BoardOp | null;
  note: string;
}

export type DraftStatus = 'idle' | 'open' | 'submitting' | 'error';

export interface DraftSnapshot {
  status: DraftStatus;
  draftId: string | null;
  taskId?: string;
  semanticGroupId?: string;
  entryCount: number;
  canUndo: boolean;
  canRedo: boolean;
  error: string | null;
  pendingSubmissionId: string | null;
}

interface PersistedDraft {
  draftId: string;
  taskId?: string;
  semanticGroupId?: string;
  entries: DraftEntry[];
}

export class LearnerDraftController {
  private entries: DraftEntry[] = [];
  private redoStack: DraftEntry[] = [];
  private status: DraftStatus = 'idle';
  private draftId: string | null = null;
  private taskId: string | undefined;
  private semanticGroupId: string | undefined;
  private error: string | null = null;
  private pendingSubmissionId: string | null = null;
  private listeners = new Set<() => void>();
  private cachedSnapshot: DraftSnapshot | null = null;
  private readonly storageKey?: string;

  constructor(storageKey?: string) {
    this.storageKey = storageKey;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DraftSnapshot => {
    this.cachedSnapshot ??= {
      status: this.status,
      draftId: this.draftId,
      ...(this.taskId ? { taskId: this.taskId } : {}),
      ...(this.semanticGroupId ? { semanticGroupId: this.semanticGroupId } : {}),
      entryCount: this.entries.length,
      canUndo: this.status === 'open' || this.status === 'error' ? this.entries.length > 0 : false,
      canRedo: this.status === 'open' || this.status === 'error' ? this.redoStack.length > 0 : false,
      error: this.error,
      pendingSubmissionId: this.pendingSubmissionId,
    };
    return this.cachedSnapshot;
  };

  get isOpen(): boolean {
    return this.status === 'open' || this.status === 'submitting' || this.status === 'error';
  }

  /** Opens a draft. Idempotent while one is already open. */
  begin(context: { taskId?: string; semanticGroupId?: string } = {}): string {
    if (this.isOpen && this.draftId) {
      if (context.taskId && !this.taskId) this.taskId = context.taskId;
      this.notify();
      return this.draftId;
    }
    this.draftId = `draft-${crypto.randomUUID()}`;
    this.entries = [];
    this.redoStack = [];
    this.status = 'open';
    this.error = null;
    this.pendingSubmissionId = null;
    this.taskId = context.taskId;
    this.semanticGroupId = context.semanticGroupId;
    this.notify();
    return this.draftId;
  }

  addStroke(op: AddOp, note: string): void {
    if (!this.isOpen) return;
    this.entries.push({ op, inverse: { op: 'erase', id: op.id }, note });
    this.redoStack = [];
    this.recover();
    this.notify();
  }

  /** Erasing an existing learner mark is a draft edit like any stroke. */
  addErase(op: EraseOp, original: AddOp | null, note: string): void {
    if (!this.isOpen) return;
    this.entries.push({ op, inverse: original, note });
    this.redoStack = [];
    this.recover();
    this.notify();
  }

  /** A learner move of a draggable or tap target during a manipulate task. */
  addManipulativeUpdate(op: BoardOp, inverse: BoardOp | null, note: string): void {
    if (!this.isOpen || op.op !== 'update') return;
    this.entries.push({ op, inverse, note });
    this.redoStack = [];
    this.recover();
    this.notify();
  }

  /** Returns the op that reverts the latest edit, to apply to the scene. */
  undo(): BoardOp | null {
    if (!this.isOpen || this.entries.length === 0) return null;
    const entry = this.entries.pop() as DraftEntry;
    this.redoStack.push(entry);
    this.recover();
    this.notify();
    return entry.inverse;
  }

  /** Returns the op to re-apply for the most recently undone edit. */
  redo(): BoardOp | null {
    if (!this.isOpen || this.redoStack.length === 0) return null;
    const entry = this.redoStack.pop() as DraftEntry;
    this.entries.push(entry);
    this.recover();
    this.notify();
    return entry.op;
  }

  /** Reverts every remaining edit; the draft stays open. */
  clear(): BoardOp[] {
    if (!this.isOpen) return [];
    const inverses = [...this.entries].reverse().map((entry) => entry.inverse).filter((op): op is BoardOp => op !== null);
    this.redoStack = [...this.redoStack, ...[...this.entries].reverse()];
    this.entries = [];
    this.recover();
    this.notify();
    return inverses;
  }

  /** Reverts everything and closes the draft without submitting. */
  cancel(): BoardOp[] {
    const inverses = this.clear();
    this.close();
    return inverses;
  }

  /** Freezes the draft for one idempotent submission. */
  beginSubmit(options?: { allowEmpty?: boolean }): { submissionId: string; draftId: string; ops: BoardOp[]; notes: string[] } | null {
    if ((this.status !== 'open' && this.status !== 'error') || !this.draftId) return null;
    if (this.entries.length === 0 && !options?.allowEmpty) return null;
    // Retrying a failed submission reuses the same id so the server can
    // deduplicate; new edits after a failure produce a new id.
    this.pendingSubmissionId ??= `submission-${crypto.randomUUID()}`;
    this.status = 'submitting';
    this.error = null;
    this.notify();
    return {
      submissionId: this.pendingSubmissionId,
      draftId: this.draftId,
      ops: this.entries.map((entry) => entry.op),
      notes: this.entries.map((entry) => entry.note),
    };
  }

  submitSucceeded(): void {
    this.close();
  }

  submitFailed(message: string): void {
    if (this.status !== 'submitting') return;
    this.status = 'error';
    this.error = message;
    this.recover();
    this.notify();
  }

  /** New edits after a failed submission invalidate the frozen id. */
  resumeEditing(): void {
    if (this.status !== 'error') return;
    this.status = 'open';
    this.error = null;
    this.pendingSubmissionId = null;
    this.notify();
  }

  /** Restores an unsubmitted draft after a reload. Returns ops to re-apply. */
  restore(): { draftId: string; taskId?: string; semanticGroupId?: string; ops: BoardOp[] } | null {
    if (!this.storageKey || this.isOpen) return null;
    try {
      const raw = window.sessionStorage.getItem(this.storageKey);
      if (!raw) return null;
      const saved = JSON.parse(raw) as PersistedDraft;
      if (!saved.draftId || !Array.isArray(saved.entries) || saved.entries.length === 0) return null;
      this.draftId = saved.draftId;
      this.taskId = saved.taskId;
      this.semanticGroupId = saved.semanticGroupId;
      this.entries = saved.entries;
      this.redoStack = [];
      this.status = 'open';
      this.error = null;
      this.pendingSubmissionId = null;
      this.notify();
      return {
        draftId: saved.draftId,
        ...(saved.taskId ? { taskId: saved.taskId } : {}),
        ...(saved.semanticGroupId ? { semanticGroupId: saved.semanticGroupId } : {}),
        ops: saved.entries.map((entry) => entry.op),
      };
    } catch {
      return null;
    }
  }

  private close(): void {
    this.entries = [];
    this.redoStack = [];
    this.status = 'idle';
    this.draftId = null;
    this.taskId = undefined;
    this.semanticGroupId = undefined;
    this.error = null;
    this.pendingSubmissionId = null;
    this.recover();
    this.notify();
  }

  private recover(): void {
    if (!this.storageKey) return;
    try {
      if (this.entries.length === 0 || !this.draftId) {
        window.sessionStorage.removeItem(this.storageKey);
        return;
      }
      const saved: PersistedDraft = {
        draftId: this.draftId,
        ...(this.taskId ? { taskId: this.taskId } : {}),
        ...(this.semanticGroupId ? { semanticGroupId: this.semanticGroupId } : {}),
        entries: this.entries,
      };
      window.sessionStorage.setItem(this.storageKey, JSON.stringify(saved));
    } catch {
      /* storage quota issues never break drawing */
    }
  }

  private notify(): void {
    this.cachedSnapshot = null;
    for (const listener of this.listeners) listener();
  }
}
