import { describe, expect, it } from 'vitest';
import { RenderedTutorObjectTracker } from './renderedObjectTracker';

describe('RenderedTutorObjectTracker', () => {
  it('treats the initial snapshot and additive updates as observations, not disappearances', () => {
    const tracker = new RenderedTutorObjectTracker();

    expect(tracker.observe({
      visibleTutorIds: ['a', 'b'],
      allTutorIds: ['a', 'b'],
    })).toEqual([]);
    expect(tracker.observe({
      visibleTutorIds: ['a', 'b', 'c'],
      allTutorIds: ['a', 'b', 'c'],
    })).toEqual([]);
  });

  it('reports a previously rendered tutor object removed from the full scene', () => {
    const tracker = new RenderedTutorObjectTracker();
    tracker.observe({
      visibleTutorIds: ['a', 'b'],
      allTutorIds: ['a', 'b'],
    });

    expect(tracker.observe({
      visibleTutorIds: ['b'],
      allTutorIds: ['b'],
    })).toEqual([{ objectId: 'a', cause: 'scene_mutation' }]);
  });

  it('suppresses visibility changes announced as section navigation', () => {
    const tracker = new RenderedTutorObjectTracker();
    tracker.observe({
      visibleTutorIds: ['a'],
      allTutorIds: ['a', 'b'],
    });

    expect(tracker.observe({
      visibleTutorIds: ['b'],
      allTutorIds: ['a', 'b'],
      navigation: {
        previousGroupId: 'group-a',
        nextGroupId: 'group-b',
        cause: 'picker',
      },
    })).toEqual([]);
  });

  it('still reports a full-scene removal during announced navigation', () => {
    const tracker = new RenderedTutorObjectTracker();
    tracker.observe({
      visibleTutorIds: ['a', 'retired'],
      allTutorIds: ['a', 'b', 'retired'],
    });

    expect(tracker.observe({
      visibleTutorIds: ['b'],
      allTutorIds: ['a', 'b'],
      navigation: {
        previousGroupId: 'group-a',
        nextGroupId: 'group-b',
        cause: 'notice_open',
      },
    })).toEqual([{ objectId: 'retired', cause: 'scene_mutation' }]);
  });

  it('reports an unannounced visibility-filter removal as unknown', () => {
    const tracker = new RenderedTutorObjectTracker();
    tracker.observe({
      visibleTutorIds: ['a'],
      allTutorIds: ['a', 'b'],
    });

    expect(tracker.observe({
      visibleTutorIds: ['b'],
      allTutorIds: ['a', 'b'],
    })).toEqual([{ objectId: 'a', cause: 'unknown' }]);
  });

  it('reset makes the next snapshot a fresh initialization', () => {
    const tracker = new RenderedTutorObjectTracker();
    tracker.observe({
      visibleTutorIds: ['a'],
      allTutorIds: ['a'],
    });

    tracker.reset();

    expect(tracker.observe({
      visibleTutorIds: [],
      allTutorIds: [],
    })).toEqual([]);
  });
});
