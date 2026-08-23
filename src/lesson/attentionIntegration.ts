import type { Vec } from '../../shared/boardOps';
import { compileScene } from '../board/compile';
import type { SceneState } from '../board/scene';

export function centerForSemanticObject(scene: SceneState, semanticObjectId: string): Vec | undefined {
  const sources = new Map(scene.items.map((item) => [item.id, item]));
  const items = compileScene(scene.items).filter((item) =>
    sources.get(item.id)?.semanticGroupId === semanticObjectId || item.id === semanticObjectId || item.id.startsWith(`${semanticObjectId}-`),
  );
  return centerForBoxes(items.map((item) => item.bbox));
}

export function centerForItemIds(scene: SceneState, ids: string[]): Vec | undefined {
  const wanted = new Set(ids);
  return centerForBoxes(compileScene(scene.items).filter((item) => wanted.has(item.id)).map((item) => item.bbox));
}

function centerForBoxes(boxes: Array<{ x: number; y: number; w: number; h: number }>): Vec | undefined {
  if (boxes.length === 0) return undefined;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return [(left + right) / 2, (top + bottom) / 2];
}
