import type { SceneState } from './scene';

/**
 * Semantic groups are board sections/pages, not layers painted into one plane.
 * Global legacy items remain visible for backward-compatible replay, while all
 * v2 tutor and learner work is scoped to its section.
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
