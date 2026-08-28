import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CompiledLessonSchema,
  type CompiledLesson,
  type NormalizedGoal,
} from '../../shared/compiledLesson.js';
import { compileProvisionalConversationLesson } from './provisionalLesson.js';

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
  if (/\b(fraction|number line|numberline|three.?quarter|3\/4)\b/i.test(text)) return 'numberline-fractions';
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
  return CompiledLessonSchema.parse({
    ...compileProvisionalConversationLesson(input),
    compilerModel: FIXTURE_COMPILER_MODEL,
  });
}
