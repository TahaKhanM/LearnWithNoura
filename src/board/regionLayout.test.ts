import { describe, expect, it } from 'vitest';
import { BOARD_H, BOARD_W } from '../../shared/boardOps';
import { applyOps, emptyScene } from './scene';
import { cameraViewBox, REGION_GUTTER, REGION_PEEK } from './regionLayout';
import { layoutRegions } from './regionLayout';

function twoRegionScene() {
  let scene = applyOps(emptyScene, [
    { op: 'add', id: 'legacy', spec: { kind: 'text', at: [40, 40], text: 'legacy' } },
  ], 'tutor').scene;
  scene = applyOps(scene, [
    { op: 'add', id: 'one-box', spec: { kind: 'box', at: [500, 300], text: 'one' } },
  ], 'tutor', 'group-one').scene;
  scene = applyOps(scene, [
    { op: 'add', id: 'two-box', spec: { kind: 'box', at: [500, 300], text: 'two' } },
  ], 'tutor', 'group-two').scene;
  return scene;
}

describe('spatial region layout', () => {
  it('maps the first section to region 0 and later sections to adjacent tiles without rewriting local coordinates', () => {
    const layout = layoutRegions(twoRegionScene());
    expect(layout.ids).toEqual(['group-one', 'group-two']);
    expect(layout.offset('group-one')).toEqual({ x: 0, y: 0 });
    expect(layout.offset('group-two')).toEqual({ x: BOARD_W + REGION_GUTTER, y: 0 });
    expect(layout.offset(undefined)).toEqual({ x: 0, y: 0 });
    expect(layout.localPoint('group-two', [500 + BOARD_W + REGION_GUTTER, 300])).toEqual([500, 300]);
    expect(layout.worldPoint('group-two', [500, 300])).toEqual([500 + BOARD_W + REGION_GUTTER, 300]);
  });

  it('keeps a single-section camera identical to today\'s 1000×600 view', () => {
    const scene = applyOps(emptyScene, [
      { op: 'add', id: 'only', spec: { kind: 'box', at: [500, 300], text: 'only' } },
    ], 'tutor', 'anchor').scene;
    const layout = layoutRegions(scene);
    expect(cameraViewBox(layout, 'anchor')).toEqual({ x: 0, y: 0, w: BOARD_W, h: BOARD_H });
  });

  it('shows a gutter peek of the neighbouring region when the camera is on region 1', () => {
    const layout = layoutRegions(twoRegionScene());
    const view = cameraViewBox(layout, 'group-two');
    expect(view.x).toBe(BOARD_W + REGION_GUTTER - REGION_PEEK);
    expect(view.y).toBe(0);
    expect(view.w).toBe(BOARD_W + REGION_PEEK);
    expect(view.h).toBe(BOARD_H);
  });
});
