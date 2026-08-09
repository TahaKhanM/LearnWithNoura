import { describe, expect, it } from 'vitest';
import { normalizeLatexDelimiters } from './latex';

describe('normalizeLatexDelimiters', () => {
  it('converts \\[ \\] display math to $$ $$', () => {
    expect(normalizeLatexDelimiters('\\[a^2+b^2=c^2\\]')).toBe('$$a^2+b^2=c^2$$');
  });

  it('converts \\( \\) inline math to $ $', () => {
    expect(normalizeLatexDelimiters('the value \\(a\\) is a leg')).toBe(
      'the value $a$ is a leg',
    );
  });

  it('handles multiple occurrences', () => {
    expect(normalizeLatexDelimiters('\\(a\\) and \\(b\\)')).toBe('$a$ and $b$');
  });

  it('leaves plain text untouched', () => {
    expect(normalizeLatexDelimiters('no math here')).toBe('no math here');
  });
});
