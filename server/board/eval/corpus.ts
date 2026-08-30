import intentsJson from './fixtures/director-intents.json' with { type: 'json' };
import defectsJson from './fixtures/seeded-defects.json' with { type: 'json' };
import sketchesJson from './fixtures/sketch-bases.json' with { type: 'json' };
import {
  DirectorEvalIntentSchema,
  SeededDefectSchema,
  SketchBaseSchema,
  type DirectorEvalCondition,
  type DirectorEvalIntent,
  type SeededDefect,
} from './types.js';

export const DIRECTOR_EVAL_CONDITIONS: DirectorEvalCondition[] = [
  { id: 'terra-low', legs: [{ model: 'gpt-5.6-terra', reasoningEffort: 'low' }] },
  { id: 'terra-med', legs: [{ model: 'gpt-5.6-terra', reasoningEffort: 'medium' }] },
  { id: 'luna-low', legs: [{ model: 'gpt-5.6-luna', reasoningEffort: 'low' }] },
  { id: 'luna-med', legs: [{ model: 'gpt-5.6-luna', reasoningEffort: 'medium' }] },
  {
    id: 'terra-low+luna-low',
    legs: [
      { model: 'gpt-5.6-terra', reasoningEffort: 'low' },
      { model: 'gpt-5.6-luna', reasoningEffort: 'low' },
    ],
  },
];

export function loadDirectorEvalCorpus(): DirectorEvalIntent[] {
  return DirectorEvalIntentSchema.array().length(36).parse(intentsJson);
}

export function promptTuningCorpus(): DirectorEvalIntent[] {
  return loadDirectorEvalCorpus().filter((entry) => entry.split === 'representative');
}

export function loadSeededDefects(): SeededDefect[] {
  return SeededDefectSchema.array().min(9).parse(defectsJson);
}

export interface SyntheticSketch {
  id: string;
  expectedInterpretation: string;
  points: Array<[number, number]>;
  jitterSeed: 1 | 2 | 3;
  synthetic: true;
  source: 'board_ui_base_plus_programmatic_jitter';
}

/** Ten synthetic base strokes captured in board coordinates become thirty
 * deterministic variants. No learner drawing or learner identifier enters
 * this corpus. */
export function materializeSketchCorpus(): SyntheticSketch[] {
  const bases = SketchBaseSchema.array().length(10).parse(sketchesJson);
  return bases.flatMap((base) => ([1, 2, 3] as const).map((jitterSeed) => ({
    id: `${base.id}-j${jitterSeed}`,
    expectedInterpretation: base.expectedInterpretation,
    points: base.points.map(([x, y], index) => [
      x + jitter(index, jitterSeed, 0),
      y + jitter(index, jitterSeed, 1),
    ]),
    jitterSeed,
    synthetic: true as const,
    source: 'board_ui_base_plus_programmatic_jitter' as const,
  })));
}

function jitter(index: number, seed: number, axis: number): number {
  const value = Math.sin((index + 1) * (seed * 17 + axis * 31)) * 3.25;
  return Math.round(value * 100) / 100;
}
