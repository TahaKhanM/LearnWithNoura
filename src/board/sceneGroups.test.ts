import { describe, expect, it } from 'vitest';
import { applyOps, emptyScene } from './scene';
import { sceneForGroup } from './sceneGroups';

describe('semantic board sections', () => {
  it('keeps overlapping groups on separate pages and retains global legacy items', () => {
    let scene = applyOps(emptyScene, [{ op: 'add', id: 'legacy', spec: { kind: 'text', at: [20, 20], text: 'legacy' } }], 'tutor').scene;
    scene = applyOps(scene, [{ op: 'add', id: 'one-box', spec: { kind: 'box', at: [500, 300], text: 'one' } }], 'tutor', 'group-one').scene;
    scene = applyOps(scene, [{ op: 'add', id: 'two-box', spec: { kind: 'box', at: [500, 300], text: 'two' } }], 'tutor', 'group-two').scene;
    scene = applyOps(scene, [{ op: 'add', id: 'sketch-two', spec: { kind: 'path', points: [[1, 1], [2, 2], [3, 4]] } }], 'learner', 'group-two').scene;

    expect(sceneForGroup(scene, 'group-one').items.map((item) => item.id)).toEqual(['legacy', 'one-box']);
    expect(sceneForGroup(scene, 'group-two').items.map((item) => item.id)).toEqual(['two-box', 'sketch-two']);

    const cleared = applyOps(scene, [{ op: 'clear' }], 'tutor', 'group-two').scene;
    expect(sceneForGroup(cleared, 'group-one').items.map((item) => item.id)).toEqual(['legacy', 'one-box']);
    expect(sceneForGroup(cleared, 'group-two').items.map((item) => item.id)).toEqual(['sketch-two']);
  });

  it('keeps ungrouped legacy items in region 0 only, never in a later scoped slice', () => {
    let scene = applyOps(emptyScene, [{ op: 'add', id: 'legacy', spec: { kind: 'text', at: [20, 20], text: 'legacy' } }], 'tutor').scene;
    scene = applyOps(scene, [{ op: 'add', id: 'one-box', spec: { kind: 'box', at: [500, 300], text: 'one' } }], 'tutor', 'group-one').scene;
    scene = applyOps(scene, [{ op: 'add', id: 'two-box', spec: { kind: 'box', at: [500, 300], text: 'two' } }], 'tutor', 'group-two').scene;

    expect(sceneForGroup(scene, 'group-one').items.map((item) => item.id)).toEqual(['legacy', 'one-box']);
    expect(sceneForGroup(scene, 'group-two').items.map((item) => item.id)).not.toContain('legacy');
    expect(sceneForGroup(scene, 'group-two').items.map((item) => item.id)).toEqual(['two-box']);
  });
});
