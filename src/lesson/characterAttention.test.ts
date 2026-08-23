import { describe, expect, it } from 'vitest';
import { attentionPriority, CharacterAttentionController, type CharacterAttentionTarget } from './characterAttention';

const identity = { sessionId: 's', connectionEpoch: 1, turnId: 't', generationId: 'g' };
function target(targetType: CharacterAttentionTarget['targetType'], priority = attentionPriority(targetType), boardCoordinates: [number, number] = [900, 300]): CharacterAttentionTarget {
  return { ...identity, targetType, priority, boardCoordinates, startTime: 0, expiryTime: 1000, smoothingProfile: 'responsive', permittedInReducedMotion: true };
}

describe('CharacterAttentionController', () => {
  it('prioritizes learner activity over tutor pen and semantic objects', () => {
    const controller = new CharacterAttentionController(identity);
    expect(controller.offer(target('tutor_pen'))).toBe(true);
    expect(controller.offer(target('learner_drawing'))).toBe(true);
    expect(controller.offer(target('semantic_object'))).toBe(false);
    expect(controller.frame(10).targetType).toBe('learner_drawing');
  });

  it('rejects stale generations and clamps gaze inside the face', () => {
    const controller = new CharacterAttentionController(identity);
    expect(controller.offer({ ...target('tutor_pen'), generationId: 'stale' })).toBe(false);
    controller.offer(target('tutor_pen', attentionPriority('tutor_pen'), [10_000, -10_000]));
    for (let index = 0; index < 20; index += 1) controller.frame(index * 16);
    const frame = controller.frame(400);
    expect(Math.abs(frame.x)).toBeLessThanOrEqual(0.78);
    expect(Math.abs(frame.y)).toBeLessThanOrEqual(0.78);
  });

  it('damps rapid pointer movement with hysteresis', () => {
    const controller = new CharacterAttentionController(identity);
    expect(controller.offer(target('learner_pointer', attentionPriority('learner_pointer'), [500, 300]))).toBe(true);
    expect(controller.offer(target('learner_pointer', attentionPriority('learner_pointer'), [506, 306]))).toBe(false);
    expect(controller.offer(target('learner_pointer', attentionPriority('learner_pointer'), [700, 300]))).toBe(true);
    const first = controller.frame(16).x;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(0.4);
  });

  it('drops nonessential targets under reduced motion', () => {
    const controller = new CharacterAttentionController(identity, true);
    expect(controller.offer({ ...target('learner_pointer'), permittedInReducedMotion: false })).toBe(false);
    expect(controller.offer(target('interruption'))).toBe(true);
    expect(controller.frame(1).targetType).toBe('interruption');
  });
});
