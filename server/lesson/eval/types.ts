import { z } from 'zod';
import { LessonBlueprintSchema } from '../../../shared/pedagogy.js';

export const LESSON_EVAL_SCHEMA_VERSION = '1.0.0' as const;

export const StoryboardStepFixtureSchema = z.object({
  id: z.string().min(1),
  objectIds: z.array(z.string().min(1)).min(1),
  narration: z.string().min(1),
});

export const RevealNarrationTimelineEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('reveal'),
    stepId: z.string().min(1),
    objectIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal('narration'),
    stepId: z.string().min(1),
    referencedObjectIds: z.array(z.string().min(1)),
    narrationText: z.string().min(1).optional(),
  }),
]);

export const RevealNarrationFixtureSchema = z.object({
  schemaVersion: z.literal(LESSON_EVAL_SCHEMA_VERSION),
  label: z.string().min(1),
  expectPass: z.boolean(),
  storyboard: z.array(StoryboardStepFixtureSchema).min(1),
  timeline: z.array(RevealNarrationTimelineEventSchema).min(1),
});

export const BoardReleasedEventSchema = z.object({
  kind: z.enum(['add', 'remove']),
  objectId: z.string().min(1),
  owner: z.enum(['tutor', 'learner']),
  ts: z.number().finite().nonnegative(),
});

export const SectionNavigationEventSchema = z.object({
  ts: z.number().finite().nonnegative(),
  previousSemanticGroupId: z.string().min(1),
  nextSemanticGroupId: z.string().min(1),
});

export const DisappearanceMetricSchema = z.object({
  objectId: z.string().min(1),
  cause: z.enum(['scene_mutation', 'unknown']),
  ts: z.number().finite().nonnegative(),
});

export const ObjectPermanenceFixtureSchema = z.object({
  schemaVersion: z.literal(LESSON_EVAL_SCHEMA_VERSION),
  label: z.string().min(1),
  expectPass: z.boolean(),
  releasedEvents: z.array(BoardReleasedEventSchema),
  sectionNavigations: z.array(SectionNavigationEventSchema).default([]),
  disappearanceMetrics: z.array(DisappearanceMetricSchema).default([]),
});

export const TurnLatencyMetricRowSchema = z.object({
  name: z.enum(['speech_end_to_response_started', 'speech_end_to_first_audio']),
  valueMs: z.number().finite().nonnegative(),
});

export const TurnLatencyFixtureSchema = z.object({
  schemaVersion: z.literal(LESSON_EVAL_SCHEMA_VERSION),
  label: z.string().min(1),
  expectPass: z.boolean(),
  minSamplesForPercentile: z.number().int().positive().default(5),
  metrics: z.array(TurnLatencyMetricRowSchema),
});

export const BargeInTraceRowSchema = z.object({
  gateOutcome: z.enum(['local_only_rejected', 'provider_only_rejected', 'confirmed']),
  providerResponseId: z.string().min(1).optional(),
  cancelOutcome: z.enum(['provider_cancelled', 'provider_completed', 'provider_failed']).optional(),
});

export const FalseBargeInFixtureSchema = z.object({
  schemaVersion: z.literal(LESSON_EVAL_SCHEMA_VERSION),
  label: z.string().min(1),
  expectPass: z.boolean(),
  traces: z.array(BargeInTraceRowSchema),
  /** When set, gate fails unless this exact count is observed (negative control). */
  expectedConfirmedThenCancelled: z.number().int().nonnegative().optional(),
});

export const BlueprintJudgmentSchema = z.object({
  dimensionId: z.string().min(1),
  score: z.number().min(0).max(1),
  rationale: z.string().min(1),
});

export const BlueprintQualityFixtureSchema = z.object({
  schemaVersion: z.literal(LESSON_EVAL_SCHEMA_VERSION),
  label: z.string().min(1),
  expectPass: z.boolean(),
  minimumTotalScore: z.number().min(0).max(1).default(0.7),
  blueprint: LessonBlueprintSchema,
  scriptedJudgments: z.array(BlueprintJudgmentSchema).optional(),
});

export type RevealNarrationFixture = z.infer<typeof RevealNarrationFixtureSchema>;
export type ObjectPermanenceFixture = z.infer<typeof ObjectPermanenceFixtureSchema>;
export type TurnLatencyFixture = z.infer<typeof TurnLatencyFixtureSchema>;
export type FalseBargeInFixture = z.infer<typeof FalseBargeInFixtureSchema>;
export type BlueprintQualityFixture = z.infer<typeof BlueprintQualityFixtureSchema>;

export type DimensionGateResult = {
  dimension: string;
  fixtureLabel: string;
  pass: boolean;
  expectPass: boolean;
  details: Record<string, unknown>;
};

export type LessonEvalReport = {
  schemaVersion: typeof LESSON_EVAL_SCHEMA_VERSION;
  evidenceType: 'deterministic-offline-fixture-evaluation';
  evidenceBoundary: 'Scripted fixtures and production scoring modules only; no live provider, browser, acoustic, or percentile-from-n=1 claims.';
  realChildData: false;
  runtimeProviderCalls: 0;
  liveProviderBehavior: 'UNVERIFIED';
  targetHardwareAcoustics: 'UNVERIFIED';
  generatedAt: string;
  gates: DimensionGateResult[];
  pass: boolean;
};
