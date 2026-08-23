import { describe, expect, it } from 'vitest';
import { applyOps, emptyScene } from './scene';
import { evaluateBoardQuality } from './quality';

describe('board quality budget', () => {
  it('accepts a compact teaching diagram', () => {
    const scene = applyOps(emptyScene, [
      { op: 'add', id: 'idea', spec: { kind: 'box', at: [500, 260], text: 'Core idea' } },
      { op: 'add', id: 'result', spec: { kind: 'equation', at: [430, 380], latex: 'a+b=c' } },
    ], 'tutor', 'compact').scene;
    expect(evaluateBoardQuality(scene)).toMatchObject({ accepted: true, score: 100, itemCount: 2 });
  });

  it('rejects a section that accumulates too many independent objects', () => {
    const ops = Array.from({ length: 31 }, (_, index) => ({
      op: 'add' as const, id: `item-${index}`, spec: { kind: 'line' as const, from: [30 + index, 100] as [number, number], to: [30 + index, 300] as [number, number] },
    }));
    const scene = applyOps(emptyScene, ops, 'tutor', 'dense').scene;
    expect(evaluateBoardQuality(scene)).toMatchObject({ accepted: false, itemCount: 31, reasons: expect.arrayContaining([expect.stringContaining('density')]) });
  });
});
