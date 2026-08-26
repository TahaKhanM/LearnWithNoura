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

  it('counts assets toward the item budget and rejects an overcrowded icon field', () => {
    const ops = Array.from({ length: 9 }, (_, index) => ({
      op: 'add' as const,
      id: `icon-${index}`,
      spec: { kind: 'asset' as const, assetId: 'sun', at: [120 + index * 80, 200] as [number, number], size: 48 },
    }));
    const scene = applyOps(emptyScene, ops, 'tutor', 'icons').scene;
    expect(evaluateBoardQuality(scene)).toMatchObject({
      accepted: false,
      itemCount: 9,
      reasons: expect.arrayContaining([expect.stringContaining('asset_density')]),
    });
  });

  it('rejects a section that accumulates too many independent objects', () => {
    const ops = Array.from({ length: 31 }, (_, index) => ({
      op: 'add' as const, id: `item-${index}`, spec: { kind: 'line' as const, from: [30 + index, 100] as [number, number], to: [30 + index, 300] as [number, number] },
    }));
    const scene = applyOps(emptyScene, ops, 'tutor', 'dense').scene;
    expect(evaluateBoardQuality(scene)).toMatchObject({ accepted: false, itemCount: 31, reasons: expect.arrayContaining([expect.stringContaining('density')]) });
  });
});
