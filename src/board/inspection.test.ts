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

  it('detects destructive text-bearing collisions', () => {
    const scene = applyOps(emptyScene, [
      { op: 'add', id: 'a', spec: { kind: 'box', at: [400, 300], text: 'First idea' } },
      { op: 'add', id: 'b', spec: { kind: 'box', at: [405, 305], text: 'Second idea' } },
    ], 'tutor').scene;
    expect(inspectScene(scene).issues).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'collision' })]));
  });
});
