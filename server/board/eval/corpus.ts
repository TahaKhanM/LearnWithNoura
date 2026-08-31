import intentsJson from './fixtures/director-intents.json' with { type: 'json' };
import defectsJson from './fixtures/seeded-defects.json' with { type: 'json' };
import sketchesJson from './fixtures/sketch-bases.json' with { type: 'json' };
import { validateOps, type BoardOp } from '../../../shared/boardOps.js';
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
  return DirectorEvalIntentSchema.array().length(36).parse(intentsJson).map((entry) => {
    const { existingBoardOps, ...intent } = entry;
    return existingBoardOps
      ? { ...intent, existingBoardOps: validateExistingBoardOps(entry.id, existingBoardOps) }
      : intent;
  });
}

export function promptTuningCorpus(): DirectorEvalIntent[] {
  return loadDirectorEvalCorpus().filter((entry) => entry.split === 'representative');
}

export function loadSeededDefects(): SeededDefect[] {
  return SeededDefectSchema.array().length(12).parse(defectsJson).map((entry) => ({
    ...entry,
    defectOps: validateSeededFixtureOps(entry.id, 'defectOps', entry.defectOps),
    cleanOps: validateSeededFixtureOps(entry.id, 'cleanOps', entry.cleanOps),
  }));
}

function validateSeededFixtureOps(
  defectId: string,
  variant: 'defectOps' | 'cleanOps',
  rawOps: unknown[],
): BoardOp[] {
  const validated = validateOps(rawOps, { tier: 'authored' });
  if (validated.rejected.length > 0 || validated.ops.length !== rawOps.length) {
    throw new Error(`Seeded defect ${defectId} ${variant} failed authored BoardOp validation: ${validated.rejected.map((entry) => entry.reason).join('; ')}`);
  }
  if (validated.ops.some((op) => op.op !== 'add')) {
    throw new Error(`Seeded defect ${defectId} ${variant} must be add-only.`);
  }
  const ids = validated.ops.map((op) => op.op === 'add' ? op.id : '');
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Seeded defect ${defectId} ${variant} has duplicate object ids.`);
  }
  return validated.ops;
}

function validateExistingBoardOps(intentId: string, rawOps: unknown[]): BoardOp[] {
  const validated = validateOps(rawOps, { tier: 'authored' });
  if (validated.rejected.length > 0 || validated.ops.length !== rawOps.length || validated.ops.some((op) => op.op !== 'add')) {
    throw new Error(`Director evaluation intent ${intentId} has invalid existing-board ops.`);
  }
  return validated.ops;
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
