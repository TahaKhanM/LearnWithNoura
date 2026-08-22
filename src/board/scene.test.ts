import { describe, expect, it } from 'vitest';
import { applyOps, emptyScene, describeScene } from './scene';
import type { BoardOp } from '../../shared/boardOps';

const add = (id: string, r = 20): BoardOp => ({
  op: 'add',
  id,
  spec: { kind: 'circle', center: [100, 100], r },
});

describe('applyOps', () => {
  it('adds items and reports them for animation', () => {
    const result = applyOps(emptyScene, [add('a'), add('b')], 'tutor');
    expect(result.scene.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(result.added).toEqual(['a', 'b']);
  });

  it('replaces on duplicate id, keeping z-order and bumping revision', () => {
    const first = applyOps(emptyScene, [add('a'), add('b')], 'tutor');
    const second = applyOps(first.scene, [add('a', 50)], 'tutor');
    expect(second.scene.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(second.added).toEqual([]);
    expect(second.scene.items[0].revision).toBe(1);
    expect((second.scene.items[0].spec as { r: number }).r).toBe(50);
  });

  it('updates via validated merge', () => {
    const base = applyOps(emptyScene, [add('a')], 'tutor');
    const updated = applyOps(base.scene, [{ op: 'update', id: 'a', props: { r: 60 } }], 'tutor');
    expect((updated.scene.items[0].spec as { r: number }).r).toBe(60);
    const corrupt = applyOps(base.scene, [{ op: 'update', id: 'a', props: { r: 'x' } }], 'tutor');
    expect((corrupt.scene.items[0].spec as { r: number }).r).toBe(20);
  });

  it('erase removes dependents (labels, plots, connectors)', () => {
    const base = applyOps(
      emptyScene,
      [
        add('target'),
        { op: 'add', id: 'lbl', spec: { kind: 'label', target: 'target', text: 'hi' } },
        { op: 'add', id: 'other', spec: { kind: 'label', target: 'elsewhere', text: 'yo' } },
      ],
      'tutor',
    );
    const result = applyOps(base.scene, [{ op: 'erase', id: 'target' }], 'tutor');
    expect(result.scene.items.map((i) => i.id)).toEqual(['other']);
  });

  it('clear wipes items and bumps the epoch', () => {
    const base = applyOps(emptyScene, [add('a')], 'tutor');
    const cleared = applyOps(base.scene, [{ op: 'clear' }], 'tutor');
    expect(cleared.scene.items).toHaveLength(0);
    expect(cleared.scene.epoch).toBe(1);
  });

  it('collects highlights only for objects that exist', () => {
    const base = applyOps(emptyScene, [add('a')], 'tutor');
    const result = applyOps(
      base.scene,
      [
        { op: 'highlight', id: 'a' },
        { op: 'highlight', id: 'ghost' },
      ],
      'tutor',
    );
    expect(result.highlighted).toEqual(['a']);
  });
});

describe('describeScene', () => {
  it('describes ownership so the tutor respects learner marks', () => {
    const withTutor = applyOps(emptyScene, [add('a')], 'tutor');
    const withBoth = applyOps(
      withTutor.scene,
      [{ op: 'add', id: 'sketch', spec: { kind: 'path', points: [[0, 0], [10, 10]] } }],
      'learner',
    );
    const text = describeScene(withBoth.scene);
    expect(text).toContain('a: circle');
    expect(text).toContain('drawn by the learner');
  });

  it('handles the empty board', () => {
    expect(describeScene(emptyScene)).toContain('empty');
  });
});
