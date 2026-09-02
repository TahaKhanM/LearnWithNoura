import { describe, expect, it } from 'vitest';
import { applyOps, emptyScene } from './scene';
import { inspectScene, repairSceneOnce } from './inspection';

describe('scene inspection and repair', () => {
  it('rejects or repairs long labels and out-of-bounds extents', () => {
    const scene = applyOps(emptyScene, [
      { op: 'add', id: 'edge', spec: { kind: 'box', at: [0, 0], text: 'averylongunbrokenlocalizedlabel'.repeat(12) } },
    ], 'tutor').scene;
    const first = inspectScene(scene);
    expect(first.accepted).toBe(false);
    const repaired = repairSceneOnce(scene, first);
    const second = inspectScene(repaired);
    expect(second.issues.every((issue) => issue.kind !== 'non_finite')).toBe(true);
  });

  it('bounds tutor arcs, curves, and assets inside the safe board', () => {
    const scene = applyOps(emptyScene, [
      { op: 'add', id: 'arc', spec: { kind: 'arc', center: [200, 200], r: 40, startDeg: 20, endDeg: 200 } },
      { op: 'add', id: 'curve', spec: { kind: 'curve', points: [[80, 400], [160, 320], [240, 480], [320, 400]] } },
      { op: 'add', id: 'sun', spec: { kind: 'asset', assetId: 'leaf', at: [500, 220], size: 64 } },
    ], 'tutor').scene;
    const report = inspectScene(scene);
    expect(report.issues.filter((issue) => issue.kind === 'non_finite')).toEqual([]);
    expect(report.issues.filter((issue) => issue.kind === 'bounds' && ['arc', 'curve', 'sun'].includes(issue.itemId))).toEqual([]);
  });

  it('treats a generated illustration as a solid container inside the safe board', () => {
    const report = inspectScene(applyOps(emptyScene, [
      { op: 'add', id: 'pond', spec: { kind: 'image', assetId: 'img-a1b2c3d4e5f67890', at: [80, 60], w: 840, h: 420, alt: 'A pond habitat' } },
    ], 'tutor').scene);
    expect(report.issues.filter((issue) => issue.itemId === 'pond')).toEqual([]);
  });

  it('detects destructive text-bearing collisions', () => {
    const scene = applyOps(emptyScene, [
      { op: 'add', id: 'a', spec: { kind: 'box', at: [400, 300], text: 'First idea' } },
      { op: 'add', id: 'b', spec: { kind: 'box', at: [405, 305], text: 'Second idea' } },
    ], 'tutor').scene;
    expect(inspectScene(scene).issues).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'collision',
      itemId: 'b',
      withItemId: 'a',
      itemBounds: { x: expect.any(Number), y: expect.any(Number), w: expect.any(Number), h: expect.any(Number) },
      withItemBounds: { x: expect.any(Number), y: expect.any(Number), w: expect.any(Number), h: expect.any(Number) },
    })]));
  });
});
