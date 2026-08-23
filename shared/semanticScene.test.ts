import { describe, expect, it } from 'vitest';
import { adaptSemanticScene, VISUAL_PLAN_VERSION, type SemanticScenePlan } from './semanticScene';
import { validateOps } from './boardOps';
import { applyOps, emptyScene } from '../src/board/scene';

function plan(template: SemanticScenePlan['groups'][number]['template'], parameters: Record<string, unknown> = {}): SemanticScenePlan {
  const noBoard = template === 'no_board';
  return {
    schemaVersion: VISUAL_PLAN_VERSION,
    planId: `plan-${template}`,
    intent: {
      objective: template,
      domain: noBoard ? 'none' : 'geometry',
      relevance: noBoard ? 'none' : 'essential',
      questionAnswered: noBoard ? 'No visual question.' : `What does ${template} show?`,
      rationale: noBoard ? 'Speech is clearer.' : 'The spatial relationship is essential.',
      action: noBoard ? 'skip' : 'create',
      density: 'minimal',
      ...(noBoard ? { noBoardReason: 'No diagram improves this move.' } : {}),
    },
    groups: noBoard ? [{ id: 'group', label: 'No board', revealOrder: ['outline'], template, parameters }] : [{ id: 'group', label: template, revealOrder: ['outline', 'relation', 'label'], template, parameters }],
  };
}

describe('semantic visual adapters', () => {
  it('builds an explicit area-equivalence Pythagorean proof', () => {
    const { ops, checkpoints } = adaptSemanticScene(plan('pythagorean_area_proof'));
    expect(ops.filter((op) => op.op === 'add' && op.spec.kind === 'polygon').length).toBeGreaterThanOrEqual(10);
    expect(JSON.stringify(ops)).toContain('same 4 triangles');
    // Reveal order is dependency-owned by code: connectors can never appear
    // before the objects they join, regardless of what the model requested.
    expect(checkpoints.map((checkpoint) => checkpoint.reveal)).toEqual(['outline', 'label', 'connector']);
    expect(new Set(checkpoints.flatMap((checkpoint) => checkpoint.ops).map((op) => 'id' in op ? op.id : ''))).toEqual(new Set(ops.map((op) => 'id' in op ? op.id : '')));
  });

  it('normalizes duplicate or dependency-inverted reveal requests without duplicating ops', () => {
    const requested = plan('triangle_angle_sum');
    requested.groups[0].revealOrder = ['label', 'label', 'outline', 'outline', 'relation'];
    const { ops, checkpoints } = adaptSemanticScene(requested);
    const reveals = checkpoints.map((checkpoint) => checkpoint.reveal);
    // Canonical dependency order, deduplicated: outlines first, then
    // relations, then labels — never the model's inverted request.
    expect(reveals).toEqual([...new Set(reveals)]);
    expect(reveals.indexOf('outline')).toBeLessThan(reveals.indexOf('label'));
    expect(reveals.indexOf('outline')).toBeLessThan(reveals.indexOf('relation'));
    const revealedIds = checkpoints.flatMap((checkpoint) => checkpoint.ops).map((op) => 'id' in op ? op.id : 'clear');
    expect(revealedIds).toHaveLength(new Set(revealedIds).size);
    expect(revealedIds).toHaveLength(ops.length);
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

  it('provides general code-owned grammars for relationships, steps, comparisons, and part-whole models', () => {
    const relationship = adaptSemanticScene(plan('relationship_map', {
      layout: 'hierarchy',
      nodes: [{ id: 'claim', label: 'Claim' }, { id: 'evidence', label: 'Evidence' }, { id: 'reason', label: 'Reasoning' }],
      edges: [{ from: 'claim', to: 'evidence', label: 'supported by' }, { from: 'evidence', to: 'reason' }],
    })).ops;
    expect(relationship.filter((op) => op.op === 'add' && op.spec.kind === 'box')).toHaveLength(3);
    expect(relationship.filter((op) => op.op === 'add' && op.spec.kind === 'connector')).toHaveLength(2);
    expect(adaptSemanticScene(plan('worked_steps', { steps: ['Collect like terms', 'Divide both sides', 'Check'] })).ops.some((op) => op.op === 'add' && op.spec.kind === 'box')).toBe(true);
    expect(adaptSemanticScene(plan('comparison', { leftTitle: 'Solid', rightTitle: 'Liquid' })).ops[0]).toMatchObject({ op: 'add', spec: { kind: 'table' } });
    const partWhole = adaptSemanticScene(plan('part_whole', { labels: ['Known', 'Unknown'], values: [3, 2] })).ops;
    expect(partWhole.filter((op) => op.op === 'add' && op.spec.kind === 'box')).toHaveLength(2);
    expect(partWhole.some((op) => op.op === 'add' && op.spec.kind === 'equation' && op.spec.latex === '3+2=5')).toBe(true);
  });

  it('enforces explicit relevance and reuse decisions in v2 plans', () => {
    expect(() => adaptSemanticScene({
      ...plan('fraction_comparison'),
      intent: { ...plan('fraction_comparison').intent, relevance: 'none' },
    })).toThrow(/non-relevant visual/i);
    const reuse = adaptSemanticScene({
      schemaVersion: VISUAL_PLAN_VERSION,
      planId: 'reuse-plan',
      intent: {
        objective: 'Reuse the fraction line', domain: 'quantitative', relevance: 'essential',
        questionAnswered: 'Where is three quarters?', rationale: 'The existing scale already answers it.',
        action: 'reuse', targetGroupId: 'fraction-scale', density: 'minimal',
      },
      groups: [],
    });
    expect(reuse.ops).toEqual([]);
  });

  it('replaces one board section as a single atomic checkpoint without a standalone clear', () => {
    let scene = applyOps(emptyScene, [{ op: 'add', id: 'old-model', spec: { kind: 'box', at: [500, 300], text: 'Old model' } }], 'tutor', 'working-model').scene;
    scene = applyOps(scene, [{ op: 'add', id: 'sketch-kept', spec: { kind: 'path', points: [[10, 10], [20, 20], [30, 15]] } }], 'learner', 'working-model').scene;
    const replacement = adaptSemanticScene({
      schemaVersion: VISUAL_PLAN_VERSION, planId: 'replace-model',
      intent: { objective: 'Replace the model', domain: 'process', relevance: 'essential', questionAnswered: 'What is the corrected order?', rationale: 'The old sequence is misleading.', action: 'replace', targetGroupId: 'working-model', density: 'minimal' },
      groups: [{ id: 'working-model', label: 'Corrected model', revealOrder: ['outline', 'connector'], template: 'worked_steps', parameters: { steps: ['First', 'Second'] } }],
    });
    // No model-visible clear op, and the whole replacement is one checkpoint
    // so the swap commits atomically — never a blank board between clears.
    expect(replacement.ops.some((op) => op.op === 'clear')).toBe(false);
    expect(replacement.checkpoints).toHaveLength(1);
    expect(replacement.checkpoints[0].replacesGroup).toBe('working-model');
    scene = applyOps(scene, [{ op: 'clear' }, ...replacement.checkpoints[0].ops], 'tutor', 'working-model').scene;
    expect(scene.items.some((item) => item.id === 'old-model')).toBe(false);
    expect(scene.items.some((item) => item.id === 'sketch-kept')).toBe(true);
    expect(scene.items.some((item) => item.id === 'working-model-step-0')).toBe(true);
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
