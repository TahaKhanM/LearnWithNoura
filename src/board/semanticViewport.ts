import { BOARD_H, BOARD_W } from '../../shared/boardOps';
import { compileScene, nodeBBox, type BBox, type CompiledItem } from './compile';
import type { SceneItem, SceneState } from './scene';

export interface SemanticViewport { x: number; y: number; w: number; h: number; itemIds: string[]; viewIndex: number; viewCount: number }

const FOCUS_W = 350;
const FOCUS_H = 230;

/**
 * Builds reachable mobile views from the current semantic group. Newly
 * highlighted items come first. Otherwise the initial anchor is the key
 * educational representation (equation, comparison marks, point/projection,
 * plotted relation, then labelled box). Every required text/equation node is
 * centred in at least one view; later duplicate anchors are omitted only when
 * an earlier view already contains the complete text bounds.
 */
export function deriveSemanticViewports(
  scene: SceneState,
  semanticObjectId: string | undefined,
  priorityItemIds: string[] = [],
): SemanticViewport[] {
  const compiled = compileScene(scene.items);
  const matching = semanticObjectId
    ? compiled.filter((item) => item.id === semanticObjectId || item.id.startsWith(`${semanticObjectId}-`))
    : [];
  if (matching.length === 0) return [overviewViewport()];
  const sources = new Map(scene.items.map((item) => [item.id, item]));
  const matchingById = new Map(matching.map((item) => [item.id, item]));
  const anchors: Array<{ x: number; y: number; required?: BBox }> = [];

  const prioritized = priorityItemIds.map((id) => matchingById.get(id)).filter((item): item is CompiledItem => Boolean(item));
  for (const item of prioritized) addItemAnchor(anchors, item, sources.get(item.id), true);

  const preferred = [...matching].sort((left, right) =>
    keyPriority(sources.get(left.id)) - keyPriority(sources.get(right.id)) || left.id.localeCompare(right.id),
  )[0];
  if (preferred && !prioritized.some((item) => item.id === preferred.id)) addItemAnchor(anchors, preferred, sources.get(preferred.id), true);

  const requiredText = matching.flatMap((item) => item.nodes
    .filter((node) => node.type === 'text' || node.type === 'katex')
    .map((node) => ({ item, box: nodeBBox(node) })));
  for (const { box } of requiredText) {
    if (!anchors.some((anchor) => contains(viewFromAnchor(anchor), box))) {
      anchors.push({ x: box.x + box.w / 2, y: box.y + box.h / 2, required: box });
    }
  }

  for (const item of matching) {
    for (const point of splitWideBox(item.bbox)) {
      const candidate = { x: point.x, y: point.y };
      if (!anchors.some((anchor) => Math.hypot(anchor.x - candidate.x, anchor.y - candidate.y) < 80)) anchors.push(candidate);
    }
  }

  const itemIds = matching.map((item) => item.id);
  const views = anchors.map(viewFromAnchor).filter((view, index, all) =>
    !all.slice(0, index).some((earlier) => earlier.x === view.x && earlier.y === view.y),
  );
  return views.map((view, viewIndex) => ({ ...view, itemIds, viewIndex, viewCount: views.length }));
}

function addItemAnchor(
  anchors: Array<{ x: number; y: number; required?: BBox }>,
  item: CompiledItem,
  source: SceneItem | undefined,
  required: boolean,
): void {
  const spec = source?.spec;
  if (spec?.kind === 'numberline' && (spec.marks?.length ?? 0) > 0) {
    const positions = (spec.marks ?? []).map((mark) => spec.at[0] + ((mark.value - spec.min) / (spec.max - spec.min)) * spec.w);
    anchors.push({ x: positions.reduce((sum, value) => sum + value, 0) / positions.length, y: spec.at[1], ...(required ? { required: item.bbox } : {}) });
    return;
  }
  const keyNode = item.nodes.find((node) => node.type === 'katex') ?? item.nodes.find((node) => node.type === 'text');
  const box = keyNode ? nodeBBox(keyNode) : item.bbox;
  anchors.push({ x: box.x + box.w / 2, y: box.y + box.h / 2, ...(required ? { required: box } : {}) });
}

function keyPriority(item: SceneItem | undefined): number {
  const kind = item?.spec.kind;
  if (kind === 'equation') return 0;
  if (kind === 'numberline') return 1;
  if (kind === 'point') return 2;
  if (kind === 'plot') return 3;
  if (kind === 'box' || kind === 'text') return 4;
  if (kind === 'table') return 5;
  if (kind === 'axes' || kind === 'circle') return 6;
  return 7;
}

function viewFromAnchor(anchor: { x: number; y: number }): Omit<SemanticViewport, 'itemIds' | 'viewIndex' | 'viewCount'> {
  return {
    x: Math.max(0, Math.min(BOARD_W - FOCUS_W, anchor.x - FOCUS_W / 2)),
    y: Math.max(0, Math.min(BOARD_H - FOCUS_H, anchor.y - FOCUS_H / 2)),
    w: FOCUS_W,
    h: FOCUS_H,
  };
}

function overviewViewport(): SemanticViewport {
  return { x: 0, y: 0, w: BOARD_W, h: BOARD_H, itemIds: [], viewIndex: 0, viewCount: 1 };
}

export function deriveSemanticViewport(scene: SceneState, semanticObjectId: string | undefined, viewIndex = 0, priorityItemIds: string[] = []): SemanticViewport {
  const views = deriveSemanticViewports(scene, semanticObjectId, priorityItemIds);
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

export function contains(outer: Pick<BBox, 'x' | 'y' | 'w' | 'h'>, inner: BBox, tolerance = 0.5): boolean {
  return inner.x >= outer.x - tolerance && inner.y >= outer.y - tolerance &&
    inner.x + inner.w <= outer.x + outer.w + tolerance && inner.y + inner.h <= outer.y + outer.h + tolerance;
}
