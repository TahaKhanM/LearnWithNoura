import { describe, expect, it } from 'vitest';
import type { BoardOp } from '../../shared/boardOps';
import { annotationGeometryCollisions, layoutTutorAnnotations } from './annotationLayout';
import { inspectScene } from './inspection';
import { applyOps, emptyScene } from './scene';

const overlappingTriangle: BoardOp[] = [
  { op: 'add', id: 'triangle', spec: { kind: 'polygon', points: [[160, 450], [500, 100], [820, 450]], closed: true } },
  { op: 'add', id: 'top-line', spec: { kind: 'line', from: [120, 100], to: [880, 100], dash: true } },
  { op: 'add', id: 'apex-angle', spec: { kind: 'angle', vertex: [500, 100], from: [160, 450], to: [820, 450], label: 'C' } },
  { op: 'add', id: 'half-turn', spec: { kind: 'text', at: [510, 250], text: 'Half-turn = 180°' } },
  { op: 'add', id: 'straight-angle', spec: { kind: 'text', at: [410, 315], text: 'Straight angle' } },
];

describe('geometry-aware annotation layout', () => {
  it('detects the screenshot failure that the old text-only inspector accepted', () => {
    const scene = applyOps(emptyScene, overlappingTriangle, 'tutor').scene;
    expect(annotationGeometryCollisions(scene)).toEqual(expect.arrayContaining([
      { itemId: 'half-turn', withItemId: 'triangle' },
    ]));
    expect(inspectScene(scene).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: 'half-turn', kind: 'stroke_collision', withItemId: 'triangle' }),
    ]));
  });

  it('moves only the colliding annotation to the closest clear lane', () => {
    const scene = applyOps(emptyScene, overlappingTriangle, 'tutor').scene;
    const arranged = layoutTutorAnnotations(scene);
    const halfTurn = arranged.items.find((item) => item.id === 'half-turn');
    const straight = arranged.items.find((item) => item.id === 'straight-angle');

    expect(halfTurn?.spec.kind === 'text' ? halfTurn.spec.at : null).not.toEqual([510, 250]);
    expect(straight?.spec.kind === 'text' ? straight.spec.at : null).toEqual([410, 315]);
    expect(annotationGeometryCollisions(arranged)).toEqual([]);
    expect(inspectScene(arranged)).toMatchObject({ accepted: true, issues: [] });
  });
});
