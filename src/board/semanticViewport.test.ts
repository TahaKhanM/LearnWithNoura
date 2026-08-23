import { describe, expect, it } from 'vitest';
import { adaptSemanticScene } from '../../shared/semanticScene';
import { compileScene, nodeBBox } from './compile';
import { applyOps, emptyScene } from './scene';
import { contains, deriveSemanticViewport, deriveSemanticViewports } from './semanticViewport';

describe('semantic mobile viewport', () => {
  it('uses explicit section metadata when raw object ids do not share a prefix', () => {
    const scene = applyOps(emptyScene, [
      { op: 'add', id: 'arbitrary-object-id', spec: { kind: 'text', at: [700, 420], text: 'Section-specific note' } },
    ], 'tutor', 'working-section').scene;
    const viewport = deriveSemanticViewport(scene, 'working-section');
    expect(viewport.w).toBeLessThan(1000);
    expect(viewport.itemIds).toContain('arbitrary-object-id');
  });

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

  it.each([
    ['pythagorean_area_proof', 'geometry', {}, 'c^2=a^2+b^2'],
    ['unit_circle_projection', 'geometry', { angleDegrees: 60 }, '(1/2, √3/2)'],
    ['slope_comparison', 'quantitative', { slopes: [1, 2, -1] }, 'y = 1x'],
    ['fraction_comparison', 'quantitative', { values: [2 / 3, 3 / 5], labels: ['2/3', '3/5'] }, '2/3'],
    ['causal_cycle', 'process', { labels: ['Evaporation', 'Condensation', 'Precipitation', 'Collection'] }, 'Evaporation'],
    ['argument_structure', 'argument', {}, 'Claim'],
    ['cause_effect', 'history', { labels: ['New trade route', 'Goods and ideas move', 'Cities grow'] }, 'New trade route'],
    ['grammar_structure', 'grammar', { labels: ['The curious fox', 'followed', 'the bright trail'] }, 'The curious fox'],
  ] as const)('makes every required %s label reachable and puts key content first', (template, domain, parameters, keyText) => {
    const groupId = `group-${template}`;
    const adapted = adaptSemanticScene({
      schemaVersion: '1.0.0', planId: `mobile-${template}`, intent: { objective: template, domain },
      groups: [{ id: groupId, label: template, revealOrder: ['outline', 'relation', 'label', 'connector', 'emphasis'], template, parameters }],
    });
    const scene = applyOps(emptyScene, adapted.ops, 'tutor').scene;
    const views = deriveSemanticViewports(scene, groupId);
    const required = compileScene(scene.items)
      .filter((item) => item.id.startsWith(`${groupId}-`))
      .flatMap((item) => item.nodes.filter((node) => node.type === 'text' || node.type === 'katex').map((node) => ({
        text: node.type === 'text' ? node.text : node.latex,
        box: nodeBBox(node),
      })));
    expect(required.length).toBeGreaterThan(0);
    for (const label of required) expect(views.some((view) => contains(view, label.box)), `unreachable label: ${label.text}`).toBe(true);
    const key = required.find((label) => label.text === keyText);
    expect(key, `missing key label: ${keyText}`).toBeTruthy();
    expect(contains(views[0], key!.box)).toBe(true);
  });
});
