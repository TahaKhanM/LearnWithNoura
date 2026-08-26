/**
 * Intake and replay filtering for learner board submissions. Sketch path
 * add/erase ops are always accepted; manipulative `update` ops are accepted
 * only when props pass learner validation and the target is a visible
 * draggable or tappable.
 */

import { normalizeColor, validateSpec, type BoardOp } from './boardOps.js';
import { sanitizeLearnerManipulativeProps } from './manipulativeSpecs.js';

export interface LearnerBoardOpsOptions {
  /** Visible draggable/tappable ids the learner may update (required at intake). */
  manipulativeTargetIds?: ReadonlySet<string>;
  /** Accept validated manipulative updates without id membership (stored replay). */
  trustPersistedManipulativeUpdates?: boolean;
}

export function learnerBoardOps(raw: unknown, options?: LearnerBoardOpsOptions): BoardOp[] {
  if (!Array.isArray(raw)) return [];
  const ops: BoardOp[] = [];
  for (const entry of raw.slice(0, 40)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as { op?: unknown; id?: unknown; color?: unknown; spec?: unknown; props?: unknown };

    if (candidate.op === 'update') {
      const updateId = typeof candidate.id === 'string' && /^[\w-]{1,80}$/.test(candidate.id) ? candidate.id : null;
      if (!updateId || typeof candidate.props !== 'object' || candidate.props === null) continue;
      const props = candidate.props as Record<string, unknown>;
      const sanitized = sanitizeLearnerManipulativeProps(props);
      if (!sanitized) continue;
      const allowed = options?.trustPersistedManipulativeUpdates
        || (options?.manipulativeTargetIds?.has(updateId) ?? false);
      if (!allowed) continue;
      ops.push({ op: 'update', id: updateId, props: sanitized });
      continue;
    }

    const id = typeof candidate.id === 'string' && /^sketch-[\w-]{1,80}$/.test(candidate.id)
      ? candidate.id
      : null;
    if (!id) continue;
    if (candidate.op === 'erase') {
      ops.push({ op: 'erase', id });
      continue;
    }
    if (candidate.op !== 'add' || typeof candidate.spec !== 'object' || candidate.spec === null) continue;
    const spec = validateSpec(candidate.spec as never);
    if (spec?.kind !== 'path') continue;
    const color = normalizeColor(candidate.color);
    ops.push({ op: 'add', id, spec, ...(color ? { color } : {}) });
  }
  return ops;
}
