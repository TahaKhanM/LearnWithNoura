import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompiledLessonSchema, COMPILED_LESSON_SCHEMA_VERSION, type CompiledLesson } from '../shared/compiledLesson';
import type { LessonStage } from '../shared/pedagogy';
import { adaptSemanticScene, VISUAL_PLAN_VERSION } from '../shared/semanticScene';

/**
 * Regenerates the deterministic compiled-lesson fixtures in
 * server/lesson/fixtures/. Board scenes are derived from the real semantic
 * templates so the fixtures stay exactly what the compiler would produce.
 * Usage: npx tsx scripts/generate-lesson-fixtures.mts
 */

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = join(here, '..', 'server', 'lesson', 'fixtures');

interface TemplateFixtureSpec {
  file: string;
  key: string;
  goal: string;
  objective: string;
  domain: 'geometry' | 'process';
  groupLabel: string;
  template: 'triangle_angle_sum' | 'causal_cycle';
  parameters: Record<string, unknown>;
  instructionalQuestion: string;
  narrations: Record<'outline' | 'relation' | 'label' | 'connector' | 'emphasis', string>;
  successCriteria: string[];
  stages: LessonStage[];
}

function templateLesson(spec: TemplateFixtureSpec): CompiledLesson {
  const groupId = 'lesson-anchor';
  const { ops, checkpoints } = adaptSemanticScene({
    schemaVersion: VISUAL_PLAN_VERSION,
    planId: `compiled-fixture-${spec.key}`,
    intent: {
      objective: spec.objective,
      domain: spec.domain,
      relevance: 'essential',
      questionAnswered: spec.instructionalQuestion,
      rationale: 'Pre-compiled anchor scene authored by the lesson compiler.',
      action: 'establish',
      density: 'minimal',
    },
    groups: [{
      id: groupId,
      label: spec.groupLabel,
      revealOrder: ['outline', 'relation', 'label', 'connector', 'emphasis'],
      template: spec.template,
      parameters: spec.parameters,
    }],
  });
  return CompiledLessonSchema.parse({
    compiledLessonId: `compiled-fixture-${spec.key}`,
    schemaVersion: COMPILED_LESSON_SCHEMA_VERSION,
    goal: spec.goal,
    objective: spec.objective,
    blueprint: {
      blueprintId: `blueprint-fixture-${spec.key}`,
      goal: spec.objective,
      mode: 'board_led',
      successCriteria: spec.successCriteria,
      anchor: {
        semanticGroupId: groupId,
        template: spec.template,
        instructionalQuestion: spec.instructionalQuestion,
        invariantObjectIds: [],
      },
      stages: spec.stages,
      currentStageIndex: 0,
      detourStack: [],
    },
    anchorScene: {
      groupId,
      groupLabel: spec.groupLabel,
      template: spec.template,
      ops,
      storyboard: checkpoints.map((checkpoint) => ({
        id: checkpoint.id,
        reveal: checkpoint.reveal,
        narration: spec.narrations[checkpoint.reveal],
        objectIds: checkpoint.ops.flatMap((op) => (op.op === 'add' ? [op.id] : [])),
      })),
    },
    compiledAt: 0,
    compilerModel: 'fixture-compiler',
  });
}

const triangle = templateLesson({
  file: 'triangle-angle-sum.json',
  key: 'triangle-angle-sum',
  goal: 'Why do triangle angles add up to 180 degrees?',
  objective: 'Explain why the three angles of any triangle add up to 180 degrees',
  domain: 'geometry',
  groupLabel: 'Triangle angle sum',
  template: 'triangle_angle_sum',
  parameters: {},
  instructionalQuestion: 'Why do the three corner angles always fill a straight line?',
  narrations: {
    outline: 'Here is one triangle with its dashed straight line resting on top.',
    relation: 'Each coloured arc marks one of the three corner angles.',
    label: 'Together the three angles fill the straight line, and a straight line is 180 degrees.',
    connector: 'Follow the arrows from each corner to the line.',
    emphasis: 'Watch all three angles light up together.',
  },
  successCriteria: [
    'Learner explains that the three angles rearrange into a straight line',
    'Learner finds a missing angle from the other two',
  ],
  stages: [
    {
      id: 'orient', kind: 'orient', objective: 'Meet the triangle and its three corner angles',
      boardPurpose: 'establish_anchor', allowedBoardMutation: 'establish',
      learnerOpportunity: 'Point out the widest-looking corner', evidenceExpected: 'recall',
      checks: [{
        id: 'orient-widest', questionOrTask: 'Which corner of the triangle looks the widest to you?',
        responseMode: 'voice', targetObjectIds: ['lesson-anchor-angle-a', 'lesson-anchor-angle-b', 'lesson-anchor-angle-c'],
        misconceptions: [{ anticipatedAnswer: 'The top corner is always the biggest', tactic: 'Compare a tall narrow corner with a low wide one directly on the board.' }],
      }],
    },
    {
      id: 'model', kind: 'model', objective: 'See the three angles fill the straight line',
      boardPurpose: 'reveal_relation', allowedBoardMutation: 'extend',
      learnerOpportunity: 'Predict the total before the sum is revealed', evidenceExpected: 'reasoning',
      checks: [{
        id: 'model-predict', questionOrTask: 'If we slide all three angles onto the straight line, how much of it do you think they fill?',
        responseMode: 'voice', targetObjectIds: ['lesson-anchor-straight-line'],
        misconceptions: [{ anticipatedAnswer: 'They fill more than the line', tactic: 'Trace each angle onto the line one at a time and stop exactly at the end.' }],
      }],
    },
    {
      id: 'apply', kind: 'guided_check', objective: 'Use the 180-degree sum to find a missing angle',
      boardPurpose: 'elicit_learner_work', allowedBoardMutation: 'emphasize',
      learnerOpportunity: 'Work out the third angle aloud from two given angles', evidenceExpected: 'application',
      checks: [{
        id: 'apply-missing', questionOrTask: 'A triangle has angles of 60 degrees and 80 degrees. What must the third angle be?',
        responseMode: 'voice', targetObjectIds: ['lesson-anchor-sum'],
        misconceptions: [{ anticipatedAnswer: '140 degrees', tactic: 'Return to the sum equation and subtract both known angles from 180 step by step.' }],
      }],
    },
    {
      id: 'closure', kind: 'closure', objective: 'Say the rule in their own words',
      boardPurpose: 'summarize', allowedBoardMutation: 'none',
      learnerOpportunity: 'Explain the straight-line idea to a friend', evidenceExpected: 'explanation',
    },
  ],
});

const waterCycle = templateLesson({
  file: 'water-cycle.json',
  key: 'water-cycle',
  goal: 'How does the water cycle work?',
  objective: 'Explain how water cycles through evaporation, condensation, precipitation, and collection',
  domain: 'process',
  groupLabel: 'The water cycle',
  template: 'causal_cycle',
  parameters: { labels: ['Evaporation', 'Condensation', 'Precipitation', 'Collection'] },
  instructionalQuestion: 'How does the same water keep going around and around?',
  narrations: {
    outline: 'Here are the four stops water visits on its journey.',
    relation: 'Each stage causes the next one.',
    label: 'These names describe what the water is doing at each stop.',
    connector: 'The arrows show the direction the water travels, around and around forever.',
    emphasis: 'Watch the whole loop light up — it never stops.',
  },
  successCriteria: [
    'Learner narrates one full trip of a water drop around the cycle',
    'Learner names what drives evaporation',
  ],
  stages: [
    {
      id: 'orient', kind: 'orient', objective: 'Meet the four stages of the cycle',
      boardPurpose: 'establish_anchor', allowedBoardMutation: 'establish',
      learnerOpportunity: 'Say which stage they have seen in real life', evidenceExpected: 'recall',
      checks: [{
        id: 'orient-seen', questionOrTask: 'Which of these four stages have you seen with your own eyes?',
        responseMode: 'voice', targetObjectIds: ['lesson-anchor-node-0', 'lesson-anchor-node-2'],
        misconceptions: [{ anticipatedAnswer: 'Rain is new water from space', tactic: 'Ask where puddles go after a sunny day and connect that to the rain they saw.' }],
      }],
    },
    {
      id: 'model', kind: 'model', objective: 'Follow one water drop around the loop',
      boardPurpose: 'reveal_relation', allowedBoardMutation: 'extend',
      learnerOpportunity: 'Predict where the drop goes after each stage', evidenceExpected: 'reasoning',
      checks: [{
        id: 'model-next', questionOrTask: 'A water drop has just evaporated into the sky. What happens to it next?',
        responseMode: 'voice', targetObjectIds: ['lesson-anchor-node-1'],
        misconceptions: [{ anticipatedAnswer: 'It disappears forever', tactic: 'Point at the loop arrow and ask what the cold sky does to invisible water.' }],
      }],
    },
    {
      id: 'apply', kind: 'guided_check', objective: 'Narrate the full cycle without help',
      boardPurpose: 'elicit_learner_work', allowedBoardMutation: 'emphasize',
      learnerOpportunity: 'Tell the story of one drop through all four stages', evidenceExpected: 'explanation',
      checks: [{
        id: 'apply-narrate', questionOrTask: 'Tell me the whole journey of one drop, starting from a puddle, using all four stages.',
        responseMode: 'voice', targetObjectIds: ['lesson-anchor-edge-loop'],
        misconceptions: [{ anticipatedAnswer: 'The journey ends at collection', tactic: 'Follow the loop arrow back to evaporation and ask what the sun does to the collected water.' }],
      }],
    },
    {
      id: 'closure', kind: 'closure', objective: 'Connect the cycle to their own weather',
      boardPurpose: 'summarize', allowedBoardMutation: 'none',
      learnerOpportunity: 'Explain where today\u2019s clouds came from', evidenceExpected: 'application',
    },
  ],
});

const brave = CompiledLessonSchema.parse({
  compiledLessonId: 'compiled-fixture-being-brave',
  schemaVersion: COMPILED_LESSON_SCHEMA_VERSION,
  goal: 'Talk about being brave when things feel new',
  objective: 'Describe what bravery means and recall one time they acted bravely',
  blueprint: {
    blueprintId: 'blueprint-fixture-being-brave',
    goal: 'Describe what bravery means and recall one time they acted bravely',
    mode: 'conversation_led',
    successCriteria: [
      'Learner gives their own definition of bravery',
      'Learner connects bravery to a real moment from their life',
    ],
    anchor: null,
    stages: [
      {
        id: 'orient', kind: 'orient', objective: 'Warm up with what bravery feels like',
        boardPurpose: 'none', allowedBoardMutation: 'none',
        learnerOpportunity: 'Name something that feels scary but exciting', evidenceExpected: 'recall',
        checks: [{
          id: 'orient-feels', questionOrTask: 'What is something that feels a little scary and a little exciting at the same time?',
          responseMode: 'voice',
          misconceptions: [{ anticipatedAnswer: 'Brave people are never scared', tactic: 'Share that bravery only exists when something feels scary first, then ask again.' }],
        }],
      },
      {
        id: 'model', kind: 'model', objective: 'Build a working definition of bravery',
        boardPurpose: 'none', allowedBoardMutation: 'none',
        learnerOpportunity: 'Improve a too-simple definition the tutor offers', evidenceExpected: 'reasoning',
        checks: [{
          id: 'model-define', questionOrTask: 'If a friend asked you what brave means, what would you tell them?',
          responseMode: 'voice',
        }],
      },
      {
        id: 'apply', kind: 'guided_check', objective: 'Connect bravery to their own life',
        boardPurpose: 'none', allowedBoardMutation: 'none',
        learnerOpportunity: 'Tell one true story where they were brave', evidenceExpected: 'application',
        checks: [{
          id: 'apply-story', questionOrTask: 'Tell me about one time you did something even though it felt scary. What happened?',
          responseMode: 'voice',
        }],
      },
    ],
    currentStageIndex: 0,
    detourStack: [],
  },
  anchorScene: null,
  compiledAt: 0,
  compilerModel: 'fixture-compiler',
});

mkdirSync(outputDir, { recursive: true });
const files: [string, CompiledLesson][] = [
  ['triangle-angle-sum.json', triangle],
  ['water-cycle.json', waterCycle],
  ['being-brave.json', brave],
];
for (const [file, lesson] of files) {
  writeFileSync(join(outputDir, file), `${JSON.stringify(lesson, null, 2)}\n`);
  console.log(`wrote ${file}: mode=${lesson.blueprint.mode}, ops=${lesson.anchorScene?.ops.length ?? 0}, storyboard=${lesson.anchorScene?.storyboard.length ?? 0}`);
}
