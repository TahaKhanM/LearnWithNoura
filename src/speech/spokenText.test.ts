import { describe, expect, it } from 'vitest';
import { toSpokenText, estimateSpeakingMs } from './spokenText';

describe('toSpokenText', () => {
  it('strips LaTeX display and inline delimiters', () => {
    expect(toSpokenText('\\[a^2+b^2=c^2\\]')).not.toContain('\\');
    expect(toSpokenText('the leg \\(a\\) is short')).toBe('the leg a is short');
  });

  it('says superscripts as words', () => {
    expect(toSpokenText('a² + b² = c²')).toBe('a squared plus b squared equals c squared');
    expect(toSpokenText('x^3')).toBe('x cubed');
    expect(toSpokenText('x^5')).toBe('x to the power of 5');
  });

  it('reads operators as words only when they stand alone', () => {
    expect(toSpokenText('3 + 4 = 7')).toBe('3 plus 4 equals 7');
    expect(toSpokenText('9 - 4')).toBe('9 minus 4');
    // A hyphen inside a word is not a minus sign.
    expect(toSpokenText('a right-angled triangle')).toBe('a right-angled triangle');
  });

  it('drops markdown emphasis but keeps the words', () => {
    expect(toSpokenText('a **right triangle** here')).toBe('a right triangle here');
    expect(toSpokenText('*only* for right triangles')).toBe('only for right triangles');
    expect(toSpokenText('- first point')).toBe('first point');
    expect(toSpokenText('## Heading')).toBe('Heading');
    expect(toSpokenText('`code`')).toBe('code');
  });

  it('expands fractions and roots', () => {
    expect(toSpokenText('\\frac{1}{2}')).toBe('1 over 2');
    expect(toSpokenText('\\sqrt{25}')).toBe('the square root of 25');
  });

  it('says common symbols', () => {
    expect(toSpokenText('A = πr²')).toContain('pi');
    expect(toSpokenText('5 × 3')).toBe('5 times 3');
  });

  it('collapses whitespace and returns empty for markup only input', () => {
    expect(toSpokenText('  lots   of \n\n space ')).toBe('lots of space');
    expect(toSpokenText('\\[\\]')).toBe('');
  });

  it('handles a realistic tutor message end to end', () => {
    const spoken = toSpokenText(
      'The theorem works **only for right triangles**:\n\n\\[\na^2+b^2=c^2\n\\]\n\n- \\(a\\) and \\(b\\) are the legs.',
    );
    expect(spoken).not.toMatch(/[\\*[\]{}$]/);
    expect(spoken).toContain('only for right triangles');
    expect(spoken).toContain('squared');
  });
});

describe('estimateSpeakingMs', () => {
  it('scales with length and keeps a floor', () => {
    expect(estimateSpeakingMs('Hi')).toBe(700);
    const long = estimateSpeakingMs('word '.repeat(80));
    expect(long).toBeGreaterThan(20_000);
  });
});
