import { describe, expect, it } from 'vitest';
import { compileScene, nodeBBox, type CompiledItem } from './compile';
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

  it('keeps opposite connector labels clear in the inspected M2 live-smoke scene', () => {
    const items = compile([
      { op: 'add', id: 'a1', color: 'blue', spec: { kind: 'asset', assetId: 'raindrop', at: [220, 280], size: 70, label: 'Liquid water' } },
      { op: 'add', id: 'a2', color: 'violet', spec: { kind: 'asset', assetId: 'cloud', at: [450, 280], size: 80, label: 'Water vapor (gas)' } },
      { op: 'add', id: 'a3', color: 'red', spec: { kind: 'connector', from: [270, 250], to: [395, 250], label: 'Evaporation (heating)' } },
      { op: 'add', id: 'a4', color: 'blue', spec: { kind: 'connector', from: [395, 330], to: [270, 330], label: 'Condensation (cooling)' } },
    ]);
    const labels = items.slice(2).map((item) => nodeBBox(item.nodes.find((node) => node.type === 'text')!));
    const overlaps = (a: typeof items[number]['bbox'], b: typeof items[number]['bbox']) =>
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

    expect(overlaps(labels[0], labels[1])).toBe(false);
    for (const label of labels) {
      expect(overlaps(label, items[0].bbox)).toBe(false);
      expect(overlaps(label, items[1].bbox)).toBe(false);
    }
  });

  it('stacks close number-line mark labels instead of merging fractions', () => {
    const [numberline] = compile([{
      op: 'add', id: 'fractions', spec: {
        kind: 'numberline', at: [130, 300], w: 740, min: 0, max: 1, step: 0.1,
        marks: [
          { value: 7 / 12, label: '7/12', color: 'blue' },
          { value: 5 / 8, label: '5/8', color: 'red' },
        ],
      },
    }]);
    const labels = numberline.nodes.filter((node) => node.type === 'text' && ['7/12', '5/8'].includes(node.text));
    expect(labels).toHaveLength(2);
    const [a, b] = labels.map(nodeBBox);
    const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    expect(overlap).toBe(false);
  });

  it('exports generic and spec-specific anchors from compiled objects', () => {
    const items = compile([
      { op: 'add', id: 'line', spec: { kind: 'line', from: [100, 100], to: [300, 100] } },
      { op: 'add', id: 'shape', spec: { kind: 'polygon', points: [[100, 200], [200, 140], [300, 200]] } },
      { op: 'add', id: 'scale', spec: { kind: 'numberline', at: [100, 300], w: 400, min: 0, max: 10, step: 1 } },
      { op: 'add', id: 'table', spec: { kind: 'table', at: [550, 120], rows: [['A', 'B'], ['1', '2']], headerRow: true } },
      { op: 'add', id: 'bars', spec: { kind: 'bars', at: [550, 330], w: 320, h: 180, items: [{ label: 'A', value: 2 }, { label: 'B', value: 4 }] } },
    ]);
    expect(items[0].anchors.start.point).toEqual([100, 100]);
    expect(items[0].anchors.end.point).toEqual([300, 100]);
    expect(items[1].anchors['vertex:1'].point).toEqual([200, 140]);
    expect(items[2].anchors['tick:5'].point).toEqual([300, 300]);
    expect(items[3].anchors['cell:1:1'].bounds.w).toBeGreaterThan(0);
    expect(items[4].anchors['bar-top:1'].point[1]).toBeLessThan(510);
    for (const item of items) expect(item.anchors.center).toBeDefined();
  });

  it('compiles every annotation style from target anchors without changing the target', () => {
    const styles = ['circle', 'underline', 'arrow', 'tick', 'cross', 'bracket', 'callout', 'highlighter'] as const;
    const items = compile([
      { op: 'add', id: 'target', spec: { kind: 'box', at: [500, 300], w: 220, h: 100, text: 'Target' } },
      ...styles.map((style, index): BoardOp => ({
        op: 'add', id: `annotation-${index}`, color: index % 2 ? 'red' : 'blue',
        spec: { kind: 'annotate', style, target: { type: 'semantic', objectId: 'target', anchor: 'center' }, ...(style === 'callout' ? { note: 'Look here' } : {}) },
      })),
    ]);
    expect(items[0].bbox).toMatchObject({ x: 390, y: 250, w: 220, h: 100 });
    for (const item of items.slice(1)) {
      expect(item.nodes.length).toBeGreaterThan(0);
      expect([item.bbox.x, item.bbox.y, item.bbox.w, item.bbox.h].every(Number.isFinite)).toBe(true);
    }
    expect(items.find((item) => item.id === 'annotation-6')?.nodes.some((node) => node.type === 'text' && node.text === 'Look here')).toBe(true);
  });

  it('resolves learner strokes and normalized image regions as annotation anchors', () => {
    let scene = applyOps(emptyScene, [{ op: 'add', id: 'learner-path', spec: { kind: 'path', points: [[100, 100], [180, 160], [260, 120]] } }], 'learner').scene;
    scene = applyOps(scene, [
      { op: 'add', id: 'image', spec: { kind: 'image', assetId: 'img-a1b2c3d4', at: [400, 100], w: 400, h: 300, alt: 'Synthetic worksheet' } },
      { op: 'add', id: 'stroke-mark', spec: { kind: 'annotate', style: 'tick', target: { type: 'learner_stroke', strokeId: 'learner-path', anchor: 'end' } } },
      { op: 'add', id: 'region-mark', spec: { kind: 'annotate', style: 'circle', target: { type: 'image_region', imageId: 'image', selector: { type: 'FragmentSelector', unit: 'percent', x: 0.25, y: 0.2, w: 0.5, h: 0.4 } } } },
    ], 'tutor').scene;
    const items = compileScene(scene.items);
    expect(items.find((item) => item.id === 'stroke-mark')?.bbox.x).toBeGreaterThan(200);
    expect(items.find((item) => item.id === 'region-mark')?.bbox).toMatchObject({ x: 490, y: 150, w: 220, h: 140 });
  });

  it('computes transformed geometry from the referenced object rather than final model coordinates', () => {
    const items = compile([
      { op: 'add', id: 'source-line', spec: { kind: 'line', from: [100, 100], to: [200, 100] } },
      { op: 'add', id: 'rotated-line', spec: { kind: 'transform', target: 'source-line', operation: { type: 'rotate', angleDeg: 90, center: [100, 100] } } },
    ]);
    expect(items[1].nodes[0]).toMatchObject({ type: 'path', d: 'M 100.0 100.0 L 100.0 200.0' });
    expect(items[1].bbox).toMatchObject({ x: 100, y: 100, w: 0, h: 100 });
  });

  it('computes reflect, translate, and enlarge transforms from operation parameters', () => {
    const items = compile([
      { op: 'add', id: 'source-point', spec: { kind: 'point', at: [200, 200] } },
      { op: 'add', id: 'reflected', spec: { kind: 'transform', target: 'source-point', operation: { type: 'reflect', axis: { from: [300, 0], to: [300, 600] } } } },
      { op: 'add', id: 'translated', spec: { kind: 'transform', target: 'source-point', operation: { type: 'translate', vector: [50, -20] } } },
      { op: 'add', id: 'enlarged', spec: { kind: 'transform', target: 'source-point', operation: { type: 'enlarge', scale: 2, center: [100, 100] } } },
    ]);
    expect(items[1].nodes[0]).toMatchObject({ bbox: { x: 395.5, y: 195.5 } });
    expect(items[2].nodes[0]).toMatchObject({ bbox: { x: 245.5, y: 175.5 } });
    expect(items[3].nodes[0]).toMatchObject({ bbox: { x: 295.5, y: 295.5 } });
  });

  it('compiles every M7 curriculum primitive into finite code-owned geometry', () => {
    const cases: Array<{ id: string; dependencies?: BoardOp[]; spec: Extract<BoardOp, { op: 'add' }>['spec'] }> = [
      { id: 'panels', spec: { kind: 'panelGrid', at: [80, 60], w: 840, h: 440, rows: 2, cols: 3, panels: [{ row: 0, col: 0, label: 'A', marks: [{ shape: 'circle', x: 0.5, y: 0.5 }] }] } },
      { id: 'venn', spec: { kind: 'regionFill', mode: 'venn', at: [200, 120], w: 520, h: 300, operation: 'intersection', labels: ['A', 'B'] } },
      { id: 'fraction-region', spec: { kind: 'regionFill', mode: 'fraction', at: [120, 200], w: 640, h: 100, numerator: 3, denominator: 5 } },
      { id: 'half-plane', dependencies: [{ op: 'add', id: 'hp-axes', spec: { kind: 'axes', at: [160, 80], w: 600, h: 400, xRange: [-5, 5], yRange: [-5, 5] } }], spec: { kind: 'regionFill', mode: 'half_plane', axes: 'hp-axes', slope: 1, intercept: 0, side: 'above', inclusive: true } },
      { id: 'scatter', spec: { kind: 'scatter', at: [100, 80], w: 600, h: 380, xRange: [0, 10], yRange: [0, 20], points: [[1, 2], [5, 11], [9, 17]], xLabel: 'hours', yLabel: 'score' } },
      { id: 'boxplot', spec: { kind: 'boxplot', at: [100, 260], w: 700, min: 1, q1: 3, median: 5, q3: 7, max: 10, label: 'Scores' } },
      { id: 'histogram', spec: { kind: 'histogram', at: [100, 80], w: 600, h: 380, bins: [{ from: 0, to: 5, frequency: 2 }, { from: 5, to: 10, frequency: 6 }], xLabel: 'Time', yLabel: 'Frequency' } },
      { id: 'solid', spec: { kind: 'isometricSolid', at: [500, 360], unit: 46, voxels: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]] } },
      { id: 'net', spec: { kind: 'cubeNet', at: [300, 100], cell: 70, faces: [{ id: 'a', row: 1, col: 0 }, { id: 'b', row: 1, col: 1 }, { id: 'c', row: 1, col: 2 }, { id: 'd', row: 1, col: 3 }, { id: 'e', row: 0, col: 1 }, { id: 'f', row: 2, col: 1 }] } },
      { id: 'plan', spec: { kind: 'planView', at: [200, 100], cell: 64, heights: [[1, 0, 2], [3, 1, 0], [0, 2, 1]] } },
      { id: 'paper', spec: { kind: 'paperFoldHolePunch', at: [80, 100], w: 840, h: 320, folds: ['right', 'down'], holes: [[0.72, 0.35], [0.82, 0.65]] } },
      { id: 'grid', spec: { kind: 'gridPaper', at: [100, 80], w: 700, h: 420, spacing: 30, style: 'grid', majorEvery: 5 } },
      { id: 'clock', spec: { kind: 'clock', center: [500, 300], r: 180, hour: 10, minute: 10 } },
      { id: 'protractor', spec: { kind: 'protractor', center: [500, 430], r: 260, angleDeg: 65, label: '65°' } },
    ];
    for (const fixture of cases) {
      const items = compile([...(fixture.dependencies ?? []), { op: 'add', id: fixture.id, spec: fixture.spec }]);
      const item = items.at(-1)!;
      expect(item.nodes.length, `${fixture.id} has no geometry`).toBeGreaterThan(0);
      expect([item.bbox.x, item.bbox.y, item.bbox.w, item.bbox.h].every(Number.isFinite), `${fixture.id} has invalid bounds`).toBe(true);
      expect(item.bbox.w + item.bbox.h, `${fixture.id} has empty bounds`).toBeGreaterThan(0);
    }
  });

  it('maps quantitative primitive parameters to exact rendered positions', () => {
    const items = compile([
      { op: 'add', id: 'scatter', spec: { kind: 'scatter', at: [100, 100], w: 400, h: 300, xRange: [0, 10], yRange: [0, 10], points: [[5, 5]] } },
      { op: 'add', id: 'clock', spec: { kind: 'clock', center: [750, 260], r: 120, hour: 3, minute: 0 } },
    ]);
    expect(items[0].anchors['point:0'].point).toEqual([300, 250]);
    expect(items[1].anchors['hand:minute'].point).toEqual([750, 164]);
    expect(items[1].anchors['hand:hour'].point[0]).toBeGreaterThan(810);
  });

  it('covers union, polygon-fill, and dot-paper primitive variants', () => {
    const items = compile([
      { op: 'add', id: 'union', spec: { kind: 'regionFill', mode: 'venn', at: [100, 100], w: 400, h: 240, operation: 'union', labels: ['A', 'B'] } },
      { op: 'add', id: 'polygon-fill', spec: { kind: 'regionFill', mode: 'polygon', points: [[550, 100], [800, 100], [700, 300]] } },
      { op: 'add', id: 'dots', spec: { kind: 'gridPaper', at: [100, 350], w: 300, h: 180, spacing: 30, style: 'dot' } },
    ]);
    expect(items[0].nodes.filter((node) => node.type === 'path' && Boolean(node.fill)).length).toBeGreaterThanOrEqual(2);
    expect(items[1].nodes[0]).toMatchObject({ type: 'path', fill: expect.stringContaining('rgba') });
    expect(items[2].nodes.filter((node) => node.type === 'path')).toHaveLength(78);
  });

  it('computes unfolded hole positions from fold directions', () => {
    const [paper] = compile([{
      op: 'add', id: 'paper',
      spec: { kind: 'paperFoldHolePunch', at: [80, 100], w: 840, h: 320, folds: ['right', 'down'], holes: [[0.72, 0.35]] },
    }]);
    const holeCircles = paper.nodes.filter((node) => node.type === 'path' && / A /.test(node.d));
    expect(holeCircles).toHaveLength(5);
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
