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

  it('counts an illustration toward the item budget and rejects a second one in the same section', () => {
    const one = applyOps(emptyScene, [
      { op: 'add', id: 'pond', spec: { kind: 'image', assetId: 'img-a1b2c3d4e5f67890', at: [80, 60], w: 840, h: 420, alt: 'A pond' } },
      { op: 'add', id: 'frog-label', spec: { kind: 'text', at: [200, 540], text: 'frog' } },
    ], 'tutor', 'habitat').scene;
    expect(evaluateBoardQuality(one)).toMatchObject({ accepted: true, itemCount: 2 });

    const two = applyOps(one, [
      { op: 'add', id: 'pond-2', spec: { kind: 'image', assetId: 'img-b1b2c3d4e5f67890', at: [80, 60], w: 400, h: 200, alt: 'Another pond' } },
    ], 'tutor', 'habitat').scene;
    expect(evaluateBoardQuality(two)).toMatchObject({
      accepted: false,
      reasons: expect.arrayContaining([expect.stringContaining('illustration_density')]),
    });
  });

  it('reports exact connector crossing ids and bounds for correction', () => {
    const scene = applyOps(emptyScene, [
      { op: 'add', id: 'c1', spec: { kind: 'line', from: [100, 100], to: [900, 500], arrow: 'end' } },
      { op: 'add', id: 'c2', spec: { kind: 'line', from: [100, 500], to: [900, 100], arrow: 'end' } },
      { op: 'add', id: 'c3', spec: { kind: 'line', from: [500, 60], to: [500, 540], arrow: 'end' } },
    ], 'tutor', 'crossed').scene;
    const report = evaluateBoardQuality(scene);

    expect(report.accepted).toBe(false);
    expect(report.layoutIssues).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'connector_crossing',
      itemId: expect.stringMatching(/^c[123]$/),
      withItemId: expect.stringMatching(/^c[123]$/),
      itemBounds: expect.any(Object),
      withItemBounds: expect.any(Object),
    })]));
  });

  it('rejects a section that accumulates too many independent objects', () => {
    const ops = Array.from({ length: 31 }, (_, index) => ({
      op: 'add' as const, id: `item-${index}`, spec: { kind: 'line' as const, from: [30 + index, 100] as [number, number], to: [30 + index, 300] as [number, number] },
    }));
    const scene = applyOps(emptyScene, ops, 'tutor', 'dense').scene;
    expect(evaluateBoardQuality(scene)).toMatchObject({ accepted: false, itemCount: 31, reasons: expect.arrayContaining([expect.stringContaining('density')]) });
  });
});
