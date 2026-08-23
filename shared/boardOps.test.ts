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
});
