import { describe, expect, it } from 'vitest';
import { adaptSemanticScene } from '../../shared/semanticScene';
import { countAvoidableConnectorCrossings, inspectScene } from './inspection';
import { applyOps, emptyScene } from './scene';

describe('canonical semantic geometry', () => {
  it('keeps every canonical scene in bounds without text collisions or avoidable connector crossings', () => {
    for (const template of ['pythagorean_area_proof', 'triangle_angle_sum', 'unit_circle_projection', 'fraction_comparison', 'slope_comparison', 'causal_cycle', 'argument_structure', 'cause_effect', 'grammar_structure', 'timeline'] as const) {
      const adapted = adaptSemanticScene({
        schemaVersion: '1.0.0', planId: `plan-${template}`, intent: { objective: template, domain: 'geometry' },
        groups: [{ id: 'group', label: template, revealOrder: ['outline', 'relation', 'label', 'connector', 'emphasis'], template, parameters: {} }],
      });
      const scene = applyOps(emptyScene, adapted.ops, 'tutor').scene;
      expect(inspectScene(scene), template).toMatchObject({ accepted: true, issues: [] });
      expect(countAvoidableConnectorCrossings(scene), template).toBe(0);
    }
  });
});
