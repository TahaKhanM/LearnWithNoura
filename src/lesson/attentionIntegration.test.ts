import { describe, expect, it } from 'vitest';
import { applyOps, emptyScene } from '../board/scene';
import { centerForItemIds, centerForSemanticObject } from './attentionIntegration';
import { attentionPriority, CharacterAttentionController } from './characterAttention';

const identity = { sessionId: 's', connectionEpoch: 1, turnId: 't', generationId: 'g' };

describe('runtime character attention integration', () => {
  it('maps semantic objects and highlights to real board coordinates', () => {
    const scene = applyOps(emptyScene, [
      { op: 'add', id: 'fraction-scale-line', spec: { kind: 'line', from: [100, 200], to: [700, 200] } },
      { op: 'add', id: 'fraction-scale-label', spec: { kind: 'text', at: [400, 260], text: 'fractions', size: 'big' } },
    ], 'tutor').scene;
    const semantic = centerForSemanticObject(scene, 'fraction-scale');
    const highlighted = centerForItemIds(scene, ['fraction-scale-label']);
    expect(semantic?.[0]).toBeGreaterThan(300);
    expect(highlighted).toBeDefined();
  });

  it('maps raw ids through explicit semantic section metadata', () => {
    const scene = applyOps(emptyScene, [
      { op: 'add', id: 'raw-id-without-prefix', spec: { kind: 'point', at: [820, 160], label: 'P' } },
    ], 'tutor', 'geometry-section').scene;
    expect(centerForSemanticObject(scene, 'geometry-section')).toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number)]));
    expect(centerForSemanticObject(scene, 'geometry-section')?.[0]).toBeGreaterThan(750);
  });

  it('adopts interruption immediately and highlight/revision on the next frame under 200ms', () => {
    const controller = new CharacterAttentionController(identity);
    expect(controller.offer({ ...identity, targetType: 'interruption', priority: attentionPriority('interruption'), startTime: 0, expiryTime: 900, smoothingProfile: 'immediate', permittedInReducedMotion: true })).toBe(true);
    expect(controller.frame(16).targetType).toBe('interruption');
    expect(controller.offer({ ...identity, targetType: 'focused_object', boardCoordinates: [700, 200], priority: attentionPriority('focused_object'), startTime: 901, expiryTime: 1_500, smoothingProfile: 'responsive', permittedInReducedMotion: true })).toBe(true);
    expect(controller.frame(917).targetType).toBe('focused_object');
    expect(917 - 901).toBeLessThanOrEqual(200);
  });

  it('keeps semantic state in reduced motion while removing smoothing', () => {
    const controller = new CharacterAttentionController(identity, true);
    expect(controller.offer({ ...identity, targetType: 'semantic_object', semanticObjectId: 'fraction-scale', boardCoordinates: [750, 300], priority: attentionPriority('semantic_object'), startTime: 0, expiryTime: 500, smoothingProfile: 'responsive', permittedInReducedMotion: true })).toBe(true);
    const frame = controller.frame(16);
    expect(frame).toMatchObject({ targetType: 'semantic_object', semanticObjectId: 'fraction-scale' });
    // Reduced motion removes interpolation; it does not change the docked
    // avatar origin used to project board coordinates.
    expect(frame.x).toBeCloseTo(-0.26, 5);
    expect(frame.y).toBe(-0.78);
  });
});
