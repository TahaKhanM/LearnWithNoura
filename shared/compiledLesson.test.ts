import { describe, expect, it } from 'vitest';
import type { BoardOp } from './boardOps';
import {
  AnchorSceneSchema,
  CompiledLessonSchema,
  NormalizedGoalSchema,
  COMPILED_LESSON_SCHEMA_VERSION,
} from './compiledLesson';
import type { LessonBlueprint } from './pedagogy';

const anchorOps: BoardOp[] = [
  { op: 'add', id: 'lesson-anchor-triangle', spec: { kind: 'polygon', points: [[230, 430], [500, 135], [770, 430]], closed: true } },
  { op: 'add', id: 'lesson-anchor-angle-a', color: 'blue', spec: { kind: 'angle', vertex: [230, 430], from: [770, 430], to: [500, 135], label: 'A' } },
  { op: 'add', id: 'lesson-anchor-sum', color: 'green', spec: { kind: 'equation', at: [390, 480], latex: 'A+B+C=180^\\circ' } },
];

const storyboard = [
  { id: 'step-outline', reveal: 'outline' as const, narration: 'Here is one triangle. Its three corners are what we care about.', objectIds: ['lesson-anchor-triangle'] },
  { id: 'step-relation', reveal: 'relation' as const, narration: 'This arc marks the first corner angle.', objectIds: ['lesson-anchor-angle-a'] },
  { id: 'step-label', reveal: 'label' as const, narration: 'Together the three angles always make a straight line.', objectIds: ['lesson-anchor-sum'] },
];

const blueprint: LessonBlueprint = {
  blueprintId: 'blueprint-compiled-1',
  goal: 'Understand why triangle angles sum to 180 degrees',
  mode: 'board_led',
  successCriteria: ['Learner explains the straight-line argument'],
  anchor: { semanticGroupId: 'lesson-anchor', template: 'triangle_angle_sum', instructionalQuestion: 'Why do the three angles make a straight line?', invariantObjectIds: [] },
  stages: [
    { id: 'orient', kind: 'orient', objective: 'See the triangle and its angles', boardPurpose: 'establish_anchor', allowedBoardMutation: 'establish', learnerOpportunity: 'Name the three angles', evidenceExpected: 'recall', checks: [{ id: 'orient-check', questionOrTask: 'Which corner looks biggest?', responseMode: 'voice', misconceptions: [{ anticipatedAnswer: 'They are all the same', tactic: 'Compare a wide and a narrow corner directly.' }] }] },
    { id: 'model', kind: 'model', objective: 'Relate the angles to the straight line', boardPurpose: 'reveal_relation', allowedBoardMutation: 'extend', learnerOpportunity: 'Predict the total', evidenceExpected: 'reasoning' },
    { id: 'check', kind: 'guided_check', objective: 'Confirm the sum', boardPurpose: 'elicit_learner_work', allowedBoardMutation: 'emphasize', learnerOpportunity: 'Compute the missing angle', evidenceExpected: 'application' },
  ],
  currentStageIndex: 0,
  detourStack: [],
};

function compiled(overrides: Record<string, unknown> = {}) {
  return {
    compiledLessonId: 'compiled-1',
    schemaVersion: COMPILED_LESSON_SCHEMA_VERSION,
    goal: 'why do triangles add up to 180?',
    objective: 'Understand why triangle angles sum to 180 degrees',
    blueprint,
    anchorScene: { groupId: 'lesson-anchor', groupLabel: 'Triangle angle sum', template: 'triangle_angle_sum', ops: anchorOps, storyboard },
    compiledAt: 1,
    compilerModel: 'scripted-double',
    ...overrides,
  };
}

describe('compiled lesson schema', () => {
  it('accepts a board-led lesson whose storyboard covers every anchor object exactly once', () => {
    const parsed = CompiledLessonSchema.parse(compiled());
    expect(parsed.anchorScene?.storyboard).toHaveLength(3);
    expect(parsed.blueprint.stages[0].checks?.[0].misconceptions?.[0].tactic).toContain('Compare');
  });

  it('rejects a board-led lesson without an anchor scene', () => {
    expect(() => CompiledLessonSchema.parse(compiled({ anchorScene: null }))).toThrow(/anchor scene/i);
  });

  it('rejects a conversation-led lesson that forces visuals', () => {
    const conversational: LessonBlueprint = {
      ...blueprint,
      mode: 'conversation_led',
      anchor: null,
      stages: blueprint.stages.map((stage) => ({ ...stage, boardPurpose: 'none' as const, allowedBoardMutation: 'none' as const })),
    };
    expect(() => CompiledLessonSchema.parse(compiled({ blueprint: conversational }))).toThrow(/no forced visuals/i);
    const parsed = CompiledLessonSchema.parse(compiled({ blueprint: conversational, anchorScene: null }));
    expect(parsed.anchorScene).toBeNull();
  });

  it('rejects an anchor scene whose group differs from the blueprint anchor', () => {
    expect(() => CompiledLessonSchema.parse(compiled({
      anchorScene: { groupId: 'other-group', groupLabel: 'Triangle', template: 'triangle_angle_sum', ops: anchorOps, storyboard },
    }))).toThrow(/blueprint anchor/i);
  });

  it('rejects storyboards that skip or double-reveal anchor objects', () => {
    expect(() => AnchorSceneSchema.parse({
      groupId: 'lesson-anchor', groupLabel: 'Triangle', template: 'triangle_angle_sum', ops: anchorOps,
      storyboard: storyboard.slice(0, 2),
    })).toThrow(/not revealed/i);
    expect(() => AnchorSceneSchema.parse({
      groupId: 'lesson-anchor', groupLabel: 'Triangle', template: 'triangle_angle_sum', ops: anchorOps,
      storyboard: [...storyboard, { id: 'step-again', reveal: 'emphasis', narration: 'Look again.', objectIds: ['lesson-anchor-triangle'] }],
    })).toThrow(/more than one/i);
  });

  it('rejects invalid or destructive anchor ops', () => {
    expect(() => AnchorSceneSchema.parse({
      groupId: 'lesson-anchor', groupLabel: 'Triangle', template: null,
      ops: [{ op: 'clear' }],
      storyboard: [storyboard[0]],
    })).toThrow(/add operations|board validation/i);
    expect(() => AnchorSceneSchema.parse({
      groupId: 'lesson-anchor', groupLabel: 'Triangle', template: null,
      ops: [{ op: 'add', id: 'bad', spec: { kind: 'not-a-shape' } }],
      storyboard: [{ id: 'step', reveal: 'outline', narration: 'A shape.', objectIds: ['bad'] }],
    })).toThrow(/board validation/i);
  });
});

describe('normalized goal schema', () => {
  it('accepts one objective or two-to-three candidates, nothing else', () => {
    expect(NormalizedGoalSchema.parse({ kind: 'objective', objective: 'Compare unit fractions on a number line' }).kind).toBe('objective');
    const candidates = NormalizedGoalSchema.parse({
      kind: 'candidates',
      candidates: [
        { id: 'a', objective: 'Compare unit fractions', description: 'Which of two fractions is larger.' },
        { id: 'b', objective: 'Place fractions on a number line', description: 'Locating fractions between whole numbers.' },
      ],
    });
    expect(candidates.kind).toBe('candidates');
    expect(() => NormalizedGoalSchema.parse({ kind: 'candidates', candidates: [{ id: 'a', objective: 'Only one', description: 'too few' }] })).toThrow();
  });
});
