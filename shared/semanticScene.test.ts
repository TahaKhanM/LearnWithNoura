import { describe, expect, it } from 'vitest';
import { adaptSemanticScene, VISUAL_PLAN_VERSION, type SemanticScenePlan } from './semanticScene';
import { validateOps } from './boardOps';

function plan(template: SemanticScenePlan['groups'][number]['template'], parameters: Record<string, unknown> = {}): SemanticScenePlan {
  return { schemaVersion: VISUAL_PLAN_VERSION, planId: `plan-${template}`, intent: { objective: template, domain: template === 'no_board' ? 'none' : 'geometry' }, groups: template === 'no_board' ? [{ id: 'group', label: 'No board', revealOrder: ['outline'], template, parameters }] : [{ id: 'group', label: template, revealOrder: ['outline', 'relation', 'label'], template, parameters }] };
}

describe('semantic visual adapters', () => {
  it('builds an explicit area-equivalence Pythagorean proof', () => {
    const { ops, checkpoints } = adaptSemanticScene(plan('pythagorean_area_proof'));
    expect(ops.filter((op) => op.op === 'add' && op.spec.kind === 'polygon').length).toBeGreaterThanOrEqual(10);
    expect(JSON.stringify(ops)).toContain('same 4 triangles');
    expect(checkpoints.map((checkpoint) => checkpoint.reveal)).toEqual(['outline', 'label']);
    expect(new Set(checkpoints.flatMap((checkpoint) => checkpoint.ops).map((op) => 'id' in op ? op.id : ''))).toEqual(new Set(ops.map((op) => 'id' in op ? op.id : '')));
  });

  it('keeps fractions on one exact scale and distinguishes slopes by colour', () => {
    const fractions = adaptSemanticScene(plan('fraction_comparison', { values: [2 / 3, 3 / 5], labels: ['2/3', '3/5'] })).ops;
    expect(fractions).toHaveLength(1);
    const numberline = fractions.find((op) => op.op === 'add' && op.spec.kind === 'numberline');
    expect(numberline?.op === 'add' && numberline.spec.kind === 'numberline' ? (numberline.spec.marks ?? []).map((mark) => mark.value) : []).toEqual([2 / 3, 3 / 5]);
    const slopes = adaptSemanticScene(plan('slope_comparison')).ops.filter((op) => op.op === 'add' && op.spec.kind === 'plot');
    expect(new Set(slopes.map((op) => op.op === 'add' ? op.color : undefined)).size).toBe(3);
    expect(slopes.map((op) => op.op === 'add' && op.spec.kind === 'plot' ? `${op.spec.label}:${op.spec.expr}` : '')).toEqual(['y = 1x:1*x', 'y = 2x:2*x', 'y = -1x:-1*x']);
  });

  it('keeps unit-circle point coordinates and both projections exact', () => {
    const unit = adaptSemanticScene(plan('unit_circle_projection', { angleDegrees: 60 })).ops;
    expect(JSON.stringify(unit)).toContain('(1/2, √3/2)');
    expect(unit.filter((op) => op.op === 'add' && op.spec.kind === 'line' && op.id.includes('projection'))).toHaveLength(2);
  });

  it('builds a code-owned triangle angle-sum proof with annotation lanes', () => {
    const triangle = adaptSemanticScene(plan('triangle_angle_sum')).ops;
    expect(triangle.filter((op) => op.op === 'add' && op.spec.kind === 'angle')).toHaveLength(3);
    expect(triangle.some((op) => op.op === 'add' && op.spec.kind === 'label' && op.spec.text.includes('180'))).toBe(true);
    expect(triangle.some((op) => op.op === 'add' && op.spec.kind === 'equation' && op.spec.latex.includes('A+B+C'))).toBe(true);
  });

  it('creates a complete directional causal loop and full argument structure', () => {
    const cycle = adaptSemanticScene(plan('causal_cycle', { labels: ['Evaporation', 'Condensation', 'Precipitation', 'Collection'] })).ops;
    expect(JSON.stringify(cycle)).toContain('edge-loop');
    const argument = adaptSemanticScene(plan('argument_structure')).ops;
    expect(JSON.stringify(argument)).toContain('Claim');
    expect(JSON.stringify(argument)).toContain('Evidence');
    expect(JSON.stringify(argument)).toContain('Reasoning');
  });

  it('covers history, grammar, timeline, and NoBoard semantics without decorative substitutes', () => {
    const history = JSON.stringify(adaptSemanticScene(plan('cause_effect', { labels: ['Cause', 'Event', 'Effect'] })).ops);
    const grammar = JSON.stringify(adaptSemanticScene(plan('grammar_structure', { labels: ['Subject', 'Verb', 'Object'] })).ops);
    const historyTimeline = JSON.stringify(adaptSemanticScene(plan('timeline', { labels: ['Earlier', 'Middle', 'Later'] })).ops);
    expect(history).toContain('Cause'); expect(history).toContain('Effect');
    expect(grammar).toContain('Subject'); expect(grammar).toContain('Verb'); expect(grammar).toContain('Object');
    expect(historyTimeline).toContain('Earlier'); expect(historyTimeline).toContain('Later');
    expect(adaptSemanticScene(plan('no_board')).checkpoints).toEqual([]);
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
