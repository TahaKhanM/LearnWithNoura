import { z } from 'zod';
import type { BoardOp } from '../../../shared/boardOps.js';

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
  existingBoardOps: z.array(z.unknown()).min(1).max(40).optional(),
});
type ParsedDirectorEvalIntent = z.infer<typeof DirectorEvalIntentSchema>;
export type DirectorEvalIntent = Omit<ParsedDirectorEvalIntent, 'existingBoardOps'> & {
  existingBoardOps?: BoardOp[];
};

export const SeededDefectSchema = z.object({
  id: z.string().min(1).max(80),
  defectKind: z.enum(['wrong_shading', 'mislabeled_value', 'reversed_arrow']),
  intent: z.string().min(1).max(500),
  defectDescription: z.string().min(1).max(500),
  deterministicValidatorPasses: z.literal(true),
  expectedAuditReject: z.literal(true),
  defectOps: z.array(z.unknown()).min(1).max(40),
  cleanOps: z.array(z.unknown()).min(1).max(40),
});
type ParsedSeededDefect = z.infer<typeof SeededDefectSchema>;
export type SeededDefect = Omit<ParsedSeededDefect, 'defectOps' | 'cleanOps'> & {
  defectOps: BoardOp[];
  cleanOps: BoardOp[];
};

export const SKETCH_INTERPRETATIONS = [
  'straight line',
  'underline',
  'circle',
  'triangle',
  'right arrow',
  'cross mark',
  'check mark',
  'box',
  'increasing curve',
  'fraction partition',
] as const;
export type SketchInterpretation = (typeof SKETCH_INTERPRETATIONS)[number];
export const SketchInterpretationSchema = z.enum(SKETCH_INTERPRETATIONS);

export const SketchBaseSchema = z.object({
  id: z.string().min(1).max(80),
  expectedInterpretation: SketchInterpretationSchema,
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
    maxCompletionTokens: number;
  }>;
}

export interface DirectorEvalTrial {
  intentId: string;
  split: 'representative' | 'holdout';
  conditionId: DirectorEvalConditionId;
  cacheState: 'cold' | 'warm';
  trial: number;
  ttftMs: number;
  firstValidOpMs: number | null;
  firstStepStatus: 'valid' | 'invalid' | 'missing';
  completeSceneMs: number;
  strictSchemaValid: boolean;
  validatorPassed: boolean;
  storyboardCoverage: boolean;
  qualitySampled: boolean;
  qualityGrade: number | null;
  qualityEvidenceComplete: boolean;
  cacheExpectationMet: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  usageComplete: boolean;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null;
  maxCompletionTokens: number;
  selectedLegIndex: number;
  modelUsage: Array<{
    model: 'gpt-5.6-terra' | 'gpt-5.6-luna';
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    usageComplete: boolean;
    finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null;
    maxCompletionTokens: number;
  }>;
  costUsd: number;
  costUpperBoundUsd: number;
  proposalText: string;
  validationReasons: string[];
  judgeReasons: string[];
  rasterHashes: string[];
}

export interface ConditionSummary {
  conditionId: string;
  firstPassValidity: number;
  qualityGrade: number;
  p50FirstValidOpMs: number;
  meanCostUsd: number;
  p50TtftMs?: number;
  p50CompleteSceneMs?: number;
  strictSchemaValidity?: number;
  validatorPassRate?: number;
  storyboardCoverageRate?: number;
  meanCostUpperBoundUsd?: number;
}
