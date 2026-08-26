import { describe, expect, it } from 'vitest';
import { applyManipulativeProps, sanitizeLearnerManipulativeProps } from './manipulativeSpecs.js';

describe('applyManipulativeProps hardening', () => {
  const draggable = { kind: 'draggable' as const, at: [200, 300] as [number, number], handle: 'token' as const, size: 44 };

  it('rejects NaN, Infinity, and out-of-board coordinates', () => {
    expect(applyManipulativeProps(draggable, { at: [Number.NaN, 300] })).toEqual(draggable);
    expect(applyManipulativeProps(draggable, { at: [200, Number.POSITIVE_INFINITY] })).toEqual(draggable);
    expect(applyManipulativeProps(draggable, { at: [-50, 300] })).toEqual({ ...draggable, at: [0, 300] });
    expect(applyManipulativeProps(draggable, { at: [2000, 300] })).toEqual({ ...draggable, at: [1000, 300] });
  });

  it('sanitizeLearnerManipulativeProps rejects forged zone fields', () => {
    expect(sanitizeLearnerManipulativeProps({ from: 0, to: 1 })).toBeNull();
  });
});
