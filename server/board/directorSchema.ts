import { z } from 'zod';
import { validateOps, type AddOp, type BoardOp } from '../../shared/boardOps.js';
import { AnchorSceneSchema, StoryboardStepSchema, type AnchorScene } from '../../shared/compiledLesson.js';

/**
 * The Board Director's structured-output contracts. A directed scene is the
 * same validated shape as a compiled anchor scene (final add-only BoardOps
 * plus an ordered storyboard of narration beats), so one sequencing engine
 * plays both.
 */

/** A directed scene is an anchor-shaped scene authored live by the Director. */
export type DirectedScene = AnchorScene;

/** What the Director model must return for one proposal round. */
export const DirectorProposalSchema = z.object({
  groupLabel: z.string().min(1).max(160),
  ops: z.array(z.unknown()).min(1).max(40),
  storyboard: z.array(StoryboardStepSchema).min(1).max(8),
});
export type DirectorProposal = z.infer<typeof DirectorProposalSchema>;

/** What the Director model must return for one vision inspection round. */
export const DirectorVisionVerdictSchema = z.object({
  approved: z.boolean(),
  issues: z.array(z.string().min(1).max(300)).max(8).default([]),
});
export type DirectorVisionVerdict = z.infer<typeof DirectorVisionVerdictSchema>;

export const DIRECTOR_DENSITY_BUDGETS = { minimal: 14, standard: 30 } as const;
export type DirectorDensity = keyof typeof DIRECTOR_DENSITY_BUDGETS;

export interface DirectorPolicyInput {
  density: DirectorDensity;
  /** Object ids already visible on the board; new ids must not collide. */
  visibleObjectIds: readonly string[];
}

export type DirectorPolicyResult =
  | { ok: true; ops: AddOp[]; strippedOps: number }
  | { ok: false; reasons: string[] };

/**
 * Deterministic board policy applied to every Director proposal before any
 * headless validation: invalid specs are rejected with reasons, destructive
 * operations (permanence) are stripped, the density budget is enforced, and
 * new object ids must not collide with visible board objects.
 */
export function applyDirectorBoardPolicy(rawOps: unknown, policy: DirectorPolicyInput): DirectorPolicyResult {
  const validated = validateOps(rawOps);
  if (validated.rejected.length > 0) {
    return {
      ok: false,
      reasons: validated.rejected.map((entry) => `Invalid operation: ${entry.reason}`).slice(0, 8),
    };
  }
  // Visible tutor work is permanent: a directed scene only ever adds.
  // Destructive or mutating operations are stripped, never applied.
  const adds = validated.ops.filter((op): op is AddOp => op.op === 'add');
  const strippedOps = validated.ops.length - adds.length;
  if (adds.length === 0) {
    return { ok: false, reasons: ['The scene must add objects; erase, clear, update, and highlight are not available to the Director.'] };
  }
  const budget = DIRECTOR_DENSITY_BUDGETS[policy.density];
  if (adds.length > budget) {
    return { ok: false, reasons: [`The scene has ${adds.length} objects but the ${policy.density} density budget is ${budget}. Simplify it.`] };
  }
  const visible = new Set(policy.visibleObjectIds);
  const collisions = adds.filter((op) => visible.has(op.id)).map((op) => op.id);
  if (collisions.length > 0) {
    return { ok: false, reasons: [`New object ids collide with objects already on the board: ${collisions.slice(0, 8).join(', ')}. Choose fresh ids; never redraw visible objects.`] };
  }
  return { ok: true, ops: adds, strippedOps };
}

/** Assembles and validates the final directed scene (anchor-shaped). */
export function buildDirectedScene(input: {
  groupId: string;
  groupLabel: string;
  ops: BoardOp[];
  storyboard: DirectorProposal['storyboard'];
}): DirectedScene {
  return AnchorSceneSchema.parse({
    groupId: input.groupId,
    groupLabel: input.groupLabel,
    template: null,
    ops: input.ops,
    storyboard: input.storyboard,
  });
}
