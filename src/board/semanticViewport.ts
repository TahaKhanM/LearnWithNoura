import { BOARD_H, BOARD_W } from '../../shared/boardOps';
import { compileScene, type BBox } from './compile';
import type { SceneState } from './scene';

export interface SemanticViewport { x: number; y: number; w: number; h: number; itemIds: string[]; viewIndex: number; viewCount: number }

export function deriveSemanticViewports(scene: SceneState, semanticObjectId: string | undefined): SemanticViewport[] {
  const compiled = compileScene(scene.items);
  const matching = semanticObjectId
    ? compiled.filter((item) => item.id === semanticObjectId || item.id.startsWith(`${semanticObjectId}-`))
    : [];
  if (matching.length === 0) return [{ x: 0, y: 0, w: BOARD_W, h: BOARD_H, itemIds: [], viewIndex: 0, viewCount: 1 }];
  const sources = new Map(scene.items.map((item) => [item.id, item]));
  const primary = matching.filter((item) => {
    const kind = sources.get(item.id)?.spec.kind;
    return ['box', 'numberline', 'axes', 'circle', 'table', 'point', 'text', 'equation', 'plot'].includes(kind ?? '') ||
      (kind === 'polygon' && item.bbox.w * item.bbox.h >= 25_000);
  }).sort((left, right) => focusPriority(sources.get(left.id)?.spec.kind) - focusPriority(sources.get(right.id)?.spec.kind));
  const anchors = (primary.length > 0 ? primary : matching).flatMap((item) => {
    const kind = sources.get(item.id)?.spec.kind;
    const textBias = ['text', 'equation', 'point', 'box', 'numberline', 'table'].includes(kind ?? '') ? 50 : 0;
    const points = splitWideBox(item.bbox);
    if (kind === 'plot') points.reverse();
    return points.map((anchor) => ({ ...anchor, x: Math.min(BOARD_W, anchor.x + textBias) }));
  });
  const distinct = anchors.filter((anchor, index) => !anchors.slice(0, index).some((earlier) => Math.hypot(anchor.x - earlier.x, anchor.y - earlier.y) < 110));
  const itemIds = matching.map((item) => item.id);
  const viewCount = distinct.length;
  return distinct.map((anchor, viewIndex) => {
    const w = 350;
    const h = 300;
    return {
      x: Math.max(0, Math.min(BOARD_W - w, anchor.x - w / 2)),
      y: Math.max(0, Math.min(BOARD_H - h, anchor.y - h / 2)),
      w, h, itemIds, viewIndex, viewCount,
    };
  });
}

function focusPriority(kind: string | undefined): number {
  if (kind === 'text' || kind === 'equation' || kind === 'plot') return 0;
  if (kind === 'point' || kind === 'box' || kind === 'numberline') return 1;
  if (kind === 'axes' || kind === 'circle' || kind === 'table') return 2;
  return 3;
}

export function deriveSemanticViewport(scene: SceneState, semanticObjectId: string | undefined, viewIndex = 0): SemanticViewport {
  const views = deriveSemanticViewports(scene, semanticObjectId);
  return views[Math.max(0, Math.min(views.length - 1, Math.round(viewIndex)))] ?? views[0];
}

function splitWideBox(box: BBox): Array<{ x: number; y: number }> {
  const columns = Math.max(1, Math.ceil(box.w / 300));
  const rows = Math.max(1, Math.ceil(box.h / 250));
  const points: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) points.push({
    x: box.x + (box.w * (column + 0.5)) / columns,
    y: box.y + (box.h * (row + 0.5)) / rows,
  });
  return points;
}
