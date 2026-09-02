import { describe, expect, it } from 'vitest';
import type { BoardOp } from '../../shared/boardOps';
import { BoardSceneCoordinator } from './sceneCoordinator';
import { compileScene } from './compile';

describe('BoardSceneCoordinator', () => {
  it('accepts ordinary live figures the voice model actually emits', () => {
    const board = new BoardSceneCoordinator();
    const triangle = board.applyTutorCheckpoint([
      { op: 'add', id: 'tri', spec: { kind: 'polygon', points: [[50, 520], [500, 40], [950, 520]] } },
    ], 'working-board');
    expect(triangle, `large triangle rejected: ${board.lastQualityReport?.reasons.join(', ')}`).not.toBeNull();

    const labeled = new BoardSceneCoordinator();
    const withCaption = labeled.applyTutorCheckpoint([
      { op: 'add', id: 'tri2', spec: { kind: 'polygon', points: [[200, 400], [500, 120], [800, 400]] } },
      { op: 'add', id: 'title', spec: { kind: 'box', at: [880, 60], text: 'Triangle' } },
    ], 'working-board');
    expect(withCaption, `triangle + top-right box rejected: ${labeled.lastQualityReport?.reasons.join(', ')}`).not.toBeNull();
  });

  it('keeps a released tutor checkpoint while learner and later tutor updates interleave', () => {
    const board = new BoardSceneCoordinator();
    const tutor: BoardOp = {
      op: 'add', id: 'tutor-axis', spec: { kind: 'line', from: [100, 250], to: [800, 250] },
    };
    const learner: BoardOp = {
      op: 'add', id: 'sketch-learner', spec: { kind: 'path', points: [[220, 180], [260, 220], [300, 190]] },
    };
    const tutorLabel: BoardOp = {
      op: 'add', id: 'tutor-label', spec: { kind: 'text', at: [120, 180], text: 'Shared scale' },
    };

    expect(board.applyTutorCheckpoint([tutor])).not.toBeNull();
    board.applyLearner([learner]);
    expect(board.applyTutorCheckpoint([tutorLabel])).not.toBeNull();

    expect(board.current.items.map((item) => [item.id, item.owner])).toEqual([
      ['tutor-axis', 'tutor'],
      ['sketch-learner', 'learner'],
      ['tutor-label', 'tutor'],
    ]);
  });

  it('adds a fast annotation to a compiled sub-anchor without mutating its target', () => {
    const board = new BoardSceneCoordinator();
    const target = { op: 'add' as const, id: 'triangle', spec: { kind: 'polygon' as const, points: [[200, 400], [500, 120], [800, 400]] as [number, number][] } };
    expect(board.applyTutorCheckpoint([target], 'geometry')).not.toBeNull();
    const before = board.current.items.find((item) => item.id === 'triangle');
    const applied = board.applyTutorCheckpoint([{
      op: 'add', id: 'apex-circle', color: 'red',
      spec: { kind: 'annotate', style: 'circle', target: { type: 'semantic', objectId: 'triangle', anchor: 'vertex:1' } },
    }], 'geometry');
    expect(applied).not.toBeNull();
    expect(board.current.items.find((item) => item.id === 'triangle')).toEqual(before);
    expect(board.current.items.find((item) => item.id === 'apex-circle')?.owner).toBe('tutor');
  });

  it('fails a nonexistent sub-anchor closed without changing visible state', () => {
    const board = new BoardSceneCoordinator();
    board.applyTutorCheckpoint([{ op: 'add', id: 'triangle', spec: { kind: 'polygon', points: [[200, 400], [500, 120], [800, 400]] } }], 'geometry');
    const before = board.current;
    expect(board.applyTutorCheckpoint([{
      op: 'add', id: 'missing-anchor',
      spec: { kind: 'annotate', style: 'tick', target: { type: 'semantic', objectId: 'triangle', anchor: 'vertex:99' } },
    }], 'geometry')).toBeNull();
    expect(board.current).toBe(before);
  });

  it('annotates a learner-owned stroke while preserving learner ownership and points', () => {
    const board = new BoardSceneCoordinator();
    const points: [number, number][] = [[180, 280], [240, 320], [310, 290]];
    board.applyLearner([{ op: 'add', id: 'learner-stroke', spec: { kind: 'path', points } }], 'working');
    expect(board.applyTutorCheckpoint([{
      op: 'add', id: 'stroke-tick', color: 'green',
      spec: { kind: 'annotate', style: 'tick', target: { type: 'learner_stroke', strokeId: 'learner-stroke', anchor: 'end' } },
    }], 'working')).not.toBeNull();
    expect(board.current.items.find((item) => item.id === 'learner-stroke')).toMatchObject({ owner: 'learner', spec: { points } });
  });

  it('keeps learner marks when the tutor clears its own layer', () => {
    const board = new BoardSceneCoordinator();
    board.applyTutorCheckpoint([{ op: 'add', id: 'tutor-line', spec: { kind: 'line', from: [100, 100], to: [300, 100] } }]);
    board.applyLearner([{ op: 'add', id: 'sketch-kept', spec: { kind: 'path', points: [[120, 140], [180, 160]] } }]);

    expect(board.applyTutorCheckpoint([{ op: 'clear' }])).not.toBeNull();
    expect(board.current.items.map((item) => item.id)).toEqual(['sketch-kept']);
  });

  it('never moves an edge-drawn learner stroke while inspecting a tutor checkpoint', () => {
    const board = new BoardSceneCoordinator();
    const points: [number, number][] = [[0, 0], [12, 8], [24, 4]];
    board.applyLearner([{ op: 'add', id: 'sketch-edge', spec: { kind: 'path', points } }]);

    expect(board.applyTutorCheckpoint([
      { op: 'add', id: 'tutor-center', spec: { kind: 'text', at: [450, 260], text: 'Centre idea' } },
    ])).not.toBeNull();
    expect(board.current.items.find((item) => item.id === 'sketch-edge')?.spec).toEqual({ kind: 'path', points });
  });

  it('inspects overlapping semantic groups independently', () => {
    const board = new BoardSceneCoordinator();
    expect(board.applyTutorCheckpoint([
      { op: 'add', id: 'group-one-box', spec: { kind: 'box', at: [500, 300], text: 'First page' } },
    ], 'group-one')).not.toBeNull();
    expect(board.applyTutorCheckpoint([
      { op: 'add', id: 'group-two-box', spec: { kind: 'box', at: [500, 300], text: 'Second page' } },
    ], 'group-two')).not.toBeNull();
    expect(board.current.items.map((item) => [item.id, item.semanticGroupId])).toEqual([
      ['group-one-box', 'group-one'], ['group-two-box', 'group-two'],
    ]);
  });

  it('replays released historical work even when it exceeds the new live density budget', () => {
    const board = new BoardSceneCoordinator();
    const ops = Array.from({ length: 31 }, (_, index) => ({
      op: 'add' as const, id: `historical-${index}`,
      spec: { kind: 'line' as const, from: [40 + index, 100] as [number, number], to: [40 + index, 300] as [number, number] },
    }));
    expect(board.applyReplay(ops, 'tutor', 'historical')).not.toBeNull();
    expect(board.current.items).toHaveLength(31);
  });

  it('object permanence: later live checkpoints never remove earlier visible tutor work', () => {
    const board = new BoardSceneCoordinator();
    board.applyTutorCheckpoint([{ op: 'add', id: 'anchor-box', spec: { kind: 'box', at: [500, 300], text: 'Anchor idea' } }], 'lesson-anchor');
    board.applyLearner([{ op: 'add', id: 'sketch-kept', spec: { kind: 'path', points: [[120, 140], [180, 160]] } }], 'lesson-anchor');

    // Three later teaching moves: an extension, an emphasis, and an
    // announced comparison section. Every earlier object survives them all.
    expect(board.applyTutorCheckpoint([
      { op: 'add', id: 'anchor-note', spec: { kind: 'label', target: 'anchor-box', side: 'below', text: 'still here' } },
    ], 'lesson-anchor')).not.toBeNull();
    expect(board.applyTutorCheckpoint([{ op: 'highlight', id: 'anchor-box' }], 'lesson-anchor')).not.toBeNull();
    expect(board.applyTutorCheckpoint([
      { op: 'add', id: 'alt-box', spec: { kind: 'box', at: [500, 300], text: 'Comparison case' } },
    ], 'lesson-anchor-alt1')).not.toBeNull();

    const ids = board.current.items.map((item) => item.id);
    expect(ids).toContain('anchor-box');
    expect(ids).toContain('anchor-note');
    expect(ids).toContain('sketch-kept');
    expect(ids).toContain('alt-box');
  });

  it('replays a legacy committed replacement without touching learner marks or other sections', () => {
    // Historical sessions may contain committed replacements. Replay honors
    // that visible truth; the live tool surface can no longer produce it.
    const board = new BoardSceneCoordinator();
    board.applyReplay([{ op: 'add', id: 'model-box', spec: { kind: 'box', at: [500, 300], text: 'Old model' } }], 'tutor', 'working-model');
    board.applyReplay([{ op: 'add', id: 'other-box', spec: { kind: 'box', at: [500, 300], text: 'Other page' } }], 'tutor', 'other-section');
    board.applyLearner([{ op: 'add', id: 'sketch-kept', spec: { kind: 'path', points: [[120, 140], [180, 160]] } }], 'working-model');

    const replayed = board.applyReplay([
      { op: 'add', id: 'new-model-box', spec: { kind: 'box', at: [500, 300], text: 'New model' } },
    ], 'tutor', 'working-model', 'working-model');
    expect(replayed).not.toBeNull();
    const ids = board.current.items.map((item) => item.id);
    expect(ids).not.toContain('model-box');
    expect(ids).toContain('new-model-box');
    expect(ids).toContain('other-box');
    expect(ids).toContain('sketch-kept');
  });

  it('resolves authored placements after structure and before annotation layout', () => {
    const board = new BoardSceneCoordinator();
    const applied = board.applyTutorCheckpoint([
      { op: 'add', id: 'anchor-box', spec: { kind: 'box', at: [400, 300], w: 200, h: 100, text: 'Anchor' } },
      {
        op: 'add', id: 'related-note',
        place: { anchor: 'anchor-box', side: 'right', gap: 30, align: 'center' },
        spec: { kind: 'text', at: [0, 0], text: 'Related note' },
      },
      {
        op: 'add', id: 'note-underline',
        spec: { kind: 'annotate', style: 'underline', target: { type: 'semantic', objectId: 'related-note', anchor: 'center' } },
      },
    ], 'relational');
    expect(applied).not.toBeNull();
    const compiled = new Map(compileScene(board.current.items).map((item) => [item.id, item.bbox]));
    const anchor = compiled.get('anchor-box')!; const note = compiled.get('related-note')!;
    expect(note.x).toBeCloseTo(anchor.x + anchor.w + 30, 5);
    expect(note.y + note.h / 2).toBeCloseTo(anchor.y + anchor.h / 2, 5);
    expect(board.current.items.find((item) => item.id === 'anchor-box')?.spec).toMatchObject({ kind: 'box', at: [400, 300] });
    expect(board.current.items.find((item) => item.id === 'related-note')?.place).toBeUndefined();
  });

  it('rejects unresolved or cyclic relational anchors', () => {
    const board = new BoardSceneCoordinator();
    const missing = board.preflightTutorOps([{
      op: 'add', id: 'orphan', place: { anchor: 'missing', side: 'below', gap: 20, align: 'center' },
      spec: { kind: 'text', at: [0, 0], text: 'Orphan' },
    }], 'relational');
    expect(missing.accepted).toBe(false);
    expect(missing.layoutIssues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'anchor_missing', itemId: 'orphan', withItemId: 'missing' })]));
  });

  it('preflights every M7 curriculum primitive through inspection and quality', () => {
    const fixtures: Array<{ id: string; ops: BoardOp[] }> = [
      { id: 'transform', ops: [{ op: 'add', id: 'source', spec: { kind: 'line', from: [300, 200], to: [450, 200] } }, { op: 'add', id: 'turned', spec: { kind: 'transform', target: 'source', operation: { type: 'rotate', angleDeg: 90 } } }] },
      { id: 'panels', ops: [{ op: 'add', id: 'panels', spec: { kind: 'panelGrid', at: [80, 60], w: 840, h: 440, rows: 2, cols: 3, panels: [{ row: 0, col: 0, label: 'A', marks: [{ shape: 'circle', x: 0.5, y: 0.5 }] }] } }] },
      { id: 'venn', ops: [{ op: 'add', id: 'venn', spec: { kind: 'regionFill', mode: 'venn', at: [200, 120], w: 520, h: 300, operation: 'intersection', labels: ['A', 'B'] } }] },
      { id: 'scatter', ops: [{ op: 'add', id: 'scatter', spec: { kind: 'scatter', at: [100, 100], w: 600, h: 360, xRange: [0, 10], yRange: [0, 20], points: [[1, 2], [5, 11], [9, 17]], xLabel: 'hours', yLabel: 'score' } }] },
      { id: 'boxplot', ops: [{ op: 'add', id: 'boxplot', spec: { kind: 'boxplot', at: [120, 280], w: 700, min: 1, q1: 3, median: 5, q3: 7, max: 10, label: 'Scores' } }] },
      { id: 'histogram', ops: [{ op: 'add', id: 'histogram', spec: { kind: 'histogram', at: [100, 100], w: 600, h: 350, bins: [{ from: 0, to: 5, frequency: 2 }, { from: 5, to: 10, frequency: 6 }] } }] },
      { id: 'solid', ops: [{ op: 'add', id: 'solid', spec: { kind: 'isometricSolid', at: [500, 400], unit: 46, voxels: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]] } }] },
      { id: 'net', ops: [{ op: 'add', id: 'net', spec: { kind: 'cubeNet', at: [300, 100], cell: 70, faces: [{ id: 'a', row: 1, col: 0 }, { id: 'b', row: 1, col: 1 }, { id: 'c', row: 1, col: 2 }, { id: 'd', row: 1, col: 3 }, { id: 'e', row: 0, col: 1 }, { id: 'f', row: 2, col: 1 }] } }] },
      { id: 'plan', ops: [{ op: 'add', id: 'plan', spec: { kind: 'planView', at: [300, 120], cell: 64, heights: [[1, 0, 2], [3, 1, 0], [0, 2, 1]] } }] },
      { id: 'paper', ops: [{ op: 'add', id: 'paper', spec: { kind: 'paperFoldHolePunch', at: [80, 120], w: 840, h: 300, folds: ['right', 'down'], holes: [[0.72, 0.35]] } }] },
      { id: 'grid', ops: [{ op: 'add', id: 'grid', spec: { kind: 'gridPaper', at: [120, 80], w: 700, h: 420, spacing: 30, style: 'grid', majorEvery: 5 } }] },
      { id: 'clock', ops: [{ op: 'add', id: 'clock', spec: { kind: 'clock', center: [500, 300], r: 180, hour: 10, minute: 10 } }] },
      { id: 'protractor', ops: [{ op: 'add', id: 'protractor', spec: { kind: 'protractor', center: [500, 450], r: 260, angleDeg: 65, label: '65°' } }] },
    ];
    for (const fixture of fixtures) {
      const board = new BoardSceneCoordinator();
      const verdict = board.preflightTutorOps(fixture.ops, `m7-${fixture.id}`);
      expect(verdict.accepted, `${fixture.id}: ${verdict.reasons.join(', ')}`).toBe(true);
    }
  });

  it('returns closed collision ids and bounds from a rejected preflight', () => {
    const board = new BoardSceneCoordinator();
    const verdict = board.preflightTutorOps([
      { op: 'add', id: 'a', spec: { kind: 'box', at: [500, 260], w: 240, h: 100, text: 'First' } },
      { op: 'add', id: 'b', spec: { kind: 'box', at: [505, 265], w: 240, h: 100, text: 'Second' } },
      { op: 'add', id: 'c', spec: { kind: 'box', at: [510, 270], w: 240, h: 100, text: 'Third' } },
    ], 'collision-section');

    expect(verdict.accepted).toBe(false);
    expect(verdict.layoutIssues).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'collision',
      itemId: expect.stringMatching(/^[abc]$/),
      withItemId: expect.stringMatching(/^[abc]$/),
      itemBounds: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
      withItemBounds: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    })]));
  });

  it('preflights a complete candidate plan without mutating the visible scene', () => {
    const board = new BoardSceneCoordinator();
    board.applyTutorCheckpoint([{ op: 'add', id: 'base-box', spec: { kind: 'box', at: [500, 300], text: 'Base' } }], 'base');
    const before = board.current;

    const good = board.preflightTutorOps([
      { op: 'add', id: 'plan-box', spec: { kind: 'box', at: [500, 300], text: 'Planned idea' } },
    ], 'plan-section');
    expect(good.accepted).toBe(true);
    expect(board.current).toBe(before);

    // A plan violating the density budget is rejected — before anything is
    // shown or the model is told it was accepted.
    const dense = board.preflightTutorOps(Array.from({ length: 31 }, (_, index) => ({
      op: 'add' as const, id: `dense-${index}`,
      spec: { kind: 'line' as const, from: [40 + index * 4, 100] as [number, number], to: [40 + index * 4, 300] as [number, number] },
    })), 'dense-section');
    expect(dense.accepted).toBe(false);
    expect(dense.reasons.join(' ')).toMatch(/density/);
    expect(board.current).toBe(before);
  });
});
