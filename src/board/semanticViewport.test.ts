import { describe, expect, it } from 'vitest';
import { adaptSemanticScene } from '../../shared/semanticScene';
import { applyOps, emptyScene } from './scene';
import { deriveSemanticViewport, deriveSemanticViewports } from './semanticViewport';

describe('semantic mobile viewport', () => {
  it('derives readable bounded focus and accessible pan positions from semantic object bounds', () => {
    const adapted = adaptSemanticScene({
      schemaVersion: '1.0.0', planId: 'mobile-proof', intent: { objective: 'Pythagorean proof', domain: 'geometry' },
      groups: [{ id: 'proof', label: 'Area proof', revealOrder: ['outline', 'relation', 'label', 'connector'], template: 'pythagorean_area_proof', parameters: {} }],
    });
    const scene = applyOps(emptyScene, adapted.ops, 'tutor').scene;
    const views = deriveSemanticViewports(scene, 'proof');
    const previous = deriveSemanticViewport(scene, 'proof', 0);
    const middle = deriveSemanticViewport(scene, 'proof', Math.floor(views.length / 2));
    const next = deriveSemanticViewport(scene, 'proof', views.length - 1);
    for (const viewport of [previous, middle, next]) {
      expect(viewport.w).toBeLessThanOrEqual(350);
      expect(viewport.h).toBeLessThanOrEqual(300);
      expect(viewport.x).toBeGreaterThanOrEqual(0);
      expect(viewport.x + viewport.w).toBeLessThanOrEqual(1000);
      expect(viewport.y).toBeGreaterThanOrEqual(0);
      expect(viewport.y + viewport.h).toBeLessThanOrEqual(600);
      expect(viewport.itemIds.length).toBeGreaterThan(10);
      expect(viewport.viewCount).toBe(views.length);
    }
    expect(new Set(views.map((viewport) => `${viewport.x}:${viewport.y}`)).size).toBeGreaterThan(2);
  });

  it('preserves a meaningful global overview and NoBoard state', () => {
    expect(deriveSemanticViewport(emptyScene, undefined)).toMatchObject({ x: 0, y: 0, w: 1000, h: 600, itemIds: [] });
    expect(deriveSemanticViewport(emptyScene, 'missing')).toMatchObject({ x: 0, y: 0, w: 1000, h: 600, itemIds: [] });
  });
});
