import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { evaluateManipulativeCheck } from './manipulativeCheck.js';
import type { DraggableSpec, SnapZoneSpec } from './manipulativeSpecs.js';

describe('evaluateManipulativeCheck tolerance', () => {
  const lineId = 'fraction-line';
  const markerId = 'fraction-marker';
  const zoneId = 'three-quarter-zone';

  const items = [
    {
      id: lineId,
      spec: {
        kind: 'numberline' as const,
        at: [130, 300] as [number, number],
        w: 740,
        min: 0,
        max: 1,
      },
    },
    {
      id: markerId,
      spec: {
        kind: 'draggable' as const,
        handle: 'token' as const,
        at: [130, 300] as [number, number],
        size: 44,
      } satisfies DraggableSpec,
    },
    {
      id: zoneId,
      spec: {
        kind: 'snapZone' as const,
        shape: 'interval' as const,
        at: [130, 300] as [number, number],
        numberlineId: lineId,
        from: 0.7,
        to: 0.8,
        tolerance: 10,
      } satisfies SnapZoneSpec,
    },
  ];

  const targetX = 130 + 0.75 * 740;

  it('passes when the marker is inside the interval tolerance', () => {
    const moved = items.map((item) =>
      item.id === markerId
        ? { ...item, spec: { ...item.spec, at: [targetX, 300] as [number, number] } }
        : item,
    );
    const result = evaluateManipulativeCheck({
      check: { targetId: markerId, predicate: 'snapped', snapZoneId: zoneId, tolerance: 12 },
      items: moved,
    });
    expect(result.passed).toBe(true);
  });

  it('passes on the boundary within tolerance', () => {
    const edgeX = 130 + 0.7 * 740 + 1;
    const moved = items.map((item) =>
      item.id === markerId
        ? { ...item, spec: { ...item.spec, at: [edgeX, 300] as [number, number] } }
        : item,
    );
    const result = evaluateManipulativeCheck({
      check: { targetId: markerId, predicate: 'snapped', snapZoneId: zoneId, tolerance: 12 },
      items: moved,
    });
    expect(result.passed).toBe(true);
  });

  it('fails just outside the tolerance band', () => {
    const outsideX = 130 + 0.7 * 740 - 20;
    const moved = items.map((item) =>
      item.id === markerId
        ? { ...item, spec: { ...item.spec, at: [outsideX, 300] as [number, number] } }
        : item,
    );
    const result = evaluateManipulativeCheck({
      check: { targetId: markerId, predicate: 'snapped', snapZoneId: zoneId, tolerance: 8 },
      items: moved,
    });
    expect(result.passed).toBe(false);
  });

  it('passes at exactly tolerance and fails at tolerance plus epsilon', () => {
    const tolerance = 12;
    const edgeX = 130 + 0.7 * 740;
    const passAt = edgeX - tolerance;
    const failAt = edgeX - tolerance - 0.01;
    const looseZoneItems = items.map((item) =>
      item.id === zoneId ? { ...item, spec: { ...item.spec, tolerance: undefined } } : item,
    );
    const passItems = looseZoneItems.map((item) =>
      item.id === markerId ? { ...item, spec: { ...item.spec, at: [passAt, 300] as [number, number] } } : item,
    );
    const failItems = looseZoneItems.map((item) =>
      item.id === markerId ? { ...item, spec: { ...item.spec, at: [failAt, 300] as [number, number] } } : item,
    );
    expect(evaluateManipulativeCheck({
      check: { targetId: markerId, predicate: 'snapped', snapZoneId: zoneId, tolerance },
      items: passItems,
    }).passed).toBe(true);
    expect(evaluateManipulativeCheck({
      check: { targetId: markerId, predicate: 'snapped', snapZoneId: zoneId, tolerance },
      items: failItems,
    }).passed).toBe(false);
  });

  it('prefers zone tolerance over check tolerance when both are set', () => {
    const outsideX = 130 + 0.8 * 740 + 11;
    const moved = items.map((item) =>
      item.id === markerId ? { ...item, spec: { ...item.spec, at: [outsideX, 300] as [number, number] } } : item,
    );
    expect(evaluateManipulativeCheck({
      check: { targetId: markerId, predicate: 'snapped', snapZoneId: zoneId, tolerance: 20 },
      items: moved,
    }).passed).toBe(false);
  });

  it('fail-closed when snap zone, selection, or number line is missing', () => {
    expect(evaluateManipulativeCheck({
      check: { targetId: markerId, predicate: 'snapped' },
      items,
    }).passed).toBe(false);
    expect(evaluateManipulativeCheck({
      check: { targetId: 'fraction-line', predicate: 'selected' },
      items,
    }).passed).toBe(false);
    const noLineZone = items.map((item) =>
      item.id === zoneId ? { ...item, spec: { ...item.spec, numberlineId: 'missing-line' } } : item,
    );
    expect(evaluateManipulativeCheck({
      check: { targetId: markerId, predicate: 'snapped', snapZoneId: zoneId, tolerance: 12 },
      items: noLineZone,
    }).passed).toBe(false);
    const degenerateLine = items.map((item) =>
      item.id === lineId ? { ...item, spec: { ...item.spec, min: 1, max: 1 } } : item,
    );
    expect(evaluateManipulativeCheck({
      check: { targetId: markerId, predicate: 'snapped', snapZoneId: zoneId, tolerance: 12 },
      items: degenerateLine,
    }).passed).toBe(false);
  });

  it('property: points inside the box always pass within checks', () => {
    fc.assert(fc.property(
      fc.integer({ min: -5, max: 5 }),
      fc.integer({ min: -5, max: 5 }),
      (dx, dy) => {
        const at: [number, number] = [500 + dx, 300 + dy];
        const result = evaluateManipulativeCheck({
          check: {
            targetId: markerId,
            predicate: 'within',
            bounds: { at: [500, 300], w: 80, h: 44 },
            tolerance: 6,
          },
          items: [{ id: markerId, spec: { kind: 'draggable', handle: 'point', at, size: 44 } }],
        });
        return result.passed;
      },
    ));
  });

  it('property: points clearly outside the box fail', () => {
    fc.assert(fc.property(
      fc.integer({ min: 60, max: 200 }),
      (offset) => {
        const result = evaluateManipulativeCheck({
          check: {
            targetId: markerId,
            predicate: 'within',
            bounds: { at: [500, 300], w: 80, h: 44 },
            tolerance: 4,
          },
          items: [{ id: markerId, spec: { kind: 'draggable', handle: 'point', at: [500 + offset, 300], size: 44 } }],
        });
        return !result.passed;
      },
    ));
  });
});
