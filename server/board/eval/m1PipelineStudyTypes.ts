import { z } from 'zod';
import type { HeadlessSceneValidatorHandle } from '../../lesson/headlessSceneValidator.js';
import policyJson from './fixtures/m1-pipeline-study-policy.json' with { type: 'json' };

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CategorySchema = z.enum([
  'exact_math_geometry', 'graphs_charts', 'scientific_systems',
  'timelines_causal', 'grammar_structure', 'comparisons_part_whole',
  'unfamiliar_abstract', 'mixed_diagram_illustration', 'revisions_existing_board',
]);
const RouteSchema = z.enum(['streaming_diagram', 'classic_illustration']);
const BrowserVerdictSchema = z.object({
  accepted: z.boolean(), reasons: z.array(z.string()),
}).strict();

export const M1PipelineStudyPolicySchema = z.object({
  schemaVersion: z.literal('1.1.0'),
  studyKind: z.literal('paired_delivery_path_same_proposal'),
  ruleSourcePath: z.string().min(1),
  sourceEvidencePath: z.string().min(1),
  sourceEvidenceSha256: HashSchema,
  browserObservationPath: z.string().min(1),
  browserObservationSha256: HashSchema,
  conditionId: z.literal('terra-low'),
  expectedSourceQualityEvidenceCompleteRows: z.literal(24),
  diagramCategories: z.array(CategorySchema).length(8),
  classicIllustrationCategory: z.literal('mixed_diagram_illustration'),
  maximumDiagramValidityDropPercentagePoints: z.number().positive().max(100),
  minimumAbsoluteFirstPassValidity: z.number().min(0).max(1),
  maximumAbsoluteQualityGradeDelta: z.number().positive().max(4),
  minimumProviderCriticalPathReadinessCut: z.number().min(0).max(1),
  percentileMethod: z.literal('lower_nearest_rank'),
}).strict();
export type M1PipelineStudyPolicy = z.infer<typeof M1PipelineStudyPolicySchema>;
export const M1_PIPELINE_STUDY_POLICY = M1PipelineStudyPolicySchema.parse(policyJson);

export const M1BrowserObservationRowSchema = z.object({
  sourceKey: z.string().min(1),
  intentId: z.string().min(1).max(80),
  split: z.enum(['representative', 'holdout']),
  category: CategorySchema,
  cacheState: z.enum(['cold', 'warm']),
  trial: z.number().int().min(1).max(5),
  route: RouteSchema,
  proposalSha256: HashSchema,
  atomic: BrowserVerdictSchema.extend({
    opsSha256: HashSchema, rasterSha256: HashSchema,
  }).strict(),
  streamed: BrowserVerdictSchema.extend({
    opsSha256: HashSchema,
    rasterSha256: HashSchema,
    cumulativeVerdicts: z.array(BrowserVerdictSchema.extend({
      stepIndex: z.number().int().nonnegative(),
      stepId: z.string().min(1).max(120),
      opsSha256: HashSchema,
    }).strict()),
  }).strict(),
}).strict();
export type M1BrowserObservationRow = z.infer<typeof M1BrowserObservationRowSchema>;

export const M1BrowserObservationArtifactSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  evidenceMode: z.literal('offline_local_browser_delivery_path_observations'),
  studyKind: z.literal('paired_delivery_path_same_proposal'),
  providerCalls: z.literal(0),
  runtimeCostUsd: z.literal(0),
  source: z.object({
    path: z.string().min(1), sha256: HashSchema,
    conditionId: z.literal('terra-low'), rows: z.literal(360),
  }).strict(),
  browserHarness: z.object({
    origin: z.string().url(),
    path: z.literal('/dev/board'),
    finalOrigin: z.string().url(),
    finalPath: z.literal('/dev/board'),
    engine: z.literal('chromium'),
    externalRequestCount: z.literal(0),
    fullScenePreflights: z.number().int().nonnegative(),
    cumulativePreflights: z.number().int().nonnegative(),
    rasterRenders: z.number().int().nonnegative(),
  }).strict(),
  rows: z.array(M1BrowserObservationRowSchema).length(360),
}).strict();
export type M1BrowserObservationArtifact = z.infer<typeof M1BrowserObservationArtifactSchema>;

export const M1PipelineStudyRowSchema = z.object({
  sourceKey: z.string().min(1),
  intentId: z.string().min(1).max(80),
  split: z.enum(['representative', 'holdout']),
  category: CategorySchema,
  cacheState: z.enum(['cold', 'warm']),
  trial: z.number().int().min(1).max(5),
  route: RouteSchema,
  sourceFirstPassAccepted: z.boolean(),
  atomicAccepted: z.boolean(),
  candidateAccepted: z.boolean(),
  cumulativeVerdictCount: z.number().int().nonnegative(),
  exactOpsParity: z.boolean(),
  exactRasterParity: z.boolean(),
  firstValidOpMs: z.number().int().nonnegative().nullable(),
  completeSceneMs: z.number().int().nonnegative(),
  qualitySampled: z.boolean(),
  qualityGrade: z.number().min(1).max(5).nullable(),
  sourceQualityEvidenceComplete: z.boolean(),
  qualityEvidenceReused: z.boolean(),
}).strict();
export type M1PipelineStudyRow = z.infer<typeof M1PipelineStudyRowSchema>;

const CohortSummarySchema = z.object({
  rows: z.number().int().nonnegative(),
  atomicAccepted: z.number().int().nonnegative(),
  candidateAccepted: z.number().int().nonnegative(),
  atomicValidity: z.number().min(0).max(1),
  candidateValidity: z.number().min(0).max(1),
  validityDropPercentagePoints: z.number(),
}).strict();
const ReadinessSummarySchema = z.object({
  rows: z.number().int().nonnegative(),
  p50StreamedFirstValidatedStepReadyMs: z.number().int().nonnegative(),
  p50AtomicProposalCompleteMs: z.number().int().nonnegative(),
  providerCriticalPathReadinessCut: z.number(),
}).strict();
const QualitySummarySchema = z.object({
  expectedSourceRows: z.literal(24),
  sourceRows: z.number().int().nonnegative(),
  reusedRows: z.number().int().nonnegative(),
  atomicMeanGrade: z.number().min(0).max(5),
  candidateMeanGrade: z.number().min(0).max(5),
  absoluteGradeDelta: z.number().min(0).max(5),
  completeNonAttritingReuse: z.boolean(),
}).strict();

export const M1PipelineStudySummarySchema = z.object({
  all: CohortSummarySchema,
  diagrams: CohortSummarySchema,
  illustrations: CohortSummarySchema,
  representativeDiagrams: CohortSummarySchema,
  holdoutDiagrams: CohortSummarySchema,
  readiness: ReadinessSummarySchema,
  representativeReadiness: ReadinessSummarySchema,
  holdoutReadiness: ReadinessSummarySchema,
  quality: QualitySummarySchema,
  diagramValidityWithinTolerance: z.boolean(),
  absoluteFirstPassValidityGateMet: z.boolean(),
  qualityWithinTolerance: z.boolean(),
  providerCriticalPathReadinessCutMet: z.boolean(),
  selectedRevealPolicy: z.enum([
    'each_validated_step', 'reveal_after_2_steps_requires_readiness_evidence',
  ]),
  actualUiFirstPaintAcceptance: z.literal('requires_separate_ops_presented_evidence'),
  deliveryPathStudyPass: z.boolean(),
  m1AcceptancePass: z.boolean(),
}).strict();
export type M1PipelineStudySummary = z.infer<typeof M1PipelineStudySummarySchema>;

export const M1PipelineStudyReportSchema = z.object({
  schemaVersion: z.literal('1.1.0'),
  pass: z.boolean(),
  evidenceMode: z.literal('offline_paired_delivery_path_ab'),
  studyKind: z.literal('paired_delivery_path_same_proposal'),
  generatorModelComparison: z.literal(false),
  evidenceBoundary: z.string().min(1),
  realChildData: z.literal(false),
  providerCalls: z.literal(0),
  runtimeCostUsd: z.literal(0),
  generatedAt: z.string().datetime(),
  source: z.object({
    path: z.string().min(1), sha256: HashSchema,
    conditionId: z.literal('terra-low'), rows: z.literal(360),
  }).strict(),
  browserObservations: z.object({
    path: z.string().min(1), sha256: HashSchema,
    rows: z.literal(360), externalRequestCount: z.literal(0),
  }).strict(),
  policy: M1PipelineStudyPolicySchema,
  summary: M1PipelineStudySummarySchema,
  rows: z.array(M1PipelineStudyRowSchema).length(360),
}).strict();
export type M1PipelineStudyReport = z.infer<typeof M1PipelineStudyReportSchema>;

export interface M1PipelineStudyHarness {
  validate: HeadlessSceneValidatorHandle['validate'];
  render: HeadlessSceneValidatorHandle['render'];
  origin: string;
  path: '/dev/board';
  browserState(): {
    finalOrigin: string;
    finalPath: string;
    externalRequestCount: number;
  };
}
