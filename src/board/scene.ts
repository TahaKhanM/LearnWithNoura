import {
  applyUpdate,
  type BoardOp,
  type ShapeSpec,
} from '../../shared/boardOps';
import { isCenterArc } from '../../shared/authoredSpecs';
import { isManipulativeSpec, manipulativeLearnerProps, applyManipulativeProps } from '../../shared/manipulativeSpecs';

export type Owner = 'tutor' | 'learner';

export interface SceneItem {
  id: string;
  owner: Owner;
  /** Semantic board section/page that owns this item. */
  semanticGroupId?: string;
  color?: string;
  spec: ShapeSpec;
  /** Bumped on update so the renderer knows to recompile without replaying. */
  revision: number;
}

export interface SceneState {
  items: SceneItem[];
  /** Monotonic counter of applied clears, to key board-wide transitions. */
  epoch: number;
}

export const emptyScene: SceneState = { items: [], epoch: 0 };

export interface AppliedOps {
  scene: SceneState;
  /** IDs added by this application, in order — these get draw-on animation. */
  added: string[];
  /** IDs to pulse. */
  highlighted: string[];
}

/** Applies validated ops to the scene. Pure, so React state stays simple. */
export function applyOps(
  scene: SceneState,
  ops: BoardOp[],
  owner: Owner,
  semanticGroupId?: string,
  options?: { manipulativeDraft?: boolean },
): AppliedOps {
  let items = scene.items;
  let epoch = scene.epoch;
  const added: string[] = [];
  const highlighted: string[] = [];

  for (const op of ops) {
    switch (op.op) {
      case 'add': {
        const index = items.findIndex((existing) => existing.id === op.id);
        const previous = index >= 0 ? items[index] : undefined;
        const item: SceneItem = {
          id: op.id,
          owner,
          spec: op.spec,
          revision: 0,
          ...((semanticGroupId ?? op.semanticGroupId ?? previous?.semanticGroupId)
            ? { semanticGroupId: semanticGroupId ?? op.semanticGroupId ?? previous?.semanticGroupId }
            : {}),
          ...(op.color ? { color: op.color } : {}),
        };
        if (index === -1) {
          items = [...items, item];
          added.push(op.id);
        } else {
          if (items[index].owner !== owner) break;
          // Re-adding an existing id replaces it in place, keeping z-order.
          items = items.map((existing, i) =>
            i === index ? { ...item, revision: existing.revision + 1 } : existing,
          );
        }
        break;
      }
      case 'update': {
        items = items.map((existing) => {
          if (existing.id !== op.id) return existing;
          if (options?.manipulativeDraft && isManipulativeSpec(existing.spec) && manipulativeLearnerProps(op.props)) {
            return {
              ...existing,
              spec: applyManipulativeProps(existing.spec, op.props),
              revision: existing.revision + 1,
            };
          }
          if (existing.owner !== owner) return existing;
          return {
            ...existing,
            spec: applyUpdate(existing.spec, op.props, { tier: 'authored' }),
            revision: existing.revision + 1,
          };
        });
        break;
      }
      case 'highlight':
        if (items.some((existing) => existing.id === op.id)) highlighted.push(op.id);
        break;
      case 'erase': {
        items = items.filter(
          (existing) =>
            existing.owner !== owner ||
            (existing.id !== op.id && !dependsOn(existing.spec, op.id)),
        );
        break;
      }
      case 'clear':
        items = items.filter((existing) => existing.owner !== owner || (semanticGroupId ? existing.semanticGroupId !== semanticGroupId : false));
        epoch += 1;
        break;
    }
  }

  return { scene: { items, epoch }, added, highlighted };
}

function dependsOn(spec: ShapeSpec, id: string): boolean {
  if (spec.kind === 'label') return spec.target === id;
  if (spec.kind === 'plot') return spec.axes === id;
  if (spec.kind === 'connector') return spec.from === id || spec.to === id;
  return false;
}

/**
 * A compact, model-readable description of the current board, sent with
 * learner turns so the tutor can refer back to what is already drawn.
 */
export function describeScene(scene: SceneState): string {
  if (scene.items.length === 0) return 'The board is empty.';
  const lines = scene.items.slice(-60).map((item) => {
    const s = item.spec;
    const who = item.owner === 'learner' ? ' (drawn by the learner)' : '';
    const group = item.semanticGroupId ? ` [region ${item.semanticGroupId}]` : '';
    switch (s.kind) {
      case 'line':
        return `${item.id}${group}: line from (${s.from}) to (${s.to})${who}`;
      case 'polygon':
        return `${item.id}${group}: polygon ${s.points.map((p) => `(${p})`).join(' ')}${who}`;
      case 'circle':
        return `${item.id}${group}: circle center (${s.center}) r=${s.r}${who}`;
      case 'ellipse':
        return `${item.id}${group}: ellipse center (${s.center}) rx=${s.rx} ry=${s.ry}${who}`;
      case 'point':
        return `${item.id}${group}: point at (${s.at})${s.label ? ` "${s.label}"` : ''}${who}`;
      case 'angle':
        return `${item.id}${group}: angle at (${s.vertex})${s.label ? ` "${s.label}"` : ''}${who}`;
      case 'text':
        return `${item.id}${group}: text "${s.text}" at (${s.at})${who}`;
      case 'equation':
        return `${item.id}${group}: equation "${s.latex}" at (${s.at})${who}`;
      case 'label':
        return `${item.id}${group}: label "${s.text}" on ${s.target}${who}`;
      case 'axes':
        return `${item.id}${group}: axes at (${s.at}) ${s.w}x${s.h} x:[${s.xRange}] y:[${s.yRange}]${who}`;
      case 'plot':
        return `${item.id}${group}: plot ${s.expr ? `y=${s.expr}` : 'data'} on ${s.axes}${who}`;
      case 'bars':
        return `${item.id}${group}: bar chart ${s.items.map((b) => `${b.label}=${b.value}`).join(', ')}${who}`;
      case 'numberline':
        return `${item.id}${group}: number line ${s.min}..${s.max} at (${s.at})${who}`;
      case 'box':
        return `${item.id}${group}: box "${s.text}" at (${s.at})${who}`;
      case 'connector':
        return `${item.id}${group}: arrow ${JSON.stringify(s.from)} -> ${JSON.stringify(s.to)}${s.label ? ` "${s.label}"` : ''}${who}`;
      case 'table':
        return `${item.id}${group}: table ${s.rows.length}x${s.rows[0]?.length ?? 0} at (${s.at})${who}`;
      case 'path':
        return `${item.id}${group}: freehand stroke, ${s.points.length} points${who}`;
      case 'arc':
        return isCenterArc(s)
          ? `${item.id}${group}: arc center (${s.center}) r=${s.r}${who}`
          : `${item.id}${group}: arc through (${s.from}) (${s.through}) (${s.to})${who}`;
      case 'curve':
        return `${item.id}${group}: curve, ${s.points.length} points${who}`;
      case 'asset':
        return `${item.id}${group}: icon ${s.assetId}${s.label ? ` "${s.label}"` : ''} at (${s.at})${who}`;
      case 'image':
        return `${item.id}${group}: illustration ${s.assetId} “${s.alt}” at (${s.at}) ${s.w}x${s.h}${who}`;
      case 'draggable':
        return `${item.id}${group}: draggable ${s.handle} at (${s.at})${s.label ? ` "${s.label}"` : ''}${who}`;
      case 'snapZone':
        return `${item.id}${group}: snap zone ${s.shape} at (${s.at})${who}`;
      case 'tappable':
        return `${item.id}${group}: tap target at (${s.at})${s.selected ? ' [selected]' : ''}${s.label ? ` "${s.label}"` : ''}${who}`;
    }
  });
  return `Objects on the board now:\n${lines.join('\n')}`;
}
