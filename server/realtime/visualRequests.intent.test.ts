import { describe, expect, it } from 'vitest';
import { explicitVisualRequestFromText } from './visualRequests';

describe('explicit learner visual request routing', () => {
  it.each([
    'Please draw a number line from zero to ten and mark five.',
    'Could you show me a graph of that relationship?',
    'I would like a diagram beside the first example.',
    'Plot this on the coordinate plane.',
    'Wait — please add a second number line from zero to ten and mark five.',
  ])('accepts a direct structural visual command: %s', (text) => {
    expect(explicitVisualRequestFromText(text, 'turn/key', false)).toMatchObject({
      schemaVersion: '3.0.0',
      purpose: expect.stringContaining('explicit request'),
      idea: text,
      requestId: 'learner-turn-key',
    });
  });

  it('chooses an additive comparison section when work is visible or the learner asks for another view', () => {
    expect(explicitVisualRequestFromText('Draw a number line.', 'blank', false)?.action)
      .toBe('establish');
    expect(explicitVisualRequestFromText('Draw a number line.', 'visible', true)?.action)
      .toBe('compare');
    expect(explicitVisualRequestFromText('Add a second number line.', 'second', false)?.action)
      .toBe('compare');
  });

  it.each([
    'Show me how this works.',
    'I drew a graph yesterday.',
    'Why did you not draw it?',
    'The number line starts at zero.',
  ])('does not hijack ordinary conversation: %s', (text) => {
    expect(explicitVisualRequestFromText(text, 'ordinary', false)).toBeNull();
  });
});
