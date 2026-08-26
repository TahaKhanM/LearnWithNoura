import type { SceneState } from './scene';

/**
 * Section-scoped slice for snapshots, preflight, and quality — not a render
 * filter. The live canvas shows every region; this helper captures one tile
 * in its local 1000×600 space. Legacy items without a group stay in region 0.
 */
export function sceneForGroup(scene: SceneState, semanticGroupId?: string): SceneState {
  if (!semanticGroupId) return scene;
  return {
    ...scene,
    items: scene.items.filter((item) => !item.semanticGroupId || item.semanticGroupId === semanticGroupId),
  };
}

export function groupItemCount(scene: SceneState, semanticGroupId?: string): number {
  return sceneForGroup(scene, semanticGroupId).items.length;
}
