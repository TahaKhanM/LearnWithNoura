import { describe, expect, it } from 'vitest';
import { applyOps, emptyScene } from './scene';
import { analyzeLearnerBoardChange, analysisFocusBox } from './learnerSketch';
import type { BoardOp } from '../../shared/boardOps';

describe('learner sketch intelligence', () => {
  it('classifies a mark and grounds it against nearby tutor objects', () => {
    let scene = applyOps(emptyScene, [
      { op: 'add', id: 'fraction-scale', spec: { kind: 'numberline', at: [130, 300], w: 740, min: 0, max: 1 } },
    ], 'tutor', 'fractions').scene;
    const op: BoardOp = { op: 'add', id: 'sketch-underline', spec: { kind: 'path', points: [[310, 330], [380, 331], [450, 330]] } };
    scene = applyOps(scene, [op], 'learner', 'fractions').scene;
    const analysis = analyzeLearnerBoardChange(scene, [op], 'fractions');
    expect(analysis.strokes[0]).toMatchObject({ gesture: 'underline', nearestObjectIds: ['fraction-scale'] });
    expect(analysis.semanticGroupId).toBe('fractions');
    expect(analysisFocusBox(analysis)).toMatchObject({ x: 240, y: 260 });
  });

  it('recognizes a closed round mark without claiming exact semantic meaning', () => {
    const points = Array.from({ length: 25 }, (_, index): [number, number] => {
      const angle = (index / 24) * Math.PI * 2;
      return [500 + Math.cos(angle) * 40, 250 + Math.sin(angle) * 38];
    });
    const op: BoardOp = { op: 'add', id: 'sketch-circle', spec: { kind: 'path', points } };
    const scene = applyOps(emptyScene, [op], 'learner', 'diagram').scene;
    expect(analyzeLearnerBoardChange(scene, [op], 'diagram').strokes[0].gesture).toBe('circle');
  });
});
