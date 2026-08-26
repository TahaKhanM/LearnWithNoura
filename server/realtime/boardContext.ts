import { applyUpdate, normalizeColor, validateOps, validateSpec, type BoardOp, type ShapeSpec } from '../../shared/boardOps.js';
import { isCenterArc } from '../../shared/authoredSpecs.js';
import { applyManipulativeProps, isManipulativeSpec, manipulativeLearnerProps } from '../../shared/manipulativeSpecs.js';
import { LearnerBoardAnalysisSchema, type LearnerBoardAnalysis } from '../../shared/learnerBoard.js';
import type { DomainRepository } from '../store/domain.js';

type BoardOwner = 'tutor' | 'learner';

interface BoardContextItem {
  id: string;
  owner: BoardOwner;
  semanticGroupId?: string;
  semanticGroupLabel?: string;
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
  private learnerObservations: string[] = [];
  private rejectionObservations: string[] = [];

  constructor(items: BoardContextItem[] = []) {
    this.items = items;
  }

  apply(ops: BoardOp[], owner: BoardOwner, semanticGroupId?: string, semanticGroupLabel?: string): void {
    for (const op of ops) {
      if (op.op === 'add') {
        const existing = this.items.find((item) => item.id === op.id);
        const group = semanticGroupId ?? existing?.semanticGroupId;
        const next: BoardContextItem = {
          id: op.id,
          owner,
          spec: op.spec,
          ...(group ? { semanticGroupId: group } : {}),
          ...((semanticGroupLabel ?? existing?.semanticGroupLabel) ? { semanticGroupLabel: semanticGroupLabel ?? existing?.semanticGroupLabel } : {}),
          ...(op.color ? { color: op.color } : {}),
        };
        const index = this.items.findIndex((item) => item.id === op.id);
        if (index < 0) this.items.push(next);
        else if (this.items[index].owner === owner) this.items[index] = next;
      } else if (op.op === 'update') {
        this.items = this.items.map((item) => {
          if (item.id !== op.id) return item;
          if (owner === 'learner' && isManipulativeSpec(item.spec) && manipulativeLearnerProps(op.props)) {
            return { ...item, spec: applyManipulativeProps(item.spec, op.props) };
          }
          if (item.owner !== owner) return item;
          return { ...item, spec: applyUpdate(item.spec, op.props, { tier: 'authored' }) };
        });
      } else if (op.op === 'erase') {
        this.items = this.items.filter((item) => item.owner !== owner || (item.id !== op.id && !dependsOn(item.spec, op.id)));
      } else if (op.op === 'clear') {
        this.items = this.items.filter((item) => item.owner !== owner || (semanticGroupId ? item.semanticGroupId !== semanticGroupId : false));
      }
    }
  }

  /** Drops exact redraws under a new ID while preserving updates by ID. */
  novelTutorOps(ops: BoardOp[], semanticGroupId?: string): { ops: BoardOp[]; duplicates: Array<{ requestedId: string; existingId: string }> } {
    const signatures = new Map(
      this.items
        .filter((item) => item.owner === 'tutor' && (!semanticGroupId || !item.semanticGroupId || item.semanticGroupId === semanticGroupId))
        .map((item) => [itemSignature(item.spec, item.color), item.id]),
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

  observeLearnerAnalysis(analysis: LearnerBoardAnalysis): void {
    if (!analysis.summary) return;
    this.learnerObservations.push(analysis.summary);
    this.learnerObservations = this.learnerObservations.slice(-8);
  }

  /** The visible board as replayable add operations (both owners), used to
   * raster the Director's screenshot of what the learner sees right now. */
  visibleOps(): BoardOp[] {
    return this.items.map((item) => ({
      op: 'add' as const,
      id: item.id,
      spec: item.spec,
      ...(item.color ? { color: item.color } : {}),
      ...(item.semanticGroupId ? { semanticGroupId: item.semanticGroupId } : {}),
    }));
  }

  visibleObjectIdList(): string[] {
    return this.items.map((item) => item.id);
  }

  hasGroup(id: string): boolean {
    return this.items.some((item) => item.semanticGroupId === id);
  }

  /** Learner marks in a section make destructive replacement illegal. */
  groupHasLearnerMarks(id: string): boolean {
    return this.items.some((item) => item.semanticGroupId === id && item.owner === 'learner');
  }

  hasObject(id: string): boolean {
    return this.items.some((item) => item.id === id);
  }

  groupOfObject(id: string): string | null {
    return this.items.find((item) => item.id === id)?.semanticGroupId ?? null;
  }

  groupLabelOf(groupId: string | null | undefined): string | null {
    if (!groupId) return null;
    return this.items.find((item) => item.semanticGroupId === groupId && item.semanticGroupLabel)?.semanticGroupLabel ?? null;
  }

  /** Applies an atomic section replacement: scoped clear plus the new ops. */
  applyReplacement(ops: BoardOp[], semanticGroupId: string, semanticGroupLabel?: string): void {
    this.apply([{ op: 'clear' }], 'tutor', semanticGroupId);
    this.apply(ops, 'tutor', semanticGroupId, semanticGroupLabel);
  }

  observeBoardRejection(reason: string): void {
    if (!reason) return;
    this.rejectionObservations.push(reason.slice(0, 300));
    this.rejectionObservations = this.rejectionObservations.slice(-5);
  }

  toolSnapshot(focus?: string): { visibleObjectIds: string[]; visibleGroups: Array<{ id: string; label?: string; objectCount: number; learnerMarkCount: number }>; recentLearnerObservations: string[]; recentRejections: string[]; summary: string; guidance: string } {
    const selected = focus
      ? this.items.filter((item) => item.id === focus || item.semanticGroupId === focus || item.id.includes(focus))
      : this.items;
    const visibleItems = selected.length > 0 ? selected : this.items;
    const groupIds = [...new Set(visibleItems.map((item) => item.semanticGroupId).filter((id): id is string => Boolean(id)))];
    return {
      visibleObjectIds: visibleItems.slice(-60).map((item) => item.id),
      visibleGroups: groupIds.map((id) => ({
        id,
        ...(visibleItems.find((item) => item.semanticGroupId === id)?.semanticGroupLabel ? { label: visibleItems.find((item) => item.semanticGroupId === id)?.semanticGroupLabel } : {}),
        objectCount: visibleItems.filter((item) => item.semanticGroupId === id).length,
        learnerMarkCount: visibleItems.filter((item) => item.semanticGroupId === id && item.owner === 'learner').length,
      })),
      recentLearnerObservations: [...this.learnerObservations],
      recentRejections: [...this.rejectionObservations],
      summary: this.summary(visibleItems),
      guidance: 'Extend this board. Prefer highlight/update/erase with visible IDs; do not redraw equivalent objects under new IDs.',
    };
  }

  prompt(): string {
    const learnerContext = this.learnerObservations.length
      ? `Recent deterministic learner-mark observations (shape/location hints, not semantic conclusions):\n${this.learnerObservations.map((observation) => `- ${observation}`).join('\n')}`
      : 'No recent learner-mark observations.';
    const rejectionContext = this.rejectionObservations.length
      ? `Recent rejected visual checkpoints (not visible):\n${this.rejectionObservations.map((observation) => `- ${observation}`).join('\n')}`
      : 'No recent rejected visual checkpoints.';
    return [
      '## Current shared board (authoritative visible state)',
      this.summary(),
      learnerContext,
      rejectionContext,
      'Treat these object IDs as reusable handles. When the learner asks a question, adapt this diagram with highlight, update, erase, or a small addition. Do not restart or redraw equivalent objects. Learner-owned marks must remain intact.',
      'Use deterministic stroke observations for spatial grounding and the attached board image for visual interpretation. If meaning is ambiguous, ask what the learner intended instead of guessing.',
    ].join('\n');
  }

  private summary(items: BoardContextItem[] = this.items): string {
    if (items.length === 0) return 'The board is empty.';
    const regionIds = [...new Set(items.map((item) => item.semanticGroupId).filter((id): id is string => Boolean(id)))];
    const lines = items.slice(-60).map((item) => {
      const region = item.semanticGroupId
        ? ` [region ${regionIds.indexOf(item.semanticGroupId) + 1} of ${Math.max(1, regionIds.length)}: ${item.semanticGroupLabel ?? item.semanticGroupId}]`
        : '';
      return `${item.id}${region}${item.owner === 'learner' ? ' [learner]' : ''}: ${describeSpec(item.spec)}`;
    });
    return `Objects on the board now (every region remains present; the camera shows one at a time):\n${lines.join('\n')}`.slice(0, 8_000);
  }
}

export async function loadReleasedBoardContext(repo: DomainRepository, sessionId: string): Promise<BoardContextTracker> {
  const tracker = new BoardContextTracker();
  const events = await repo.listEvents(sessionId, 2_000);
  for (const event of events) {
    if (event.type === 'board_rejected') {
      const reason = String((event.payload as { reason?: unknown }).reason ?? '').trim();
      if (reason) tracker.observeBoardRejection(reason);
      continue;
    }
    if (!['board_ops', 'semantic_scene', 'learner_board'].includes(event.type)) continue;
    const owner = event.type === 'learner_board' ? 'learner' : 'tutor';
    const payload = event.payload as { ops?: unknown; semanticObjectId?: unknown; groupLabel?: unknown; replacesGroup?: unknown; plan?: { groups?: Array<{ id?: unknown; label?: unknown }> } };
    const raw = payload.ops;
    const ops = owner === 'learner' ? releasedLearnerOps(raw) : validateOps(raw, { tier: 'authored' }).ops;
    const semanticGroupId = typeof payload.semanticObjectId === 'string'
      ? payload.semanticObjectId
      : typeof payload.plan?.groups?.[0]?.id === 'string'
        ? payload.plan.groups[0].id
        : undefined;
    const semanticGroupLabel = typeof payload.groupLabel === 'string'
      ? payload.groupLabel
      : typeof payload.plan?.groups?.[0]?.label === 'string' ? payload.plan.groups[0].label : undefined;
    if (owner === 'tutor' && typeof payload.replacesGroup === 'string' && payload.replacesGroup) {
      tracker.applyReplacement(ops, payload.replacesGroup, semanticGroupLabel);
    } else tracker.apply(ops, owner, semanticGroupId, semanticGroupLabel);
    if (owner === 'learner') {
      const parsedAnalysis = LearnerBoardAnalysisSchema.safeParse((event.payload as { analysis?: unknown }).analysis);
      if (parsedAnalysis.success) tracker.observeLearnerAnalysis(parsedAnalysis.data);
    }
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
    case 'text': return `text “${spec.text}”${spec.style === 'handwritten' ? ', handwritten' : ''}`;
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
    case 'arc': return isCenterArc(spec)
      ? `arc centred at (${spec.center}), radius ${spec.r}`
      : `arc through (${spec.from}) (${spec.through}) (${spec.to})`;
    case 'curve': return `curve with ${spec.points.length} points`;
    case 'asset': return `icon ${spec.assetId}${spec.label ? ` labelled “${spec.label}”` : ''}`;
    case 'draggable': return `draggable ${spec.handle} at (${spec.at})${spec.label ? ` labelled “${spec.label}”` : ''}`;
    case 'snapZone': return `snap zone ${spec.shape} at (${spec.at})`;
    case 'tappable': return `tap target at (${spec.at})${spec.selected ? ' [selected]' : ''}${spec.label ? ` labelled “${spec.label}”` : ''}`;
  }
}
