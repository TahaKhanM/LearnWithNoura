import { applyUpdate, normalizeColor, validateOps, validateSpec, type BoardOp, type ShapeSpec } from '../../shared/boardOps.js';
import type { DomainRepository } from '../store/domain.js';

type BoardOwner = 'tutor' | 'learner';

interface BoardContextItem {
  id: string;
  owner: BoardOwner;
  spec: ShapeSpec;
  color?: string;
}

/**
 * Server-side logical mirror of the board the learner has actually seen.
 * It is reconstructed from released events on connect, then advanced only by
 * browser checkpoint acknowledgement or committed learner marks.
 */
export class BoardContextTracker {
  private items: BoardContextItem[];

  constructor(items: BoardContextItem[] = []) {
    this.items = items;
  }

  apply(ops: BoardOp[], owner: BoardOwner): void {
    for (const op of ops) {
      if (op.op === 'add') {
        const next: BoardContextItem = { id: op.id, owner, spec: op.spec, ...(op.color ? { color: op.color } : {}) };
        const index = this.items.findIndex((item) => item.id === op.id);
        if (index < 0) this.items.push(next);
        else if (this.items[index].owner === owner) this.items[index] = next;
      } else if (op.op === 'update') {
        this.items = this.items.map((item) => item.id === op.id && item.owner === owner
          ? { ...item, spec: applyUpdate(item.spec, op.props) }
          : item);
      } else if (op.op === 'erase') {
        this.items = this.items.filter((item) => item.owner !== owner || (item.id !== op.id && !dependsOn(item.spec, op.id)));
      } else if (op.op === 'clear') {
        this.items = this.items.filter((item) => item.owner !== owner);
      }
    }
  }

  /** Drops exact redraws under a new ID while preserving updates by ID. */
  novelTutorOps(ops: BoardOp[]): { ops: BoardOp[]; duplicates: Array<{ requestedId: string; existingId: string }> } {
    const signatures = new Map(
      this.items.filter((item) => item.owner === 'tutor').map((item) => [itemSignature(item.spec, item.color), item.id]),
    );
    const accepted: BoardOp[] = [];
    const duplicates: Array<{ requestedId: string; existingId: string }> = [];
    for (const op of ops) {
      if (op.op !== 'add' || this.items.some((item) => item.id === op.id)) {
        accepted.push(op);
        continue;
      }
      const signature = itemSignature(op.spec, op.color);
      const existingId = signatures.get(signature);
      if (existingId) {
        duplicates.push({ requestedId: op.id, existingId });
        continue;
      }
      signatures.set(signature, op.id);
      accepted.push(op);
    }
    return { ops: accepted, duplicates };
  }

  equivalentTutorScene(ops: BoardOp[]): { equivalent: boolean; duplicates: Array<{ requestedId: string; existingId: string }> } {
    const adds = ops.filter((op) => op.op === 'add');
    const { duplicates } = this.novelTutorOps(ops);
    return {
      equivalent: adds.length >= 2 && duplicates.length >= Math.ceil(adds.length * 0.6),
      duplicates,
    };
  }

  toolSnapshot(): { visibleObjectIds: string[]; summary: string; guidance: string } {
    return {
      visibleObjectIds: this.items.slice(-60).map((item) => item.id),
      summary: this.summary(),
      guidance: 'Extend this board. Prefer highlight/update/erase with visible IDs; do not redraw equivalent objects under new IDs.',
    };
  }

  prompt(): string {
    return [
      '## Current shared board (authoritative visible state)',
      this.summary(),
      'Treat these object IDs as reusable handles. When the learner asks a question, adapt this diagram with highlight, update, erase, or a small addition. Do not restart or redraw equivalent objects. Learner-owned marks must remain intact.',
    ].join('\n');
  }

  private summary(): string {
    if (this.items.length === 0) return 'The board is empty.';
    const lines = this.items.slice(-60).map((item) => `${item.id}${item.owner === 'learner' ? ' [learner]' : ''}: ${describeSpec(item.spec)}`);
    return `Visible objects now:\n${lines.join('\n')}`.slice(0, 8_000);
  }
}

export async function loadReleasedBoardContext(repo: DomainRepository, sessionId: string): Promise<BoardContextTracker> {
  const tracker = new BoardContextTracker();
  const events = await repo.listEvents(sessionId, 2_000);
  for (const event of events) {
    if (!['board_ops', 'semantic_scene', 'learner_board'].includes(event.type)) continue;
    const owner = event.type === 'learner_board' ? 'learner' : 'tutor';
    const raw = (event.payload as { ops?: unknown }).ops;
    const ops = owner === 'learner' ? releasedLearnerOps(raw) : validateOps(raw).ops;
    tracker.apply(ops, owner);
  }
  return tracker;
}

function releasedLearnerOps(raw: unknown): BoardOp[] {
  if (!Array.isArray(raw)) return [];
  const ops: BoardOp[] = [];
  for (const entry of raw.slice(0, 80)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as { op?: unknown; id?: unknown; spec?: unknown; color?: unknown };
    const id = typeof candidate.id === 'string' && /^sketch-[\w-]{1,80}$/.test(candidate.id) ? candidate.id : null;
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

function itemSignature(spec: ShapeSpec, color?: string): string {
  return JSON.stringify({ spec, color: color ?? null });
}

function dependsOn(spec: ShapeSpec, id: string): boolean {
  if (spec.kind === 'label') return spec.target === id;
  if (spec.kind === 'plot') return spec.axes === id;
  if (spec.kind === 'connector') return spec.from === id || spec.to === id;
  return false;
}

function describeSpec(spec: ShapeSpec): string {
  switch (spec.kind) {
    case 'line': return `line from (${spec.from}) to (${spec.to})${spec.dash ? ', dashed' : ''}`;
    case 'polygon': return `polygon through ${spec.points.map((point) => `(${point})`).join(' ')}`;
    case 'circle': return `circle centred at (${spec.center}), radius ${spec.r}`;
    case 'ellipse': return `ellipse centred at (${spec.center})`;
    case 'point': return `point at (${spec.at})${spec.label ? ` labelled “${spec.label}”` : ''}`;
    case 'angle': return `angle at (${spec.vertex})${spec.label ? ` labelled “${spec.label}”` : ''}`;
    case 'text': return `text “${spec.text}”`;
    case 'equation': return `equation ${spec.latex}`;
    case 'label': return `label “${spec.text}” attached to ${spec.target}`;
    case 'axes': return `axes ${spec.xRange.join('..')} by ${spec.yRange.join('..')}`;
    case 'plot': return `plot ${spec.expr ?? 'data'} on ${spec.axes}${spec.label ? ` labelled “${spec.label}”` : ''}`;
    case 'bars': return `bar chart ${spec.items.map((item) => `${item.label}=${item.value}`).join(', ')}`;
    case 'numberline': return `number line ${spec.min}..${spec.max}`;
    case 'box': return `concept box “${spec.text}”`;
    case 'connector': return `connector ${JSON.stringify(spec.from)} to ${JSON.stringify(spec.to)}${spec.label ? ` labelled “${spec.label}”` : ''}`;
    case 'table': return `table with ${spec.rows.length} rows`;
    case 'path': return `freehand stroke with ${spec.points.length} points`;
  }
}
