import { describe, expect, it } from 'vitest';
import {
  IncrementalDirectorStreamParser,
  parseDirectorTextStream,
} from './directorStreamParser.js';
import { parseStrictEvalAddOp } from './directorVNextBoardOpSchema.js';

describe('production Director stream parser', () => {
  it('emits a complete policy-ready first step before the proposal finishes', () => {
    const proposal = scene([step('s1', 'a'), step('s2', 'b')]);
    const text = JSON.stringify(proposal);
    const secondStep = text.indexOf(JSON.stringify(proposal.steps[1]));
    const parser = new IncrementalDirectorStreamParser({ density: 'minimal', visibleObjectIds: [] });
    const first = parser.push(text.slice(0, secondStep + 20));

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      index: 0,
      header: { template: null, groupLabel: 'Streamed scene' },
      step: { id: 's1' },
      ops: [{ op: 'add', id: 'a' }],
    });
    expect(parser.push(text.slice(secondStep + 20))).toHaveLength(1);
    expect(parser.finish()).toMatchObject({
      groupLabel: 'Streamed scene',
      storyboard: [{ id: 's1' }, { id: 's2' }],
    });
  });

  it('accepts the exact authored annotation schema in a streamed step', () => {
    const proposal = scene([{
      id: 'annotate-step', reveal: 'emphasis', narration: 'Mark the vertex.',
      ops: [{
        op: 'add', id: 'vertex-mark', color: 'red',
        spec: {
          kind: 'annotate', style: 'circle', note: null,
          target: { type: 'semantic', objectId: 'triangle', anchor: 'vertex:1' },
        },
      }],
    }]);
    const parser = new IncrementalDirectorStreamParser({ density: 'minimal', visibleObjectIds: ['triangle'] });
    expect(parser.push(JSON.stringify(proposal))[0]).toMatchObject({
      ops: [{ spec: { kind: 'annotate', style: 'circle', target: { objectId: 'triangle', anchor: 'vertex:1' } } }],
    });
    expect(parser.finish()).toMatchObject({ ops: [{ spec: { kind: 'annotate' } }] });
  });

  it('strictly parses every authored curriculum primitive', () => {
    const specs = [
      { kind: 'transform', target: 'shape', operation: { type: 'rotate', angleDeg: 90, center: null }, label: null },
      { kind: 'panelGrid', at: [80, 60], w: 840, h: 440, rows: 2, cols: 3, panels: [{ row: 0, col: 0, label: null, marks: [{ shape: 'circle', x: 0.5, y: 0.5, size: null, rotationDeg: null, fill: null }] }] },
      { kind: 'regionFill', mode: 'venn', at: [200, 120], w: 520, h: 300, operation: 'intersection', labels: ['A', 'B'] },
      { kind: 'scatter', at: [100, 80], w: 500, h: 360, xRange: [0, 10], yRange: [0, 20], points: [[1, 2]], xLabel: null, yLabel: null },
      { kind: 'boxplot', at: [100, 260], w: 700, min: 1, q1: 3, median: 5, q3: 7, max: 10, label: null },
      { kind: 'histogram', at: [100, 80], w: 600, h: 380, bins: [{ from: 0, to: 5, frequency: 2 }], xLabel: null, yLabel: null },
      { kind: 'isometricSolid', at: [500, 360], unit: 46, voxels: [[0, 0, 0]] },
      { kind: 'cubeNet', at: [300, 100], cell: 70, faces: [{ id: 'a', row: 1, col: 0, label: null }, { id: 'b', row: 1, col: 1, label: null }, { id: 'c', row: 1, col: 2, label: null }, { id: 'd', row: 1, col: 3, label: null }, { id: 'e', row: 0, col: 1, label: null }, { id: 'f', row: 2, col: 1, label: null }] },
      { kind: 'planView', at: [200, 100], cell: 64, heights: [[1, 0], [2, 1]] },
      { kind: 'paperFoldHolePunch', at: [80, 100], w: 840, h: 320, folds: ['right'], holes: [[0.72, 0.35]] },
      { kind: 'gridPaper', at: [100, 80], w: 700, h: 420, spacing: 30, style: 'grid', majorEvery: null },
      { kind: 'clock', center: [500, 300], r: 180, hour: 10, minute: 10, second: null },
      { kind: 'protractor', center: [500, 430], r: 260, angleDeg: 65, label: null },
    ];
    specs.forEach((spec, index) => expect(parseStrictEvalAddOp({
      op: 'add', id: `curriculum-${index}`, color: null, spec,
    }).spec.kind).toBe(spec.kind));
    expect(parseStrictEvalAddOp({
      op: 'add', id: 'placed', color: null,
      place: { anchor: 'curriculum-0', side: 'below', gap: 20, align: 'center' },
      spec: { kind: 'text', at: [0, 0], text: 'Placed', size: null, align: null, style: null },
    })).toMatchObject({ place: { anchor: 'curriculum-0', side: 'below', gap: 20, align: 'center' } });
  });

  it('retains relational placement against an already-visible anchor through finish', () => {
    const proposal = scene([{
      id: 'placed-step', reveal: 'label', narration: 'Relate the note.',
      ops: [{
        op: 'add', id: 'placed-note', color: null,
        place: { anchor: 'visible-anchor', side: 'right', gap: 20, align: 'center' },
        spec: { kind: 'text', at: [0, 0], text: 'Related', size: null, align: null, style: null },
      }],
    }]);
    const parser = new IncrementalDirectorStreamParser({ density: 'minimal', visibleObjectIds: ['visible-anchor'] });
    expect(parser.push(JSON.stringify(proposal))[0].ops[0]).toMatchObject({ place: { anchor: 'visible-anchor' } });
    expect(parser.finish().ops[0]).toMatchObject({ place: { anchor: 'visible-anchor' } });
  });

  it('rejects cross-step id collisions before emitting the later step', () => {
    const text = JSON.stringify(scene([step('s1', 'same'), step('s2', 'same')]));
    const parser = new IncrementalDirectorStreamParser({ density: 'minimal', visibleObjectIds: [] });
    expect(() => parser.push(text)).toThrow(/collide/i);
    expect(parser.snapshot()).toMatchObject({ emittedSteps: 1 });
  });

  it('aborts before exposing a step after the visual request epoch changes', async () => {
    const controller = new AbortController();
    controller.abort('new visual request');
    const stream = parseDirectorTextStream({
      chunks: chunks(JSON.stringify(scene([step('s1', 'a')]))),
      density: 'minimal',
      visibleObjectIds: [],
      signal: controller.signal,
    });
    await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' });
  });
});

function scene(steps: unknown[]) {
  return {
    template: null,
    groupLabel: 'Streamed scene',
    representation: 'diagram',
    illustration: null,
    steps,
  };
}

function step(id: string, objectId: string) {
  return {
    id,
    reveal: 'outline',
    narration: `Explain ${id}.`,
    ops: [{
      op: 'add', id: objectId, color: 'blue',
      spec: { kind: 'box', at: [500, 300], w: 240, h: 100, text: id },
    }],
  };
}

async function* chunks(value: string): AsyncGenerator<string> {
  yield value;
}
