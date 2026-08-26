import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAnimatedCamera } from './camera';

function stubMatchMedia(reduced: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: reduced && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('useAnimatedCamera', () => {
  it('applies a new target on the same render when motion is reduced', () => {
    stubMatchMedia(true);
    const { result, rerender } = renderHook(
      ({ target }) => useAnimatedCamera(target, false),
      { initialProps: { target: { x: 0, y: 0, w: 1000, h: 600 } } },
    );
    const crop = { x: 218, y: 215, w: 350, h: 230 };
    rerender({ target: crop });
    expect(result.current).toEqual(crop);
  });
});
