import { z } from 'zod';

/** Closed, privacy-safe dimensions shared by the Drawing vNext telemetry
 * contracts. No intent, learner text, or arbitrary provider name is allowed. */
export const VisualTelemetryLaneSchema = z.enum([
  'anchor',
  'template',
  'director',
  'cache',
]);
export type VisualTelemetryLane = z.infer<typeof VisualTelemetryLaneSchema>;

export const DirectorReasoningEffortSchema = z.enum([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type DirectorReasoningEffort = z.infer<typeof DirectorReasoningEffortSchema>;

export const VisionAuditOutcomeSchema = z.enum([
  'approved',
  'rejected',
  'timeout',
  'invalid',
  'error',
]);
export type VisionAuditOutcome = z.infer<typeof VisionAuditOutcomeSchema>;

export const OpenAiTelemetryModelSchema = z.string()
  .min(1)
  .max(120)
  .regex(/^gpt-[a-z0-9][a-z0-9.-]*$/);

const drawingDurationBase = {
  schemaVersion: z.literal('1.0.0'),
  unit: z.literal('ms'),
  value: z.number().finite().int().nonnegative(),
};

export const DRAWING_METRIC_SCHEMAS = [
  z.object({
    ...drawingDurationBase,
    name: z.literal('visual_first_paint'),
    dimensions: z.object({ lane: VisualTelemetryLaneSchema }),
  }),
  z.object({
    ...drawingDurationBase,
    name: z.literal('visual_scene_complete'),
    dimensions: z.object({ lane: VisualTelemetryLaneSchema }),
  }),
  z.object({
    ...drawingDurationBase,
    name: z.literal('director_stream_first_op'),
    dimensions: z.object({
      model: OpenAiTelemetryModelSchema,
      reasoningEffort: DirectorReasoningEffortSchema,
    }),
  }),
  z.object({
    ...drawingDurationBase,
    name: z.literal('vision_audit_outcome'),
    dimensions: z.object({
      model: OpenAiTelemetryModelSchema,
      reasoningEffort: DirectorReasoningEffortSchema,
      outcome: VisionAuditOutcomeSchema,
    }),
  }),
] as const;
