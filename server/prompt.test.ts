import { describe, expect, it } from 'vitest';
import { BOARD_WIDTH, BOARD_HEIGHT } from '../src/whiteboard/types';
import { fillPlaceholders, loadSystemPrompt } from './prompt';

describe('fillPlaceholders', () => {
  it('substitutes a known placeholder', () => {
    expect(fillPlaceholders('board is {{W}} wide', { W: '1000' })).toBe('board is 1000 wide');
  });

  it('leaves an unknown placeholder alone rather than emptying it', () => {
    expect(fillPlaceholders('{{NOPE}}', { W: '1' })).toBe('{{NOPE}}');
  });

  it('substitutes every occurrence', () => {
    expect(fillPlaceholders('{{A}} and {{A}}', { A: 'x' })).toBe('x and x');
  });
});

describe('loadSystemPrompt', () => {
  it('reads the Markdown prompt from disk', () => {
    expect(loadSystemPrompt()).toContain('You are Seneca');
  });

  it('fills in the real board size, so the prompt cannot drift from the board', () => {
    const prompt = loadSystemPrompt();
    expect(prompt).toContain(`${BOARD_WIDTH} wide and ${BOARD_HEIGHT} tall`);
  });

  it('leaves no placeholder unfilled', () => {
    expect(loadSystemPrompt()).not.toMatch(/\{\{\w+\}\}/);
  });

  // The whole point of the rewrite: the tutor teaches rather than
  // describing its own drawing as it goes.
  it('tells the tutor not to narrate its own drawing', () => {
    const prompt = loadSystemPrompt();
    expect(prompt).toContain('Do not narrate your own drawing');
  });
});
