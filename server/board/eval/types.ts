import { z } from 'zod';

export const DirectorEvalCategorySchema = z.enum([
  'exact_math_geometry',
  'graphs_charts',
  'scientific_systems',
  'timelines_causal',
  'grammar_structure',
  'comparisons_part_whole',
  'unfamiliar_abstract',
  'mixed_diagram_illustration',
  'revisions_existing_board',
]);
export type DirectorEvalCategory = z.infer<typeof DirectorEvalCategorySchema>;

export const DirectorEvalIntentSchema = z.object({
  id: z.string().min(1).max(80),
  split: z.enum(['representative', 'holdout']),
  category: DirectorEvalCategorySchema,
  intent: z.string().min(1).max(500),
  purpose: z.string().min(1).max(300),
  density: z.enum(['minimal', 'standard']),
  difficulty: z.number().int().min(1).max(3),
  existingBoardDescription: z.string().min(1).max(500).optional(),
});
export type DirectorEvalIntent = z.infer<typeof DirectorEvalIntentSchema>;

export const SeededDefectSchema = z.object({
  id: z.string().min(1).max(80),
  defectKind: z.enum(['wrong_shading', 'mislabeled_value', 'reversed_arrow']),
  intent: z.string().min(1).max(500),
  defectDescription: z.string().min(1).max(500),
  deterministicValidatorPasses: z.literal(true),
  expectedAuditReject: z.literal(true),
});
export type SeededDefect = z.infer<typeof SeededDefectSchema>;

export const SketchBaseSchema = z.object({
  id: z.string().min(1).max(80),
  expectedInterpretation: z.string().min(1).max(120),
  points: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(2).max(120),
});
export type SketchBase = z.infer<typeof SketchBaseSchema>;

export type DirectorEvalConditionId =
  | 'terra-low'
  | 'terra-med'
  | 'luna-low'
  | 'luna-med'
  | 'terra-low+luna-low';

export interface DirectorEvalCondition {
  id: DirectorEvalConditionId;
  legs: Array<{
    model: 'gpt-5.6-terra' | 'gpt-5.6-luna';
    reasoningEffort: 'low' | 'medium';
  }>;
}

export interface DirectorEvalTrial {
  intentId: string;
  split: 'representative' | 'holdout';
  conditionId: DirectorEvalConditionId;
  cacheState: 'cold' | 'warm';
  trial: number;
  ttftMs: number;
  firstValidOpMs: number;
  completeSceneMs: number;
  strictSchemaValid: boolean;
  validatorPassed: boolean;
  storyboardCoverage: boolean;
  qualityGrade: number;
  cachedInputTokens: number;
  costUsd: number;
}

export interface ConditionSummary {
  conditionId: string;
  firstPassValidity: number;
  qualityGrade: number;
  p50FirstValidOpMs: number;
  meanCostUsd: number;
}
