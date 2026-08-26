import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { LessonBlueprint } from '../../../shared/pedagogy.js';
import type { BlueprintQualityFixture } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));

const RubricDimensionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  weight: z.number().positive(),
  criteria: z.string().min(1),
});

const BlueprintQualityRubricSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  title: z.string().min(1),
  description: z.string().min(1),
  dimensions: z.array(RubricDimensionSchema).min(1),
  passThreshold: z.number().min(0).max(1),
});

export type BlueprintQualityRubric = z.infer<typeof BlueprintQualityRubricSchema>;

export type BlueprintDimensionScore = {
  dimensionId: string;
  label: string;
  weight: number;
  score: number;
  rationale: string;
  source: 'structural' | 'scripted_judge';
  applicable: boolean;
};

export type BlueprintQualityResult = {
  pass: boolean;
  totalScore: number;
  passThreshold: number;
  dimensions: BlueprintDimensionScore[];
};

let cachedRubric: BlueprintQualityRubric | null = null;

export function loadBlueprintQualityRubric(): BlueprintQualityRubric {
  if (cachedRubric) return cachedRubric;
  const raw = readFileSync(join(here, 'blueprint-quality-rubric.json'), 'utf8');
  cachedRubric = BlueprintQualityRubricSchema.parse(JSON.parse(raw));
  return cachedRubric;
}

function scoreStagePurpose(blueprint: LessonBlueprint): BlueprintDimensionScore {
  const rubric = loadBlueprintQualityRubric();
  const dimension = rubric.dimensions.find((entry) => entry.id === 'stage_purpose');
  if (!dimension) throw new Error('Missing stage_purpose rubric dimension.');

  const purposes = blueprint.stages.map((stage) => `${stage.kind}:${stage.boardPurpose}`);
  const uniquePurposes = new Set(purposes);
  const hasProgression = blueprint.stages.some((stage) => stage.kind === 'orient') &&
    blueprint.stages.some((stage) => stage.kind === 'model' || stage.kind === 'guided_check');
  const allObjectivesDistinct = new Set(blueprint.stages.map((stage) => stage.objective)).size === blueprint.stages.length;
  const score = uniquePurposes.size === blueprint.stages.length && hasProgression && allObjectivesDistinct ? 1 : 0.35;

  return {
    dimensionId: dimension.id,
    label: dimension.label,
    weight: dimension.weight,
    score,
    rationale: score >= 1
      ? 'Stages have distinct objectives and a orient→model/check progression.'
      : 'Stages overlap in purpose or lack the expected progression.',
    source: 'structural',
    applicable: true,
  };
}

function scoreCheckTaskPairing(blueprint: LessonBlueprint): BlueprintDimensionScore {
  const rubric = loadBlueprintQualityRubric();
  const dimension = rubric.dimensions.find((entry) => entry.id === 'check_task_pairing');
  if (!dimension) throw new Error('Missing check_task_pairing rubric dimension.');

  const checkStages = blueprint.stages.filter((stage) =>
    stage.kind === 'guided_check' || stage.kind === 'independent_check');
  if (checkStages.length === 0) {
    return {
      dimensionId: dimension.id,
      label: dimension.label,
      weight: dimension.weight,
      score: 0.4,
      rationale: 'No guided or independent check stage present.',
      source: 'structural',
      applicable: true,
    };
  }

  const paired = checkStages.every((stage) =>
    (stage.checks?.length ?? 0) > 0 &&
    stage.checks?.every((check) => check.questionOrTask.trim().length > 0) === true);
  const voiceMismatch = blueprint.stages.some((stage) =>
    (stage.checks ?? []).some((check) => check.responseMode === 'manipulate' && stage.kind === 'orient'));

  const score = paired && !voiceMismatch ? 1 : paired ? 0.6 : 0.2;
  return {
    dimensionId: dimension.id,
    label: dimension.label,
    weight: dimension.weight,
    score,
    rationale: paired
      ? 'Check stages include explicit questionOrTask wording.'
      : 'A check stage is missing task wording.',
    source: 'structural',
    applicable: true,
  };
}

function scoreVisualIntent(blueprint: LessonBlueprint): BlueprintDimensionScore {
  const rubric = loadBlueprintQualityRubric();
  const dimension = rubric.dimensions.find((entry) => entry.id === 'visual_intent_vs_geometry');
  if (!dimension) throw new Error('Missing visual_intent_vs_geometry rubric dimension.');

  if (blueprint.mode !== 'board_led') {
    return {
      dimensionId: dimension.id,
      label: dimension.label,
      weight: dimension.weight,
      score: 1,
      rationale: 'Conversation-led lesson does not require board anchor authorship.',
      source: 'structural',
      applicable: true,
    };
  }

  const hasAnchor = Boolean(blueprint.anchor?.semanticGroupId && blueprint.anchor.template);
  const hasEstablish = blueprint.stages.some((stage) => stage.allowedBoardMutation === 'establish');
  const score = hasAnchor && hasEstablish ? 1 : hasAnchor ? 0.55 : 0.15;

  return {
    dimensionId: dimension.id,
    label: dimension.label,
    weight: dimension.weight,
    score,
    rationale: hasAnchor && hasEstablish
      ? 'Board-led blueprint declares anchor template and an establish stage.'
      : 'Board-led blueprint is missing anchor intent or establish stage.',
    source: 'structural',
    applicable: true,
  };
}

function scoreManipulatePairing(blueprint: LessonBlueprint): BlueprintDimensionScore {
  const rubric = loadBlueprintQualityRubric();
  const dimension = rubric.dimensions.find((entry) => entry.id === 'manipulate_check_pairing');
  if (!dimension) throw new Error('Missing manipulate_check_pairing rubric dimension.');

  const manipulateChecks = blueprint.stages.flatMap((stage) => stage.checks ?? [])
    .filter((check) => check.responseMode === 'manipulate');
  if (manipulateChecks.length === 0) {
    return {
      dimensionId: dimension.id,
      label: dimension.label,
      weight: dimension.weight,
      score: 0,
      rationale: 'No manipulate checks — dimension excluded from weighted total.',
      source: 'structural',
      applicable: false,
    };
  }

  const allPaired = manipulateChecks.every((check) => Boolean(check.manipulativeCheck));
  return {
    dimensionId: dimension.id,
    label: dimension.label,
    weight: dimension.weight,
    score: allPaired ? 1 : 0,
    rationale: allPaired
      ? 'Every manipulate check includes manipulativeCheck.'
      : 'At least one manipulate check lacks manipulativeCheck.',
    source: 'structural',
    applicable: true,
  };
}

function scoreNoAssessmentInImages(blueprint: LessonBlueprint): BlueprintDimensionScore {
  const rubric = loadBlueprintQualityRubric();
  const dimension = rubric.dimensions.find((entry) => entry.id === 'no_assessment_in_images');
  if (!dimension) throw new Error('Missing no_assessment_in_images rubric dimension.');

  if (blueprint.mode !== 'board_led') {
    return {
      dimensionId: dimension.id,
      label: dimension.label,
      weight: dimension.weight,
      score: 1,
      rationale: 'Conversation-led lesson has no image-bound anchor intent.',
      source: 'structural',
      applicable: true,
    };
  }

  const forbidden = /\b(answer|correct|assessment target)\b/i;
  const imageIntentText = [
    blueprint.anchor?.instructionalQuestion ?? '',
    blueprint.anchor?.template ?? '',
  ].join('\n');
  const leaksAssessment = forbidden.test(imageIntentText);

  return {
    dimensionId: dimension.id,
    label: dimension.label,
    weight: dimension.weight,
    score: leaksAssessment ? 0.25 : 1,
    rationale: leaksAssessment
      ? 'Anchor illustration intent embeds assessment-like wording that belongs in BoardOp overlays.'
      : 'No assessment targets detected in image-bound anchor intent.',
    source: 'structural',
    applicable: true,
  };
}

const structuralScorers: Record<string, (blueprint: LessonBlueprint) => BlueprintDimensionScore> = {
  stage_purpose: scoreStagePurpose,
  check_task_pairing: scoreCheckTaskPairing,
  visual_intent_vs_geometry: scoreVisualIntent,
  manipulate_check_pairing: scoreManipulatePairing,
  no_assessment_in_images: scoreNoAssessmentInImages,
};

/** Default offline path: structural scorer plus optional scripted judge overrides. */
export function scoreBlueprintQuality(fixture: BlueprintQualityFixture): BlueprintQualityResult {
  const rubric = loadBlueprintQualityRubric();
  const scripted = new Map((fixture.scriptedJudgments ?? []).map((entry) => [entry.dimensionId, entry]));
  const dimensions: BlueprintDimensionScore[] = [];

  for (const dimension of rubric.dimensions) {
    const override = scripted.get(dimension.id);
    if (override) {
      dimensions.push({
        dimensionId: dimension.id,
        label: dimension.label,
        weight: dimension.weight,
        score: override.score,
        rationale: override.rationale,
        source: 'scripted_judge',
        applicable: true,
      });
      continue;
    }
    const scorer = structuralScorers[dimension.id];
    if (!scorer) {
      dimensions.push({
        dimensionId: dimension.id,
        label: dimension.label,
        weight: dimension.weight,
        score: 0,
        rationale: `No offline scorer registered for ${dimension.id}.`,
        source: 'structural',
        applicable: true,
      });
      continue;
    }
    dimensions.push(scorer(fixture.blueprint));
  }

  const applicable = dimensions.filter((entry) => entry.applicable);
  const totalWeight = applicable.reduce((sum, entry) => sum + entry.weight, 0);
  const weightedSum = applicable.reduce((sum, entry) => sum + entry.score * entry.weight, 0);
  const totalScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const passThreshold = rubric.passThreshold;
  return {
    pass: totalScore >= passThreshold,
    totalScore: Number(totalScore.toFixed(4)),
    passThreshold,
    dimensions,
  };
}
