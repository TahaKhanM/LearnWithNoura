import { z } from 'zod';

export const LayoutIssueCodeSchema = z.enum([
  'bounds',
  'collision',
  'stroke_collision',
  'connector_crossing',
  'reserved',
  'non_finite',
  'anchor_missing',
]);
export type LayoutIssueCode = z.infer<typeof LayoutIssueCodeSchema>;

export const LayoutBoundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().nonnegative(),
  h: z.number().finite().nonnegative(),
}).strict();
export type LayoutBounds = z.infer<typeof LayoutBoundsSchema>;

export const LayoutIssueSchema = z.object({
  code: LayoutIssueCodeSchema,
  itemId: z.string().min(1).max(160),
  withItemId: z.string().min(1).max(160).optional(),
  itemBounds: LayoutBoundsSchema.optional(),
  withItemBounds: LayoutBoundsSchema.optional(),
}).strict();
export type LayoutIssue = z.infer<typeof LayoutIssueSchema>;

export interface LayoutPreflightResult {
  accepted: boolean;
  reasons: string[];
  layoutIssues: LayoutIssue[];
}
