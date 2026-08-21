import { describe, expect, it } from 'vitest';
import { DrawLine, drawPath, writeText } from './types';
import {
  compactBoardSnapshot,
  createBoardObject,
  samplePath,
  snapshotBoard,
} from './scene';

describe('board scene', () => {
  it('keeps stable identity and ownership around an action', () => {
    expect(createBoardObject('learner', writeText('my note', 12, 34), 'note-1')).toEqual({
      id: 'note-1',
      owner: 'learner',
      action: { type: 'writeText', str: 'my note', x: 12, y: 34 },
    });
  });

  it('takes a detached snapshot of freehand points', () => {
    const points = [{ x: 1, y: 2 }];
    const scene = [createBoardObject('learner', drawPath(points), 'stroke-1')];
    const snapshot = snapshotBoard(scene);
    points[0].x = 99;

    expect(snapshot.objects[0].action).toEqual({
      type: 'drawPath',
      points: [{ x: 1, y: 2 }],
    });
  });

  it('compacts the scene while retaining learner ownership', () => {
    const compact = compactBoardSnapshot(
      snapshotBoard([
        createBoardObject('tutor', DrawLine(10, 20, 30, 40), 'line-1'),
        createBoardObject('learner', writeText('Why?', 50, 60), 'text-1'),
      ]),
    );

    expect(compact).toEqual({
      size: [1000, 600],
      objects: [
        { owner: 'tutor', type: 'line', from: [10, 20], to: [30, 40] },
        { owner: 'learner', type: 'text', at: [50, 60], text: 'Why?' },
      ],
    });
  });
});

describe('samplePath', () => {
  it('keeps the beginning and end while bounding context size', () => {
    const points = Array.from({ length: 200 }, (_, x) => ({ x, y: x * 2 }));
    const sampled = samplePath(points, 10);

    expect(sampled).toHaveLength(10);
    expect(sampled[0]).toEqual(points[0]);
    expect(sampled.at(-1)).toEqual(points.at(-1));
  });
});
