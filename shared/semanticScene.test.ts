import { describe, expect, it } from 'vitest';
import { adaptSemanticScene, VISUAL_PLAN_VERSION, type SemanticScenePlan } from './semanticScene';
import { validateOps } from './boardOps';

function plan(template: SemanticScenePlan['groups'][number]['template'], parameters: Record<string, unknown> = {}): SemanticScenePlan {
  return { schemaVersion: VISUAL_PLAN_VERSION, planId: `plan-${template}`, intent: { objective: template, domain: template === 'no_board' ? 'none' : 'geometry' }, groups: template === 'no_board' ? [{ id: 'group', label: 'No board', revealOrder: ['outline'], template, parameters }] : [{ id: 'group', label: template, revealOrder: ['outline', 'relation', 'label'], template, parameters }] };
}

describe('semantic visual adapters', () => {
  it('builds an explicit area-equivalence Pythagorean proof', () => {
    const { ops } = adaptSemanticScene(plan('pythagorean_area_proof'));
    expect(ops.filter((op) => op.op === 'add' && op.spec.kind === 'polygon').length).toBeGreaterThanOrEqual(10);
    expect(JSON.stringify(ops)).toContain('same 4 triangles');
  });

  it('keeps fractions on one exact scale and distinguishes slopes by colour', () => {
    const fractions = adaptSemanticScene(plan('fraction_comparison', { values: [2 / 3, 3 / 5], labels: ['2/3', '3/5'] })).ops;
    expect(fractions).toHaveLength(1);
    const numberline = fractions.find((op) => op.op === 'add' && op.spec.kind === 'numberline');
    expect(numberline?.op === 'add' && numberline.spec.kind === 'numberline' ? (numberline.spec.marks ?? []).map((mark) => mark.value) : []).toEqual([2 / 3, 3 / 5]);
    const slopes = adaptSemanticScene(plan('slope_comparison')).ops.filter((op) => op.op === 'add' && op.spec.kind === 'plot');
    expect(new Set(slopes.map((op) => op.op === 'add' ? op.color : undefined)).size).toBe(3);
  });

  it('creates a complete directional causal loop and full argument structure', () => {
    const cycle = adaptSemanticScene(plan('causal_cycle', { labels: ['Evaporation', 'Condensation', 'Precipitation', 'Collection'] })).ops;
    expect(JSON.stringify(cycle)).toContain('edge-loop');
    const argument = adaptSemanticScene(plan('argument_structure')).ops;
    expect(JSON.stringify(argument)).toContain('Claim');
    expect(JSON.stringify(argument)).toContain('Evidence');
    expect(JSON.stringify(argument)).toContain('Reasoning');
  });

  it('supports an explicit NoBoard result', () => {
    expect(adaptSemanticScene(plan('no_board')).ops).toEqual([]);
  });

  it('round-trips normalized adapter operations through persistence validation', () => {
    const ops = adaptSemanticScene(plan('unit_circle_projection')).ops;
    expect(validateOps(ops).rejected).toEqual([]);
    expect(validateOps(ops).ops).toHaveLength(ops.length);
  });
});
