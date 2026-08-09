import { describe, expect, it } from 'vitest';
import { toolCallToStep } from './tools';

describe('toolCallToStep', () => {
  it('maps draw_line to a drawLine step', () => {
    expect(toolCallToStep('draw_line', { x1: 1, y1: 2, x2: 3, y2: 4 })).toEqual({
      type: 'drawLine',
      x1: 1,
      y1: 2,
      x2: 3,
      y2: 4,
    });
  });

  it('maps write_text to a writeText step', () => {
    expect(toolCallToStep('write_text', { str: 'hi', x: 5, y: 6 })).toEqual({
      type: 'writeText',
      str: 'hi',
      x: 5,
      y: 6,
    });
  });

  it('maps draw_ellipse to a drawEllipse step', () => {
    expect(toolCallToStep('draw_ellipse', { x: 1, y: 2, rx: 3, ry: 4 })).toEqual({
      type: 'drawEllipse',
      x: 1,
      y: 2,
      rx: 3,
      ry: 4,
    });
  });

  it('maps clear_whiteboard to a clear step', () => {
    expect(toolCallToStep('clear_whiteboard', {})).toEqual({ type: 'clear' });
  });

  it('passes through optional styling', () => {
    expect(toolCallToStep('draw_line', { x1: 0, y1: 0, x2: 1, y2: 1, color: 'red', strokeWidth: 2 })).toEqual({
      type: 'drawLine',
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      color: 'red',
      strokeWidth: 2,
    });
  });

  it('returns null for missing required arguments', () => {
    expect(toolCallToStep('draw_line', { x1: 0, y1: 0 })).toBeNull();
    expect(toolCallToStep('write_text', { x: 0, y: 0 })).toBeNull();
    expect(toolCallToStep('draw_ellipse', { x: 0, y: 0 })).toBeNull();
  });

  it('returns null for an unknown tool name', () => {
    expect(toolCallToStep('draw_circle', { x: 0, y: 0, r: 1 })).toBeNull();
  });
});
