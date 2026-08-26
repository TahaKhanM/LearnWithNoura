import { describe, expect, it } from 'vitest';
import { compileScene, type CompiledItem } from './compile';
import { applyOps, emptyScene } from './scene';
import { BOARD_W, BOARD_H, type BoardOp } from '../../shared/boardOps';

function compile(ops: BoardOp[]): CompiledItem[] {
  return compileScene(applyOps(emptyScene, ops, 'tutor').scene.items);
}

describe('compileScene', () => {
  it('closes polygons and reports stroke length for animation', () => {
    const [item] = compile([
      { op: 'add', id: 't', spec: { kind: 'polygon', points: [[0, 0], [100, 0], [0, 100]] } },
    ]);
    const path = item.nodes[0] as { d: string; length: number };
    expect(path.d.endsWith('Z')).toBe(true);
    // 100 + 100 + hypotenuse
    expect(path.length).toBeCloseTo(200 + Math.hypot(100, 100), 1);
  });

  it('draws a square marker for right angles and an arc otherwise', () => {
    const [right, acute] = compile([
      {
        op: 'add',
        id: 'r',
        spec: { kind: 'angle', vertex: [0, 0], from: [100, 0], to: [0, 100] },
      },
      {
        op: 'add',
        id: 'a',
        spec: { kind: 'angle', vertex: [0, 0], from: [100, 0], to: [100, 60] },
      },
    ]);
    expect((right.nodes[0] as { d: string }).d).not.toContain('A ');
    expect((acute.nodes[0] as { d: string }).d).toContain('A ');
  });

  it('samples expression plots inside the axes frame', () => {
    const items = compile([
      {
        op: 'add',
        id: 'ax',
        spec: { kind: 'axes', at: [100, 100], w: 400, h: 300, xRange: [-2, 2], yRange: [0, 4] },
      },
      { op: 'add', id: 'p', spec: { kind: 'plot', axes: 'ax', expr: 'x^2' } },
    ]);
    const plot = items[1];
    expect(plot.nodes.length).toBeGreaterThan(0);
    // Every plotted coordinate stays within the axes rectangle (with pen slack).
    expect(plot.bbox.x).toBeGreaterThanOrEqual(95);
    expect(plot.bbox.x + plot.bbox.w).toBeLessThanOrEqual(505);
    expect(plot.bbox.y).toBeGreaterThanOrEqual(95);
    expect(plot.bbox.y + plot.bbox.h).toBeLessThanOrEqual(405);
  });

  it('skips plots whose axes are missing rather than crashing', () => {
    const [plot] = compile([
      { op: 'add', id: 'p', spec: { kind: 'plot', axes: 'ghost', expr: 'x' } },
    ]);
    expect(plot.nodes).toHaveLength(0);
  });

  it('keeps labels on the board even for edge targets', () => {
    const items = compile([
      { op: 'add', id: 'c', spec: { kind: 'circle', center: [990, 590], r: 30 } },
      { op: 'add', id: 'l', spec: { kind: 'label', target: 'c', side: 'right', text: 'way out here' } },
    ]);
    const label = items[1];
    expect(label.bbox.x).toBeGreaterThanOrEqual(0);
    expect(label.bbox.x + label.bbox.w).toBeLessThanOrEqual(BOARD_W);
    expect(label.bbox.y + label.bbox.h).toBeLessThanOrEqual(BOARD_H);
  });

  it('separates two labels that would collide', () => {
    const items = compile([
      { op: 'add', id: 'c', spec: { kind: 'circle', center: [500, 300], r: 40 } },
      { op: 'add', id: 'l1', spec: { kind: 'label', target: 'c', side: 'below', text: 'first label' } },
      { op: 'add', id: 'l2', spec: { kind: 'label', target: 'c', side: 'below', text: 'second label' } },
    ]);
    const a = items[1].bbox;
    const b = items[2].bbox;
    const overlap =
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    expect(overlap).toBe(false);
  });

  it('routes connectors between object edges, not centers', () => {
    const items = compile([
      { op: 'add', id: 'b1', spec: { kind: 'box', at: [200, 200], text: 'from' } },
      { op: 'add', id: 'b2', spec: { kind: 'box', at: [600, 200], text: 'to' } },
      { op: 'add', id: 'c', spec: { kind: 'connector', from: 'b1', to: 'b2' } },
    ]);
    const connector = items[2];
    // The connector starts to the right of b1's center and ends left of b2's.
    expect(connector.bbox.x).toBeGreaterThan(200);
    expect(connector.bbox.x + connector.bbox.w).toBeLessThan(600);
  });

  it('gives circles exact bboxes (arc-safe)', () => {
    const [circle] = compile([
      { op: 'add', id: 'c', spec: { kind: 'circle', center: [300, 200], r: 50 } },
    ]);
    expect(circle.bbox).toEqual({ x: 250, y: 150, w: 100, h: 100 });
  });

  it('compiles a center-radius tutor arc with an explicit bbox', () => {
    const [arc] = compile([
      { op: 'add', id: 'a', spec: { kind: 'arc', center: [400, 300], r: 80, startDeg: 0, endDeg: 90 } },
    ]);
    expect((arc.nodes[0] as { d: string }).d).toContain('A ');
    expect(arc.bbox.w).toBeGreaterThan(0);
    expect(arc.bbox.h).toBeGreaterThan(0);
  });

  it('compiles a cubic Bézier curve through its control points', () => {
    const [curve] = compile([
      { op: 'add', id: 'c', spec: { kind: 'curve', points: [[100, 300], [250, 100], [400, 500], [600, 300]] } },
    ]);
    expect((curve.nodes[0] as { d: string }).d).toContain('C ');
    expect(curve.bbox.w).toBeGreaterThan(100);
  });

  it('compiles a curated asset with a label and marks handwritten text', () => {
    const items = compile([
      { op: 'add', id: 'sun', spec: { kind: 'asset', assetId: 'sun', at: [200, 180], size: 72, label: 'Sun' } },
      { op: 'add', id: 'note', spec: { kind: 'text', at: [80, 80], text: 'watch this', style: 'handwritten' } },
    ]);
    expect(items[0].nodes.some((node) => node.type === 'path' && 'transform' in node && node.transform)).toBe(true);
    expect(items[0].nodes.some((node) => node.type === 'text' && node.text === 'Sun')).toBe(true);
    expect(items[1].nodes[0]).toMatchObject({ type: 'text', style: 'handwritten', text: 'watch this' });
  });

  it('compiles a generated illustration as a contained image node with overlay space reserved', () => {
    const [picture] = compile([
      {
        op: 'add',
        id: 'pond',
        spec: {
          kind: 'image',
          assetId: 'img-a1b2c3d4e5f67890',
          at: [80, 60],
          w: 840,
          h: 420,
          alt: 'A pond habitat',
        },
      },
    ]);
    expect(picture.nodes[0]).toMatchObject({
      type: 'image',
      href: '/api/board-assets/img-a1b2c3d4e5f67890',
      x: 80,
      y: 60,
      w: 840,
      h: 420,
      alt: 'A pond habitat',
    });
    expect(picture.bbox).toMatchObject({ x: 80, y: 60, w: 840, h: 420 });
  });

  it('renders equations as KaTeX nodes with estimated bounds', () => {
    const [eq] = compile([
      { op: 'add', id: 'e', spec: { kind: 'equation', at: [100, 100], latex: '\\frac{a}{b}' } },
    ]);
    expect(eq.nodes[0].type).toBe('katex');
    expect(eq.bbox.w).toBeGreaterThan(0);
    expect(eq.bbox.h).toBeGreaterThan(20);
  });
});
