import { z } from 'zod';
import { validateOps, type BoardOp } from './boardOps.js';
import { LessonBlueprintSchema } from './pedagogy.js';
import { VisualTemplateSchema } from './semanticScene.js';

/**
 * The compiled lesson: everything a strong reasoning model authored at
 * session creation, validated before the realtime session may consume it.
 * The realtime tutor executes this artifact; it never authors one.
 */

export const COMPILED_LESSON_SCHEMA_VERSION = '1.0.0' as const;

export const CandidateObjectiveSchema = z.object({
  id: z.string().min(1).max(80),
  objective: z.string().min(1).max(240),
  description: z.string().min(1).max(300),
});
export type CandidateObjective = z.infer<typeof CandidateObjectiveSchema>;

/** Normalizing a parent goal yields one teachable objective, or two to
 * three candidates when the goal is too vague to compile directly. */
export const NormalizedGoalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('objective'), objective: z.string().min(1).max(240) }),
  z.object({ kind: z.literal('candidates'), candidates: z.array(CandidateObjectiveSchema).min(2).max(3) }),
]);
export type NormalizedGoal = z.infer<typeof NormalizedGoalSchema>;

export const StoryboardRevealSchema = z.enum(['outline', 'relation', 'label', 'connector', 'emphasis']);

/** One ordered reveal step: the objects it uncovers plus the narration beat
 * the tutor speaks over it. */
export const StoryboardStepSchema = z.object({
  id: z.string().min(1).max(120),
  reveal: StoryboardRevealSchema,
  narration: z.string().min(1).max(400),
  objectIds: z.array(z.string().min(1).max(160)).min(1).max(24),
});
export type StoryboardStep = z.infer<typeof StoryboardStepSchema>;

const AnchorOpsSchema = z.custom<BoardOp[]>((value) => Array.isArray(value), 'ops must be an array');

/** The pre-validated anchor scene for a board-led lesson: final BoardOps
 * (template-generated or raw) plus the storyboard that reveals them. */
export const AnchorSceneSchema = z.object({
  groupId: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/i),
  groupLabel: z.string().min(1).max(160),
  /** The semantic template the ops came from; null for raw validated ops. */
  template: VisualTemplateSchema.nullable(),
  ops: AnchorOpsSchema,
  storyboard: z.array(StoryboardStepSchema).min(1).max(8),
}).superRefine((anchor, context) => {
  const validated = validateOps(anchor.ops);
  if (validated.rejected.length > 0 || validated.ops.length !== anchor.ops.length || anchor.ops.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['ops'],
      message: `Anchor ops failed board validation: ${validated.rejected.map((entry) => entry.reason).join('; ') || 'no valid operations'}`.slice(0, 300),
    });
    return;
  }
  if (validated.ops.some((op) => op.op !== 'add')) {
    context.addIssue({ code: 'custom', path: ['ops'], message: 'An anchor scene is built from add operations only.' });
    return;
  }
  const addIds = new Set(validated.ops.map((op) => op.op === 'add' ? op.id : '').filter(Boolean));
  const covered = new Set<string>();
  const stepIds = new Set<string>();
  for (const [index, step] of anchor.storyboard.entries()) {
    if (stepIds.has(step.id)) {
      context.addIssue({ code: 'custom', path: ['storyboard', index, 'id'], message: 'Storyboard step ids must be unique.' });
    }
    stepIds.add(step.id);
    for (const objectId of step.objectIds) {
      if (!addIds.has(objectId)) {
        context.addIssue({ code: 'custom', path: ['storyboard', index, 'objectIds'], message: `Storyboard references ${objectId}, which the anchor ops do not add.` });
      } else if (covered.has(objectId)) {
        context.addIssue({ code: 'custom', path: ['storyboard', index, 'objectIds'], message: `Object ${objectId} is revealed by more than one storyboard step.` });
      }
      covered.add(objectId);
    }
  }
  for (const id of addIds) {
    if (!covered.has(id)) {
      context.addIssue({ code: 'custom', path: ['storyboard'], message: `Anchor object ${id} is not revealed by any storyboard step.` });
    }
  }
});
export type AnchorScene = z.infer<typeof AnchorSceneSchema>;

export const CompiledLessonSchema = z.object({
  compiledLessonId: z.string().min(1).max(120),
  schemaVersion: z.literal(COMPILED_LESSON_SCHEMA_VERSION),
  /** The parent's goal as typed, preserved for display and audit. */
  goal: z.string().min(1).max(300),
  /** The one concrete teachable objective the lesson was compiled for. */
  objective: z.string().min(1).max(240),
  blueprint: LessonBlueprintSchema,
  anchorScene: AnchorSceneSchema.nullable(),
  compiledAt: z.number().int().nonnegative(),
  compilerModel: z.string().min(1).max(120),
}).superRefine((lesson, context) => {
  if (lesson.blueprint.mode === 'board_led') {
    if (!lesson.anchorScene) {
      context.addIssue({ code: 'custom', path: ['anchorScene'], message: 'A board-led compiled lesson requires a validated anchor scene.' });
    } else if (lesson.blueprint.anchor && lesson.anchorScene.groupId !== lesson.blueprint.anchor.semanticGroupId) {
      context.addIssue({ code: 'custom', path: ['anchorScene', 'groupId'], message: 'The anchor scene must build the blueprint anchor section.' });
    }
  } else if (lesson.anchorScene) {
    context.addIssue({ code: 'custom', path: ['anchorScene'], message: 'A conversation-led lesson carries no forced visuals.' });
  }
});
export type CompiledLesson = z.infer<typeof CompiledLessonSchema>;

export type CompiledLessonStatus = 'pending' | 'ready' | 'failed';

/** The durable compilation state for one session, as both repos store it. */
export interface CompiledLessonRecord {
  sessionId: string;
  status: CompiledLessonStatus;
  lesson: CompiledLesson | null;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

/** One compilation progress write: pending, ready (with lesson), or failed. */
export interface CompiledLessonUpdate {
  status: CompiledLessonStatus;
  lesson?: CompiledLesson | null;
  failureReason?: string | null;
}
