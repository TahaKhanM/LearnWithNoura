import { describe, expect, it } from 'vitest';
import { adaptSemanticScene } from '../../shared/semanticScene';
import { countAvoidableConnectorCrossings, inspectScene } from './inspection';
import { applyOps, emptyScene } from './scene';

describe('canonical semantic geometry', () => {
  it('keeps every canonical scene in bounds without text collisions or avoidable connector crossings', () => {
    for (const template of ['pythagorean_area_proof', 'triangle_angle_sum', 'unit_circle_projection', 'fraction_comparison', 'slope_comparison', 'causal_cycle', 'argument_structure', 'cause_effect', 'grammar_structure', 'relationship_map', 'worked_steps', 'comparison', 'part_whole', 'timeline'] as const) {
      const adapted = adaptSemanticScene({
        schemaVersion: '1.0.0', planId: `plan-${template}`, intent: { objective: template, domain: 'geometry' },
        groups: [{ id: 'group', label: template, revealOrder: ['outline', 'relation', 'label', 'connector', 'emphasis'], template, parameters: {} }],
      });
      const scene = applyOps(emptyScene, adapted.ops, 'tutor').scene;
      expect(inspectScene(scene), template).toMatchObject({ accepted: true, issues: [] });
      expect(countAvoidableConnectorCrossings(scene), template).toBe(0);
    }
  });

  it('lays out a branching relationship map without node collisions or avoidable crossings', () => {
    const adapted = adaptSemanticScene({
      schemaVersion: '2.0.0', planId: 'branching-map',
      intent: { objective: 'Explain a branching cause', domain: 'process', relevance: 'essential', questionAnswered: 'How do the causes connect?', rationale: 'The branching relationship is spatial.', action: 'create', density: 'standard' },
      groups: [{
        id: 'branch', label: 'Branching causes', revealOrder: ['outline', 'connector', 'label'], template: 'relationship_map',
        parameters: {
          layout: 'hierarchy',
          nodes: [{ id: 'root', label: 'Root cause' }, { id: 'left', label: 'Path A' }, { id: 'right', label: 'Path B' }, { id: 'result', label: 'Combined result' }],
          edges: [{ from: 'root', to: 'left' }, { from: 'root', to: 'right' }, { from: 'left', to: 'result' }, { from: 'right', to: 'result' }],
        },
      }],
    });
    const scene = applyOps(emptyScene, adapted.ops, 'tutor', 'branch').scene;
    expect(inspectScene(scene)).toMatchObject({ accepted: true, issues: [] });
    expect(countAvoidableConnectorCrossings(scene)).toBe(0);
  });
});
