import { describe, expect, it } from 'vitest';
import { generateLesson } from './mockAgent';
import { BOARD_WIDTH, BOARD_HEIGHT } from '../whiteboard/types';

describe('generateLesson', () => {
  it('matches the pythagorean theorem lesson by keyword', () => {
    const steps = generateLesson('Can you explain the Pythagorean theorem?');
    expect(steps.some((s) => s.type === 'chat' && /pythagorean/i.test(s.text))).toBe(true);
    expect(steps.some((s) => s.type === 'drawLine')).toBe(true);
  });

  it('matches the slope lesson by keyword', () => {
    const steps = generateLesson('what is slope');
    expect(steps.some((s) => s.type === 'writeText' && /slope/i.test(s.str))).toBe(true);
  });

  it('matches the circle area lesson by keyword', () => {
    const steps = generateLesson('area of a circle please');
    expect(steps.some((s) => s.type === 'drawEllipse')).toBe(true);
  });

  it('falls back to a chat-only response for unmatched topics', () => {
    const steps = generateLesson('tell me about quantum entanglement');
    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('chat');
  });

  it('ignores case when matching keywords', () => {
    const steps = generateLesson('SLOPE');
    expect(steps.length).toBeGreaterThan(1);
  });

  it('keeps all generated coordinates within the board bounds', () => {
    const allSteps = [
      ...generateLesson('pythagorean'),
      ...generateLesson('slope'),
      ...generateLesson('circle'),
    ];

    for (const step of allSteps) {
      if (step.type === 'drawLine') {
        expect(step.x1).toBeGreaterThanOrEqual(0);
        expect(step.x1).toBeLessThanOrEqual(BOARD_WIDTH);
        expect(step.x2).toBeGreaterThanOrEqual(0);
        expect(step.x2).toBeLessThanOrEqual(BOARD_WIDTH);
        expect(step.y1).toBeGreaterThanOrEqual(0);
        expect(step.y1).toBeLessThanOrEqual(BOARD_HEIGHT);
        expect(step.y2).toBeGreaterThanOrEqual(0);
        expect(step.y2).toBeLessThanOrEqual(BOARD_HEIGHT);
      }
      if (step.type === 'writeText') {
        expect(step.x).toBeGreaterThanOrEqual(0);
        expect(step.x).toBeLessThanOrEqual(BOARD_WIDTH);
        expect(step.y).toBeGreaterThanOrEqual(0);
        expect(step.y).toBeLessThanOrEqual(BOARD_HEIGHT);
      }
      if (step.type === 'drawEllipse') {
        expect(step.x - step.rx).toBeGreaterThanOrEqual(0);
        expect(step.x + step.rx).toBeLessThanOrEqual(BOARD_WIDTH);
        expect(step.y - step.ry).toBeGreaterThanOrEqual(0);
        expect(step.y + step.ry).toBeLessThanOrEqual(BOARD_HEIGHT);
      }
    }
  });
});
