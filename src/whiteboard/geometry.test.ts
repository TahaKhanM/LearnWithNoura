import { describe, expect, it } from 'vitest';
import { pointsToPath } from './geometry';

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
