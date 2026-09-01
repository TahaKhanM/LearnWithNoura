import { describe, expect, it } from 'vitest';
import { BoardContextTracker } from './boardContext.js';
import { streamedStepDuplicateReasons } from './streamingVisualPolicy.js';

describe('streamed visual novelty policy', () => {
  it('rejects exact visible redraws even when the stream invents fresh ids', () => {
    const board = new BoardContextTracker();
    board.apply([
      { op: 'add', id: 'visible-box', spec: { kind: 'box', at: [300, 220], text: 'same idea' } },
      { op: 'add', id: 'visible-line', spec: { kind: 'line', from: [100, 100], to: [400, 100] } },
    ], 'tutor');

    expect(streamedStepDuplicateReasons(board, [
      { op: 'add', id: 'fresh-box-id', spec: { kind: 'box', at: [300, 220], text: 'same idea' } },
      { op: 'add', id: 'fresh-line-id', spec: { kind: 'line', from: [100, 100], to: [400, 100] } },
    ])).toEqual([
      'streamed object fresh-box-id duplicates visible tutor object visible-box',
      'streamed object fresh-line-id duplicates visible tutor object visible-line',
    ]);
  });

  it('allows genuinely novel streamed objects', () => {
    const board = new BoardContextTracker();
    board.apply([
      { op: 'add', id: 'visible-box', spec: { kind: 'box', at: [300, 220], text: 'old idea' } },
    ], 'tutor');
    expect(streamedStepDuplicateReasons(board, [
      { op: 'add', id: 'new-box', spec: { kind: 'box', at: [600, 220], text: 'new idea' } },
    ])).toEqual([]);
  });
});
