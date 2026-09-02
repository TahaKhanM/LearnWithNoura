import { describe, expect, it } from 'vitest';
import { loadDirectorEvalCorpus } from './eval/corpus.js';
import { extractIntentTemplateScene } from './templateLane.js';
import routingFixtures from './eval/fixtures/m3-template-routing-fixtures.json' with { type: 'json' };

describe('deterministic template lane', () => {
  it('extracts an exact number-line scene through the semantic adapter', () => {
    const scene = extractIntentTemplateScene({
      idea: 'Show a number line from zero to ten and mark five.',
      constraints: 'The marked point must be five.',
      sectionId: 'lesson-anchor-alt1',
    });

    expect(scene).toMatchObject({
      groupId: 'lesson-anchor-alt1',
      groupLabel: 'Number line 0 to 10',
      template: 'number_line',
      ops: [{
        op: 'add',
        id: 'lesson-anchor-alt1-scale',
        spec: {
          kind: 'numberline', min: 0, max: 10, step: 1,
          marks: [{ value: 5, label: '5', color: '#E14B3C' }],
        },
      }],
    });
    expect(scene?.storyboard).toEqual([expect.objectContaining({
      reveal: 'outline',
      objectIds: ['lesson-anchor-alt1-scale'],
      narration: 'This number line runs from 0 to 10, with 5 marked.',
    })]);
  });

  it('makes at least eight exact semantic templates reachable without a model round', () => {
    const fixtures = [
      ['Compare 7/12 and 5/8 on one exact fraction strip.', 'fraction_comparison'],
      ['Show the 30 degree unit-circle point and its x and y projections.', 'unit_circle_projection'],
      ['Compare lines with slopes 1, 2, and -1.', 'slope_comparison'],
      ['Show the Pythagorean theorem as an area proof.', 'pythagorean_area_proof'],
      ['Show why the interior angles in a triangle sum to 180 degrees.', 'triangle_angle_sum'],
      ['Draw a repeating cycle with stages: evaporation; condensation; precipitation; collection.', 'causal_cycle'],
      ['Make a timeline with events: Magna Carta; Civil War; Glorious Revolution.', 'timeline'],
      ["Show the main and subordinate clauses in 'Although it rained, we played outside.'", 'grammar_structure'],
    ] as const;
    const scenes = fixtures.map(([idea, template], index) => {
      const scene = extractIntentTemplateScene({ idea, constraints: null, sectionId: `template-${index}` });
      expect(scene?.template).toBe(template);
      expect(scene?.ops.length).toBeGreaterThan(0);
      expect(scene?.storyboard.length).toBeGreaterThan(0);
      return scene!;
    });

    expect(scenes[0].ops.filter((op) => op.op === 'add' && op.spec.kind === 'polygon')).toHaveLength(20);
    expect(scenes[0].ops.filter((op) => op.op === 'add' && op.spec.kind === 'polygon' && op.spec.fill)).toHaveLength(12);
    expect(scenes[1].ops).toEqual(expect.arrayContaining([
      expect.objectContaining({ spec: expect.objectContaining({ kind: 'angle', label: '30°' }) }),
    ]));
    expect(scenes[2].ops.filter((op) => op.op === 'add' && op.spec.kind === 'plot')).toHaveLength(3);
    expect(scenes[5].ops.filter((op) => op.op === 'add' && op.spec.kind === 'box')).toHaveLength(4);
    expect(scenes[6].ops.filter((op) => op.op === 'add' && op.spec.kind === 'point')).toHaveLength(3);
    expect(scenes[7].ops.filter((op) => op.op === 'add' && op.spec.kind === 'box')).toHaveLength(2);
  });

  it('computes and marks an exact plotted-line intersection in code', () => {
    const scene = extractIntentTemplateScene({
      idea: 'Plot y = x + 2 and y = -x + 6 and mark their intersection.',
      constraints: null,
      sectionId: 'graph-intersection',
    });
    expect(scene?.template).toBe('slope_comparison');
    expect(scene?.ops).toEqual(expect.arrayContaining([
      expect.objectContaining({ spec: expect.objectContaining({ kind: 'point', label: '(2, 4)' }) }),
    ]));
  });

  it('captures exactly the preregistered M0 corpus rows and no others', () => {
    const captured = Object.fromEntries(loadDirectorEvalCorpus().flatMap((intent) => {
      const scene = extractIntentTemplateScene({
        idea: intent.intent,
        constraints: null,
        sectionId: `corpus-${intent.id}`,
      });
      return scene ? [[intent.id, scene.template]] : [];
    }));
    expect(captured).toEqual(routingFixtures.corpusExpectedCaptures);
  });

  it('never captures the sealed unfamiliar and abstract holdout lane', () => {
    const openSet = loadDirectorEvalCorpus().filter((intent) => intent.category === 'unfamiliar_abstract');
    expect(openSet).toHaveLength(4);
    for (const intent of openSet) {
      expect(extractIntentTemplateScene({
        idea: intent.intent,
        constraints: null,
        sectionId: `open-${intent.id}`,
      }), intent.id).toBeNull();
    }
  });

  it('falls through instead of guessing ambiguous template parameters', () => {
    expect(extractIntentTemplateScene({
      idea: 'Draw a number line for this problem.',
      constraints: null,
      sectionId: 'lesson-anchor-alt1',
    })).toBeNull();
    expect(extractIntentTemplateScene({
      idea: 'Draw a straight line from zero to ten.',
      constraints: null,
      sectionId: 'lesson-anchor-alt1',
    })).toBeNull();
    for (const idea of [
      'Show a useful point on the unit circle.',
      'Compare the slopes of these lines.',
      'Draw the process as a cycle.',
      'Make a timeline of the important events.',
      'Show the clauses in this sentence.',
    ]) {
      expect(extractIntentTemplateScene({ idea, constraints: null, sectionId: 'ambiguous' })).toBeNull();
    }
  });
});
