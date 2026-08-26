import { describe, expect, it } from 'vitest';
import { CompiledLessonSchema } from '../../shared/compiledLesson';
import { compileFixtureLesson, normalizeFixtureGoal } from './fixtureCompiler';

describe('fixture compiler', () => {
  it('selects the maths board-led fixture for triangle goals', () => {
    const lesson = compileFixtureLesson({ lessonKey: 'session-1', goal: 'why do triangle angles add to 180?' });
    expect(lesson.compiledLessonId).toBe('compiled-session-1');
    expect(lesson.blueprint.blueprintId).toBe('blueprint-session-1');
    expect(lesson.blueprint.mode).toBe('board_led');
    expect(lesson.anchorScene?.template).toBe('triangle_angle_sum');
    expect(CompiledLessonSchema.parse(lesson)).toBeTruthy();
  });

  it('selects the non-maths board-led fixture for water-cycle goals', () => {
    const lesson = compileFixtureLesson({ lessonKey: 'session-2', goal: 'How does rain happen?' });
    expect(lesson.blueprint.mode).toBe('board_led');
    expect(lesson.anchorScene?.template).toBe('causal_cycle');
    expect(lesson.anchorScene?.storyboard.length).toBeGreaterThan(1);
  });

  it('selects the fraction number-line fixture for fraction goals', () => {
    const brave = compileFixtureLesson({ lessonKey: 'session-3', goal: 'talking about being brave' });
    expect(brave.blueprint.mode).toBe('conversation_led');
    expect(brave.anchorScene).toBeNull();

    const fractions = compileFixtureLesson({ lessonKey: 'session-4', goal: 'Fractions on a number line' });
    expect(fractions.blueprint.mode).toBe('board_led');
    expect(fractions.anchorScene?.ops.some((op) => op.op === 'add' && op.id === 'lesson-anchor-marker')).toBe(true);
    expect(fractions.blueprint.stages.find((stage) => stage.checks?.[0]?.responseMode === 'manipulate')).toBeTruthy();
    expect(CompiledLessonSchema.parse(fractions)).toBeTruthy();
  });

  it('is deterministic for the same inputs', () => {
    const first = compileFixtureLesson({ lessonKey: 'session-5', goal: 'triangle angles' });
    const second = compileFixtureLesson({ lessonKey: 'session-5', goal: 'triangle angles' });
    expect(second).toEqual(first);
  });

  it('normalizes specific goals to one objective and vague goals to candidates', () => {
    expect(normalizeFixtureGoal('triangle angles')).toEqual({
      kind: 'objective',
      objective: 'Explain why the three angles of any triangle add up to 180 degrees',
    });
    const vague = normalizeFixtureGoal('she needs to get better at school');
    expect(vague.kind).toBe('candidates');
    if (vague.kind === 'candidates') {
      expect(vague.candidates.map((candidate) => candidate.id)).toEqual(['triangle-angle-sum', 'water-cycle']);
    }
  });
});
