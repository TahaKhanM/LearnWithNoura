import { BOARD_H, BOARD_W } from '../../shared/boardOps';
import type { SceneState } from './scene';

/** Horizontal gap between adjacent 1000×600 section tiles. */
export const REGION_GUTTER = 80;
/** How much of the previous tile remains visible when the camera sits on a later region.
 * Larger than the gutter so a sliver of the neighbouring drawing is actually on screen. */
export const REGION_PEEK = 200;

export interface RegionOffset {
  x: number;
  y: number;
}

export interface CameraBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Maps section ids onto a horizontal strip of local 1000×600 tiles.
 * Local coordinates are never rewritten; renderers apply the offset.
 *
 * Replay mapping lives here, not in callers: items without a section
 * inherit region 0 (the first named section, or the implicit origin).
 */
export interface RegionLayout {
  ids: string[];
  offset(groupId?: string | null): RegionOffset;
  indexOf(groupId?: string | null): number;
  localPoint(groupId: string | undefined, world: [number, number]): [number, number];
  worldPoint(groupId: string | undefined, local: [number, number]): [number, number];
}

export function layoutRegions(scene: SceneState): RegionLayout {
  const ids: string[] = [];
  for (const item of scene.items) {
    const id = item.semanticGroupId;
    if (id && !ids.includes(id)) ids.push(id);
  }
  const indexOf = (groupId?: string | null): number => {
    if (!groupId) return 0;
    const index = ids.indexOf(groupId);
    return index >= 0 ? index : 0;
  };
  const offset = (groupId?: string | null): RegionOffset => ({
    x: indexOf(groupId) * (BOARD_W + REGION_GUTTER),
    y: 0,
  });
  return {
    ids,
    offset,
    indexOf,
    localPoint(groupId, world) {
      const origin = offset(groupId);
      return [world[0] - origin.x, world[1] - origin.y];
    },
    worldPoint(groupId, local) {
      const origin = offset(groupId);
      return [local[0] + origin.x, local[1] + origin.y];
    },
  };
}

/** Settled camera. A single region is exactly today's 1000×600 viewBox. */
export function cameraViewBox(layout: RegionLayout, activeId?: string | null): CameraBox {
  if (layout.ids.length <= 1) return { x: 0, y: 0, w: BOARD_W, h: BOARD_H };
  const origin = layout.offset(activeId);
  const peekLeft = layout.indexOf(activeId) > 0 ? REGION_PEEK : 0;
  return {
    x: origin.x - peekLeft,
    y: 0,
    w: BOARD_W + peekLeft,
    h: BOARD_H,
  };
}

export function interpolateCamera(from: CameraBox, to: CameraBox, t: number): CameraBox {
  const clamped = Math.min(1, Math.max(0, t));
  const ease = 1 - (1 - clamped) ** 3;
  return {
    x: from.x + (to.x - from.x) * ease,
    y: from.y + (to.y - from.y) * ease,
    w: from.w + (to.w - from.w) * ease,
    h: from.h + (to.h - from.h) * ease,
  };
}

export const CAMERA_PAN_MS = 420;
