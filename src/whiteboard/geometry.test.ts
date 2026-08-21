import { describe, expect, it } from 'vitest';
import { cursorPathForAction, pointsToPath } from './geometry';
import { DrawLine, drawEllipse, drawPath, writeText } from './types';

describe('pointsToPath', () => {
  it('turns sampled pointer positions into a smooth path', () => {
    expect(
      pointsToPath([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 0 },
      ]),
    ).toBe('M 0 0 Q 10 10 15 5 L 20 0');
  });
});

describe('cursorPathForAction', () => {
  it('follows a line from its start to its tail', () => {
    expect(cursorPathForAction(DrawLine(1, 2, 3, 4))).toBe('M 1 2 L 3 4');
  });

  it('travels all the way around an ellipse', () => {
    expect(cursorPathForAction(drawEllipse(100, 100, 50, 20))).toContain(
      'A 50 20 0 1 1 50 100',
    );
  });

  it('sweeps over text and freehand paths', () => {
    expect(cursorPathForAction(writeText('abc', 10, 20, { fontSize: 30 }))).toBe(
      'M 10 20 L 56.8 20',
    );
    expect(
      cursorPathForAction(
        drawPath([
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ]),
      ),
    ).toBe('M 1 2 L 3 4');
  });
});
