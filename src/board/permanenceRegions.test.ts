import { describe, expect, it } from 'vitest';
import { applyOps, emptyScene } from './scene';
import { layoutRegions } from './regionLayout';
import { RenderedTutorObjectTracker } from './renderedObjectTracker';

/**
 * Phase 3b invariant: a section switch is a camera move, not a filter.
 * Tutor objects stay in the rendered scene; the learner can pan back.
 * This replaces the v3.1-era visibility-filter permanence check.
 */
describe('visible-work permanence across regions', () => {
  it('never drops a tutor object from the scene when the camera pans to another region', () => {
    let scene = applyOps(emptyScene, [
      { op: 'add', id: 'first-box', spec: { kind: 'box', at: [500, 300], text: 'First idea' } },
    ], 'tutor', 'group-one').scene;
    scene = applyOps(scene, [
      { op: 'add', id: 'second-box', spec: { kind: 'box', at: [500, 300], text: 'Second idea' } },
    ], 'tutor', 'group-two').scene;

    const tutorIds = scene.items.filter((item) => item.owner === 'tutor').map((item) => item.id);
    expect(tutorIds).toEqual(['first-box', 'second-box']);

    const layout = layoutRegions(scene);
    expect(layout.ids).toEqual(['group-one', 'group-two']);
    expect(layout.offset('group-one').x).toBe(0);
    expect(layout.offset('group-two').x).toBeGreaterThan(0);

    const tracker = new RenderedTutorObjectTracker();
    tracker.observe({ visibleTutorIds: tutorIds, allTutorIds: tutorIds });
    expect(tracker.observe({
      visibleTutorIds: tutorIds,
      allTutorIds: tutorIds,
      navigation: {
        previousGroupId: 'group-one',
        nextGroupId: 'group-two',
        cause: 'picker',
      },
    })).toEqual([]);

    expect(scene.items.map((item) => item.id)).toEqual(['first-box', 'second-box']);
  });
});
