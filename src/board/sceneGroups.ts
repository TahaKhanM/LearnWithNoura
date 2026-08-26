import type { SceneState } from './scene';

/**
 * Section-scoped slice for snapshots, preflight, and quality — not a render
 * filter. The live canvas shows every region; this helper captures one tile
 * in its local 1000×600 space. Legacy items without a group stay in region 0
 * (the first named section), matching `layoutRegions`.
 */
export function sceneForGroup(scene: SceneState, semanticGroupId?: string): SceneState {
  if (!semanticGroupId) return scene;
  const regionZeroId = firstNamedRegion(scene);
  const includeLegacy = !regionZeroId || regionZeroId === semanticGroupId;
  return {
    ...scene,
    items: scene.items.filter((item) =>
      item.semanticGroupId === semanticGroupId
      || (!item.semanticGroupId && includeLegacy),
    ),
  };
}

export function groupItemCount(scene: SceneState, semanticGroupId?: string): number {
  return sceneForGroup(scene, semanticGroupId).items.length;
}

function firstNamedRegion(scene: SceneState): string | undefined {
  for (const item of scene.items) {
    if (item.semanticGroupId) return item.semanticGroupId;
  }
  return undefined;
}
