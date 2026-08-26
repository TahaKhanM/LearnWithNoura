import { describe, expect, it } from 'vitest';
import type { BoardOp } from '../../shared/boardOps';
import {
  compileDetourStages,
  compileLesson,
  LessonCompileError,
  normalizeGoal,
  type AuthoringChatClient,
  type LessonCompilerDeps,
  type SceneValidationResult,
} from './compiler';

interface RecordedCall { system: string; user: string }

function scriptedClient(replies: (string | null)[]): { client: AuthoringChatClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    client: {
      complete: async ({ messages }) => {
        calls.push({ system: messages[0].content, user: messages[1].content });
        if (calls.length > replies.length) throw new Error('Scripted double exhausted.');
        return replies[calls.length - 1];
      },
    },
  };
}

function deps(client: AuthoringChatClient, verdicts: SceneValidationResult[]): { deps: LessonCompilerDeps; validated: BoardOp[][] } {
  const validated: BoardOp[][] = [];
  return {
    validated,
    deps: {
      client,
      compilerModel: 'scripted-double',
      now: () => 1_000,
      validateScene: async (ops) => {
        validated.push(ops);
        return verdicts[Math.min(validated.length, verdicts.length) - 1];
      },
    },
  };
}

const narrations = {
  outline: 'Here is our triangle with its three corners.',
  relation: 'Each arc marks one corner angle.',
  label: 'The dashed line at the top is a perfectly straight line.',
  connector: 'These arrows connect the angles to the line.',
  emphasis: 'Watch the three angles light up together.',
};

function authoredDraft(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mode: 'board_led',
    successCriteria: ['Learner explains why the three angles fill a straight line'],
    stages: [
      { id: 'orient', kind: 'orient', objective: 'Meet the triangle', boardPurpose: 'establish_anchor', allowedBoardMutation: 'establish', learnerOpportunity: 'Point at the widest corner', evidenceExpected: 'recall', checks: [{ id: 'orient-check', questionOrTask: 'Which corner looks the widest to you?', responseMode: 'voice', targetObjectIds: ['lesson-anchor-angle-a'], misconceptions: [{ anticipatedAnswer: 'The highest corner is always widest', tactic: 'Rotate attention to a wide flat corner and compare directly.' }] }] },
      { id: 'model', kind: 'model', objective: 'See the angles meet the straight line', boardPurpose: 'reveal_relation', allowedBoardMutation: 'extend', learnerOpportunity: 'Predict the total before it is revealed', evidenceExpected: 'reasoning' },
      { id: 'check', kind: 'guided_check', objective: 'Use the sum to find a missing angle', boardPurpose: 'elicit_learner_work', allowedBoardMutation: 'emphasize', learnerOpportunity: 'Work out the missing angle aloud', evidenceExpected: 'application', checks: [{ id: 'missing-angle', questionOrTask: 'If two angles are 60 and 80, what is the third?', responseMode: 'voice' }] },
    ],
    anchor: {
      kind: 'template',
      domain: 'geometry',
      groupLabel: 'Triangle angle sum',
      template: 'triangle_angle_sum',
      parameters: {},
      instructionalQuestion: 'Why do the three angles always make a straight line?',
      narrations,
    },
    ...overrides,
  });
}

describe('normalizeGoal', () => {
  it('returns one objective for a specific goal and candidates for a vague one', async () => {
    const direct = scriptedClient([JSON.stringify({ kind: 'objective', objective: 'Explain why triangle angles sum to 180 degrees' })]);
    const one = await normalizeGoal(deps(direct.client, [{ ok: true }]).deps, { goal: 'triangle angles', learnerAge: 9 });
    expect(one).toEqual({ kind: 'objective', objective: 'Explain why triangle angles sum to 180 degrees' });
    expect(direct.calls[0].user).toContain('triangle angles');

    const vague = scriptedClient([JSON.stringify({
      kind: 'candidates',
      candidates: [
        { id: 'fractions', objective: 'Compare simple fractions', description: 'Which of two fractions is bigger and why.' },
        { id: 'times-tables', objective: 'Master the 7 times table', description: 'Quick recall with patterns.' },
      ],
    })]);
    const many = await normalizeGoal(deps(vague.client, [{ ok: true }]).deps, { goal: 'get better at maths' });
    expect(many.kind).toBe('candidates');
  });

  it('feeds schema rejections back and succeeds on the second attempt', async () => {
    const scripted = scriptedClient([
      'not json at all',
      JSON.stringify({ kind: 'objective', objective: 'Compare unit fractions' }),
    ]);
    const result = await normalizeGoal(deps(scripted.client, [{ ok: true }]).deps, { goal: 'fractions' });
    expect(result).toEqual({ kind: 'objective', objective: 'Compare unit fractions' });
    expect(scripted.calls[1].user).toContain('previous reply was rejected');
  });
});

describe('compileLesson', () => {
  const input = { lessonKey: 'session-1', goal: 'why do triangle angles add to 180?', objective: 'Explain why triangle angles sum to 180 degrees', learnerName: 'Maya', learnerAge: 9 };

  it('compiles a valid board-led lesson on the first attempt', async () => {
    const scripted = scriptedClient([authoredDraft()]);
    const built = deps(scripted.client, [{ ok: true }]);
    const lesson = await compileLesson(built.deps, input);

    expect(lesson.compiledLessonId).toBe('compiled-session-1');
    expect(lesson.blueprint.mode).toBe('board_led');
    expect(lesson.blueprint.anchor?.semanticGroupId).toBe('lesson-anchor');
    expect(lesson.anchorScene?.template).toBe('triangle_angle_sum');
    // The storyboard narrations come from the authored reveal beats and the
    // object ids come from the deterministic template checkpoints.
    const outline = lesson.anchorScene?.storyboard.find((step) => step.reveal === 'outline');
    expect(outline?.narration).toBe(narrations.outline);
    expect(outline?.objectIds).toContain('lesson-anchor-triangle');
    expect(built.validated).toHaveLength(1);
    expect(lesson.compilerModel).toBe('scripted-double');
    expect(lesson.blueprint.stages[0].checks?.[0].questionOrTask).toContain('widest');
  });

  it('feeds scene rejections back and accepts the corrected second attempt', async () => {
    const scripted = scriptedClient([authoredDraft(), authoredDraft()]);
    const built = deps(scripted.client, [
      { ok: false, issues: ['equation overlaps the triangle outline'] },
      { ok: true },
    ]);
    const lesson = await compileLesson(built.deps, input);
    expect(lesson.blueprint.mode).toBe('board_led');
    expect(built.validated).toHaveLength(2);
    expect(scripted.calls[1].user).toContain('equation overlaps the triangle outline');
  });

  it('falls back to a validated conversation-led lesson when scenes keep failing', async () => {
    const scripted = scriptedClient([authoredDraft(), authoredDraft(), authoredDraft()]);
    const built = deps(scripted.client, [{ ok: false, issues: ['persistent overlap'] }]);
    const lesson = await compileLesson(built.deps, input);

    // Three authored attempts plus the default-parameter retry all failed
    // scene validation, so the lesson degrades to conversation-led rather
    // than shipping invalid geometry.
    expect(built.validated).toHaveLength(4);
    expect(lesson.blueprint.mode).toBe('conversation_led');
    expect(lesson.anchorScene).toBeNull();
    expect(lesson.blueprint.anchor).toBeNull();
    expect(lesson.blueprint.stages.every((stage) => stage.boardPurpose === 'none' && stage.allowedBoardMutation === 'none')).toBe(true);
    expect(lesson.blueprint.stages[0].checks?.[0].targetObjectIds).toBeUndefined();
    expect(lesson.blueprint.stages[0].checks?.[0].questionOrTask).toContain('widest');
  });

  it('throws a compile error when authorship never yields a valid draft', async () => {
    const scripted = scriptedClient(['nonsense', '{"mode":"board_led"}', 'null']);
    const built = deps(scripted.client, [{ ok: true }]);
    await expect(compileLesson(built.deps, input)).rejects.toThrow(LessonCompileError);
    expect(built.validated).toHaveLength(0);
  });

  it('rejects compiler-invented image ops and falls back to conversation-led', async () => {
    const imageDraft = authoredDraft({
      anchor: {
        kind: 'raw',
        domain: 'process',
        groupLabel: 'Pond habitat',
        instructionalQuestion: 'What lives in a pond?',
        narrations,
        ops: [{
          op: 'add',
          id: 'pond',
          spec: { kind: 'image', assetId: 'img-a1b2c3d4e5f67890', at: [80, 60], w: 840, h: 400, alt: 'A pond' },
        }],
        storyboard: [{
          id: 'show-pond',
          reveal: 'outline',
          narration: 'Here is a pond.',
          objectIds: ['pond'],
        }],
      },
    });
    const scripted = scriptedClient([imageDraft, imageDraft, imageDraft]);
    const built = deps(scripted.client, [{ ok: true }]);
    const lesson = await compileLesson(built.deps, { ...input, goal: 'ponds', objective: 'Name pond animals' });
    expect(lesson.blueprint.mode).toBe('conversation_led');
    expect(lesson.anchorScene).toBeNull();
    expect(built.validated).toHaveLength(0);
  });

  it('compiles a conversation-led lesson without any scene validation', async () => {
    const scripted = scriptedClient([authoredDraft({
      mode: 'conversation_led',
      anchor: null,
      stages: [
        { id: 'orient', kind: 'orient', objective: 'Recall a rainy day', boardPurpose: 'none', allowedBoardMutation: 'none', learnerOpportunity: 'Describe rain they saw', evidenceExpected: 'recall', checks: [{ id: 'recall', questionOrTask: 'Where do you think rain starts?', responseMode: 'voice' }] },
        { id: 'model', kind: 'model', objective: 'Follow the water upward', boardPurpose: 'none', allowedBoardMutation: 'none', learnerOpportunity: 'Predict what the sun does to puddles', evidenceExpected: 'reasoning' },
        { id: 'check', kind: 'guided_check', objective: 'Narrate one full cycle', boardPurpose: 'none', allowedBoardMutation: 'none', learnerOpportunity: 'Tell a raindrop story', evidenceExpected: 'explanation' },
      ],
    })]);
    const built = deps(scripted.client, [{ ok: true }]);
    const lesson = await compileLesson(built.deps, { ...input, goal: 'the water cycle', objective: 'Explain how water cycles between sky and sea' });
    expect(lesson.blueprint.mode).toBe('conversation_led');
    expect(lesson.anchorScene).toBeNull();
    expect(built.validated).toHaveLength(0);
  });
});

describe('compileDetourStages', () => {
  it('authors a bounded detour and rejects anchor redraws until corrected', async () => {
    const establishStage = { id: 'detour', kind: 'orient', objective: 'What a fraction denominator counts', boardPurpose: 'none', allowedBoardMutation: 'establish', learnerOpportunity: 'Say what the bottom number means', evidenceExpected: 'recall' };
    const goodStage = { ...establishStage, allowedBoardMutation: 'none', checks: [{ id: 'detour-check', questionOrTask: 'What does the bottom number of a fraction count?', responseMode: 'voice' }] };
    const scripted = scriptedClient([
      JSON.stringify({ stages: [establishStage] }),
      JSON.stringify({ stages: [goodStage] }),
    ]);
    const stages = await compileDetourStages(deps(scripted.client, [{ ok: true }]).deps, {
      objective: 'Compare unit fractions',
      reason: 'missing prerequisite: denominator meaning',
      returnStageObjective: 'Place two thirds on the number line',
    });
    expect(stages).toHaveLength(1);
    expect(stages[0].allowedBoardMutation).toBe('none');
    expect(scripted.calls[1].user).toContain('never redraws the anchor');
  });
});
