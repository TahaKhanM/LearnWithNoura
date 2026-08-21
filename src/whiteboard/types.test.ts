import { describe, expect, it } from 'vitest';
import { DrawLine, writeText, drawEllipse, drawPath, clearWhiteboard } from './types';

describe('DrawLine', () => {
  it('builds a drawLine action from coordinates', () => {
    expect(DrawLine(1, 2, 3, 4)).toEqual({
      type: 'drawLine',
      x1: 1,
      y1: 2,
      x2: 3,
      y2: 4,
    });
  });

  it('merges optional styling', () => {
    expect(DrawLine(0, 0, 10, 10, { color: 'red', strokeWidth: 5 })).toEqual({
      type: 'drawLine',
      x1: 0,
      y1: 0,
      x2: 10,
      y2: 10,
      color: 'red',
      strokeWidth: 5,
    });
  });
});

describe('writeText', () => {
  it('builds a writeText action', () => {
    expect(writeText('hello', 5, 6)).toEqual({
      type: 'writeText',
      str: 'hello',
      x: 5,
      y: 6,
    });
  });
});

describe('drawEllipse', () => {
  it('builds a drawEllipse action from center and radii', () => {
    expect(drawEllipse(100, 200, 50, 30)).toEqual({
      type: 'drawEllipse',
      x: 100,
      y: 200,
      rx: 50,
      ry: 30,
    });
  });

  it('merges optional styling', () => {
    expect(drawEllipse(0, 0, 10, 20, { color: 'blue', strokeWidth: 2 })).toEqual({
      type: 'drawEllipse',
      x: 0,
      y: 0,
      rx: 10,
      ry: 20,
      color: 'blue',
      strokeWidth: 2,
    });
  });
});

describe('clearWhiteboard', () => {
  it('builds a clear step', () => {
    expect(clearWhiteboard()).toEqual({ type: 'clear' });
  });
});

describe('drawPath', () => {
  it('builds one freehand object from sampled points', () => {
    expect(
      drawPath(
        [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
        { color: 'blue', strokeWidth: 4 },
      ),
    ).toEqual({
      type: 'drawPath',
      points: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
      color: 'blue',
      strokeWidth: 4,
    });
  });
});
