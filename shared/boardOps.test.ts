import { describe, expect, it } from 'vitest';
import { applyUpdate, normalizeColor, validateOps, PALETTE, BOARD_W } from './boardOps';

describe('validateOps', () => {
  it('accepts a well-formed add', () => {
    const { ops, rejected } = validateOps([
      { op: 'add', id: 't1', kind: 'polygon', points: [[0, 0], [100, 0], [50, 80]], color: 'blue' },
    ]);
    expect(rejected).toHaveLength(0);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'add', id: 't1', color: PALETTE.blue });
  });

  it('drops invalid entries without failing the batch', () => {
    const { ops, rejected } = validateOps([
      { op: 'add', id: 'ok', kind: 'circle', center: [100, 100], r: 30 },
      { op: 'add', id: 'bad', kind: 'circle', center: [100] },
      { op: 'add', kind: 'circle', center: [1, 1], r: 5 },
      { op: 'nonsense' },
      'not an object',
    ]);
    expect(ops).toHaveLength(1);
    expect(rejected).toHaveLength(4);
  });

  it('clamps coordinates onto the board', () => {
    const { ops } = validateOps([
      { op: 'add', id: 'l1', kind: 'line', from: [-500, 90], to: [5000, 90] },
    ]);
    const spec = (ops[0] as { spec: { from: number[]; to: number[] } }).spec;
    expect(spec.from[0]).toBe(0);
    expect(spec.to[0]).toBe(BOARD_W);
  });

  it('rejects NaN and non-numeric geometry', () => {
    const { ops, rejected } = validateOps([
      { op: 'add', id: 'x', kind: 'circle', center: [NaN, 10], r: 10 },
      { op: 'add', id: 'y', kind: 'circle', center: ['a', 10], r: 10 },
    ]);
    expect(ops).toHaveLength(0);
    expect(rejected).toHaveLength(2);
  });

  it('refuses learner-only kinds from the model', () => {
    const { ops, rejected } = validateOps([
      { op: 'add', id: 'p', kind: 'path', points: [[0, 0], [10, 10]] },
    ]);
    expect(ops).toHaveLength(0);
    expect(rejected[0].reason).toContain('learner-only');
  });

  it('requires sane ids', () => {
    const { rejected } = validateOps([
      { op: 'add', id: 'has spaces!', kind: 'circle', center: [10, 10], r: 5 },
      { op: 'erase', id: '<script>' },
    ]);
    expect(rejected).toHaveLength(2);
  });

  it('caps text length', () => {
    const { ops } = validateOps([
      { op: 'add', id: 't', kind: 'text', at: [10, 40], text: 'x'.repeat(1000) },
    ]);
    const spec = (ops[0] as { spec: { text: string } }).spec;
    expect(spec.text.length).toBeLessThanOrEqual(120);
  });

  it('validates plots need an expression or points', () => {
    const { ops, rejected } = validateOps([
      { op: 'add', id: 'p1', kind: 'plot', axes: 'ax' },
      { op: 'add', id: 'p2', kind: 'plot', axes: 'ax', expr: 'x^2' },
      { op: 'add', id: 'p3', kind: 'plot', axes: 'ax', points: [[0, 0], [1, 1]] },
    ]);
    expect(rejected).toHaveLength(1);
    expect(ops).toHaveLength(2);
  });

  it('pads ragged table rows', () => {
    const { ops } = validateOps([
      { op: 'add', id: 't', kind: 'table', at: [10, 10], rows: [['a', 'b', 'c'], ['d']] },
    ]);
    const spec = (ops[0] as { spec: { rows: string[][] } }).spec;
    expect(spec.rows[1]).toHaveLength(3);
  });

  it('passes through clear/highlight/erase/update', () => {
    const { ops } = validateOps([
      { op: 'clear' },
      { op: 'highlight', id: 'a' },
      { op: 'erase', id: 'b' },
      { op: 'update', id: 'c', props: { text: 'new' } },
    ]);
    expect(ops.map((o) => o.op)).toEqual(['clear', 'highlight', 'erase', 'update']);
  });
});

describe('normalizeColor', () => {
  it('maps names and hexes onto the marker tray', () => {
    expect(normalizeColor('blue')).toBe(PALETTE.blue);
    expect(normalizeColor('#2C5BE0')).toBe(PALETTE.blue);
    expect(normalizeColor('#ff0000')).toBe(PALETTE.red);
    expect(normalizeColor('#111111')).toBe(PALETTE.ink);
    expect(normalizeColor('hotpink')).toBeUndefined();
  });
});

describe('applyUpdate', () => {
  it('merges valid props', () => {
    const spec = { kind: 'text' as const, at: [10, 20] as [number, number], text: 'hi' };
    const updated = applyUpdate(spec, { text: 'there' });
    expect(updated).toMatchObject({ kind: 'text', text: 'there' });
  });

  it('ignores updates that would corrupt the spec', () => {
    const spec = { kind: 'circle' as const, center: [10, 20] as [number, number], r: 30 };
    const updated = applyUpdate(spec, { r: 'huge' });
    expect(updated).toEqual(spec);
  });

  it('cannot change the kind', () => {
    const spec = { kind: 'circle' as const, center: [10, 20] as [number, number], r: 30 };
    const updated = applyUpdate(spec, { kind: 'text', text: 'x', at: [0, 0] });
    expect(updated.kind).toBe('circle');
  });

  it('strips handwritten style on the fast tier and keeps it on the authored tier', () => {
    const spec = { kind: 'text' as const, at: [10, 20] as [number, number], text: 'typeset' };
    expect(applyUpdate(spec, { style: 'handwritten' })).toEqual(spec);
    expect(applyUpdate(spec, { style: 'handwritten' }, { tier: 'fast' })).toEqual(spec);
    expect(applyUpdate(spec, { style: 'handwritten' }, { tier: 'authored' })).toMatchObject({
      kind: 'text',
      text: 'typeset',
      style: 'handwritten',
    });
  });

  it('blocks fast-tier updates to existing manipulatives', () => {
    const draggable = { kind: 'draggable' as const, at: [200, 300] as [number, number], handle: 'token' as const, size: 44 };
    expect(applyUpdate(draggable, { at: [685, 300] })).toEqual(draggable);
    expect(applyUpdate(draggable, { at: [685, 300] }, { tier: 'fast' })).toEqual(draggable);

    const snapZone = {
      kind: 'snapZone' as const,
      shape: 'interval' as const,
      at: [685, 300] as [number, number],
      from: 0.7,
      to: 0.8,
    };
    expect(applyUpdate(snapZone, { from: 0, to: 1 }, { tier: 'fast' })).toEqual(snapZone);

    const tappable = { kind: 'tappable' as const, at: [400, 300] as [number, number], shape: 'circle' as const };
    expect(applyUpdate(tappable, { selected: true }, { tier: 'fast' })).toEqual(tappable);
  });

  it('applies a fast-tier geometry update to a point and refuses authored mutations', () => {
    const point = { kind: 'point' as const, at: [10, 20] as [number, number], label: 'A' };
    expect(applyUpdate(point, { at: [120, 80] }, { tier: 'fast' })).toMatchObject({ kind: 'point', at: [120, 80] });

    const image = {
      kind: 'image' as const,
      assetId: 'img-a1b2c3d4e5f67890',
      at: [80, 60] as [number, number],
      w: 840,
      h: 420,
      alt: 'A pond',
    };
    expect(applyUpdate(image, { at: [100, 80] }, { tier: 'fast' })).toEqual(image);
  });
});
