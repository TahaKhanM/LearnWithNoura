import { describe, expect, it } from 'vitest';
import { compileExpression } from './expr';

describe('compileExpression', () => {
  it('evaluates polynomials', () => {
    const f = compileExpression('x^2 - 2*x + 1');
    expect(f).not.toBeNull();
    expect(f!(3)).toBe(4);
  });

  it('supports implicit multiplication', () => {
    expect(compileExpression('2x')!(5)).toBe(10);
    expect(compileExpression('2(x+1)')!(2)).toBe(6);
    expect(compileExpression('x sin(0)')!(7)).toBe(0);
  });

  it('supports functions and constants', () => {
    expect(compileExpression('sin(pi/2)')!(0)).toBeCloseTo(1);
    expect(compileExpression('sqrt(x)')!(9)).toBe(3);
    expect(compileExpression('e^x')!(0)).toBeCloseTo(1);
    expect(compileExpression('abs(-x)')!(4)).toBe(4);
  });

  it('handles precedence and right-associative power', () => {
    expect(compileExpression('2+3*4')!(0)).toBe(14);
    expect(compileExpression('2^3^2')!(0)).toBe(512);
    expect(compileExpression('-x^2')!(3)).toBe(-9);
  });

  it('tolerates y= and f(x)= prefixes', () => {
    expect(compileExpression('y = 2x + 3')!(1)).toBe(5);
    expect(compileExpression('f(x) = x/2')!(8)).toBe(4);
  });

  it('rejects malformed and unsafe input', () => {
    expect(compileExpression('')).toBeNull();
    expect(compileExpression('x +')).toBeNull();
    expect(compileExpression('foo(x)')).toBeNull();
    expect(compileExpression('window.alert(1)')).toBeNull();
    expect(compileExpression('x; 1')).toBeNull();
    expect(compileExpression('x'.repeat(300))).toBeNull();
  });

  it('returns NaN/Infinity rather than throwing on bad domains', () => {
    const f = compileExpression('1/x')!;
    expect(f(0)).toBe(Infinity);
    const g = compileExpression('sqrt(x)')!;
    expect(Number.isNaN(g(-1))).toBe(true);
  });
});
