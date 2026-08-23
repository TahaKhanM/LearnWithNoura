import { z } from 'zod';

export const LearnerGestureSchema = z.enum([
  'line', 'underline', 'circle', 'closed_shape', 'check', 'pointing_mark', 'freehand',
]);

const BoundsSchema = z.object({
  x: z.number().finite().min(0).max(1000),
  y: z.number().finite().min(0).max(600),
  w: z.number().finite().min(0).max(1000),
  h: z.number().finite().min(0).max(600),
});

export const LearnerBoardAnalysisSchema = z.object({
  version: z.literal('1.0.0'),
  semanticGroupId: z.string().min(1).max(160).optional(),
  strokes: z.array(z.object({
    id: z.string().min(1).max(100),
    gesture: LearnerGestureSchema,
    bounds: BoundsSchema,
    centroid: z.tuple([z.number().finite().min(0).max(1000), z.number().finite().min(0).max(600)]),
    length: z.number().finite().nonnegative().max(100_000),
    straightness: z.number().finite().min(0).max(1),
    closure: z.number().finite().min(0).max(1),
    corners: z.number().int().nonnegative().max(100),
    nearestObjectIds: z.array(z.string().min(1).max(100)).max(3),
    touchedObjectIds: z.array(z.string().min(1).max(100)).max(12),
  })).max(40),
  erasedIds: z.array(z.string().min(1).max(100)).max(40),
  summary: z.string().max(4_000),
});

export type LearnerBoardAnalysis = z.infer<typeof LearnerBoardAnalysisSchema>;
