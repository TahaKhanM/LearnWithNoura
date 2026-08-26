import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CompiledLessonSchema,
  COMPILED_LESSON_SCHEMA_VERSION,
  type CompiledLesson,
  type NormalizedGoal,
} from '../../shared/compiledLesson.js';

/**
 * Deterministic fixture compiler for offline development and automated
 * tests ONLY. It is selected explicitly by deployment mode when no model
 * provider is configured; production never falls back to it silently —
 * a missing compiler result in production is the preparing/error state.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtureCache = new Map<string, CompiledLesson>();

export const FIXTURE_COMPILER_MODEL = 'fixture-compiler';

function loadFixture(name: string): CompiledLesson {
  const cached = fixtureCache.get(name);
  if (cached) return cached;
  const raw = readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8');
  const lesson = CompiledLessonSchema.parse(JSON.parse(raw));
  fixtureCache.set(name, lesson);
  return lesson;
}

const VAGUE_GOAL = /\b(better at|help(?: \w+)? with|improve|catch up|struggl\w*|good at|general|anything|everything)\b/i;

function fixtureNameFor(text: string): string | null {
  if (/\b(triangle|angle|geometr\w*|180)\b/i.test(text)) return 'triangle-angle-sum';
  if (/\b(water|rain|evaporat\w*|condensat\w*|precipitat\w*|cycle)\b/i.test(text)) return 'water-cycle';
  if (/\b(brave|bravery|courage|feel\w*|confiden\w*)\b/i.test(text)) return 'being-brave';
  return null;
}

/** Deterministic goal normalization mirroring the live compiler's contract. */
export function normalizeFixtureGoal(goal: string): NormalizedGoal {
  const matched = fixtureNameFor(goal);
  if (!matched && VAGUE_GOAL.test(goal)) {
    return {
      kind: 'candidates',
      candidates: [
        { id: 'triangle-angle-sum', objective: loadFixture('triangle-angle-sum').objective, description: 'A geometry lesson on why triangle angles always total 180 degrees.' },
        { id: 'water-cycle', objective: loadFixture('water-cycle').objective, description: 'A science lesson following one water drop around the water cycle.' },
      ],
    };
  }
  const objective = matched ? loadFixture(matched).objective : goal.trim().slice(0, 240);
  return { kind: 'objective', objective };
}

/** Returns the matching subject fixture, or a generic conversation-led
 * lesson built deterministically from the goal itself. */
export function compileFixtureLesson(input: { lessonKey: string; goal: string; objective?: string }): CompiledLesson {
  const matched = fixtureNameFor(`${input.goal} ${input.objective ?? ''}`);
  if (matched) {
    const fixture = loadFixture(matched);
    return CompiledLessonSchema.parse({
      ...fixture,
      compiledLessonId: `compiled-${input.lessonKey}`,
      goal: input.goal.trim().slice(0, 300) || fixture.goal,
      blueprint: { ...fixture.blueprint, blueprintId: `blueprint-${input.lessonKey}` },
    });
  }
  const objective = (input.objective ?? input.goal).trim().slice(0, 200) || 'Explore the chosen topic together';
  return CompiledLessonSchema.parse({
    compiledLessonId: `compiled-${input.lessonKey}`,
    schemaVersion: COMPILED_LESSON_SCHEMA_VERSION,
    goal: input.goal.trim().slice(0, 300) || objective,
    objective,
    blueprint: {
      blueprintId: `blueprint-${input.lessonKey}`,
      goal: objective,
      mode: 'conversation_led',
      successCriteria: [`Learner explains one key idea about: ${objective}`.slice(0, 240)],
      anchor: null,
      stages: [
        {
          id: 'orient', kind: 'orient', objective: `Find out what the learner already knows about ${objective}`.slice(0, 240),
          boardPurpose: 'none', allowedBoardMutation: 'none',
          learnerOpportunity: 'Share what they already know or wonder', evidenceExpected: 'recall',
          checks: [{ id: 'orient-known', questionOrTask: 'What do you already know about this, even a small piece?', responseMode: 'voice' }],
        },
        {
          id: 'model', kind: 'model', objective: 'Build the core idea together in small steps',
          boardPurpose: 'none', allowedBoardMutation: 'none',
          learnerOpportunity: 'Answer small prediction questions along the way', evidenceExpected: 'reasoning',
          checks: [{ id: 'model-predict', questionOrTask: 'What do you think happens next, and why?', responseMode: 'voice' }],
        },
        {
          id: 'apply', kind: 'guided_check', objective: 'Use the idea on one concrete example',
          boardPurpose: 'none', allowedBoardMutation: 'none',
          learnerOpportunity: 'Work one example aloud with light support', evidenceExpected: 'application',
          checks: [{ id: 'apply-example', questionOrTask: 'Try this one yourself and talk me through your thinking.', responseMode: 'voice' }],
        },
      ],
      currentStageIndex: 0,
      detourStack: [],
    },
    anchorScene: null,
    compiledAt: 0,
    compilerModel: FIXTURE_COMPILER_MODEL,
  });
}
