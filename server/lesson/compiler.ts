import { z } from 'zod';
import { validateOps, type BoardOp } from '../../shared/boardOps.js';
import {
  AnchorSceneSchema,
  CompiledLessonSchema,
  COMPILED_LESSON_SCHEMA_VERSION,
  NormalizedGoalSchema,
  StoryboardStepSchema,
  type AnchorScene,
  type CompiledLesson,
  type NormalizedGoal,
} from '../../shared/compiledLesson.js';
import { LessonStageSchema, type LessonStage } from '../../shared/pedagogy.js';
import {
  SemanticScenePlanSchema,
  VISUAL_PLAN_VERSION,
  VisualTemplateSchema,
  adaptSemanticScene,
} from '../../shared/semanticScene.js';
import { AUTHOR_LESSON_PROMPT, DETOUR_PLAN_PROMPT, NORMALIZE_GOAL_PROMPT } from './compilerPrompts.js';

/**
 * The lesson compiler: a strong reasoning model authors a complete lesson at
 * session creation; every board scene is validated before it is stored. The
 * realtime session executes the result and never authors one.
 */

export interface AuthoringChatClient {
  /** One Chat Completions round trip returning the reply text, or null. */
  complete(request: { messages: { role: 'system' | 'user'; content: string }[] }): Promise<string | null>;
}

export type SceneValidationResult = { ok: true } | { ok: false; issues: string[] };
/** Validates final BoardOps through the real client render pipeline. */
export type SceneValidator = (ops: BoardOp[]) => Promise<SceneValidationResult>;

export interface LessonCompilerDeps {
  client: AuthoringChatClient;
  validateScene: SceneValidator;
  /** Recorded in the compiled artifact for audit; the client owns the call. */
  compilerModel: string;
  /** Bounded self-correction attempts after the first rejection. Default 2. */
  maxSceneRetries?: number;
  now?: () => number;
}

export interface CompileLessonInput {
  /** Stable seed for artifact ids; the session id in production. */
  lessonKey: string;
  goal: string;
  objective: string;
  learnerName?: string;
  learnerAge?: number | null;
}

export class LessonCompileError extends Error {
  readonly reasons: string[];
  constructor(message: string, reasons: string[]) {
    super(message);
    this.name = 'LessonCompileError';
    this.reasons = reasons;
  }
}

const ANCHOR_GROUP_ID = 'lesson-anchor';

const RevealNarrationsSchema = z.object({
  outline: z.string().min(1).max(400),
  relation: z.string().min(1).max(400),
  label: z.string().min(1).max(400),
  connector: z.string().min(1).max(400),
  emphasis: z.string().min(1).max(400),
});

const AnchorDomainSchema = z.enum([
  'geometry', 'quantitative', 'algebra', 'comparison', 'process',
  'argument', 'history', 'grammar', 'table', 'timeline',
]);

const AuthoredTemplateAnchorSchema = z.object({
  kind: z.literal('template'),
  domain: AnchorDomainSchema,
  groupLabel: z.string().min(1).max(160),
  template: VisualTemplateSchema.exclude(['no_board']),
  parameters: z.record(z.string(), z.unknown()).default({}),
  instructionalQuestion: z.string().min(1).max(300),
  narrations: RevealNarrationsSchema,
});

const AuthoredRawAnchorSchema = z.object({
  kind: z.literal('raw'),
  domain: AnchorDomainSchema,
  groupLabel: z.string().min(1).max(160),
  instructionalQuestion: z.string().min(1).max(300),
  ops: z.array(z.unknown()).min(1).max(40),
  storyboard: z.array(StoryboardStepSchema).min(1).max(8),
});

const AuthoredLessonSchema = z.object({
  mode: z.enum(['board_led', 'conversation_led']),
  successCriteria: z.array(z.string().min(1).max(240)).min(1).max(4),
  stages: z.array(LessonStageSchema).min(3).max(5),
  anchor: z.discriminatedUnion('kind', [AuthoredTemplateAnchorSchema, AuthoredRawAnchorSchema]).nullable(),
}).superRefine((lesson, context) => {
  if (lesson.mode === 'board_led' && !lesson.anchor) {
    context.addIssue({ code: 'custom', path: ['anchor'], message: 'A board-led lesson requires one anchor scene.' });
  }
  if (lesson.mode === 'conversation_led' && lesson.anchor) {
    context.addIssue({ code: 'custom', path: ['anchor'], message: 'A conversation-led lesson carries no anchor scene.' });
  }
  if (!lesson.stages.some((stage) => (stage.checks?.length ?? 0) > 0)) {
    context.addIssue({ code: 'custom', path: ['stages'], message: 'At least one stage must carry an exact check question.' });
  }
});
type AuthoredLesson = z.infer<typeof AuthoredLessonSchema>;

const DetourResponseSchema = z.object({
  stages: z.array(LessonStageSchema).min(1).max(2),
}).superRefine((response, context) => {
  for (const [index, stage] of response.stages.entries()) {
    if (!['none', 'extend', 'emphasize'].includes(stage.allowedBoardMutation)) {
      context.addIssue({ code: 'custom', path: ['stages', index, 'allowedBoardMutation'], message: 'A detour never redraws the anchor; use none, extend, or emphasize.' });
    }
  }
});

export async function normalizeGoal(
  deps: LessonCompilerDeps,
  input: { goal: string; learnerName?: string; learnerAge?: number | null },
): Promise<NormalizedGoal> {
  return requestValidated(deps, NormalizedGoalSchema, NORMALIZE_GOAL_PROMPT, learnerContext(input) + `Parent goal: ${input.goal}`, 'Goal normalization', 2);
}

export async function compileLesson(deps: LessonCompilerDeps, input: CompileLessonInput): Promise<CompiledLesson> {
  const attempts = 1 + Math.max(0, deps.maxSceneRetries ?? 2);
  const userContent = `${learnerContext(input)}Objective: ${input.objective}\nParent goal as typed: ${input.goal}`;
  let feedback: string[] = [];
  let lastDraft: AuthoredLesson | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let draft: AuthoredLesson;
    try {
      draft = await requestValidated(deps, AuthoredLessonSchema, AUTHOR_LESSON_PROMPT, withFeedback(userContent, feedback), 'Lesson authorship', 1);
    } catch (error) {
      feedback = reasonsOf(error);
      continue;
    }
    lastDraft = draft;
    try {
      return await assembleAndValidate(deps, input, draft);
    } catch (error) {
      feedback = reasonsOf(error);
    }
  }

  // Self-correction is exhausted. First try the same template with its
  // known-good default parameters; then fall back to conversation-led.
  // An invalid lesson is never produced.
  if (lastDraft?.anchor?.kind === 'template') {
    try {
      return await assembleAndValidate(deps, input, {
        ...lastDraft,
        anchor: { ...lastDraft.anchor, parameters: {} },
      });
    } catch (error) {
      feedback = [...feedback, ...reasonsOf(error)];
    }
  }
  if (lastDraft) {
    try {
      return await assembleAndValidate(deps, input, conversationFallback(lastDraft));
    } catch (error) {
      feedback = [...feedback, ...reasonsOf(error)];
    }
  }
  throw new LessonCompileError('Lesson compilation failed after bounded retries.', feedback);
}

/** Authors a bounded detour mini-plan for a live prerequisite gap. */
export async function compileDetourStages(
  deps: LessonCompilerDeps,
  input: { objective: string; reason: string; returnStageObjective: string; learnerAge?: number | null },
): Promise<LessonStage[]> {
  const content = `${learnerContext(input)}Lesson objective: ${input.objective}\nPrerequisite gap observed: ${input.reason}\nThe tutor will return to this stage afterwards: ${input.returnStageObjective}`;
  const response = await requestValidated(deps, DetourResponseSchema, DETOUR_PLAN_PROMPT, content, 'Detour planning', 2);
  return response.stages;
}

async function assembleAndValidate(deps: LessonCompilerDeps, input: CompileLessonInput, draft: AuthoredLesson): Promise<CompiledLesson> {
  const anchorScene = draft.anchor ? buildAnchorScene(input, draft.anchor) : null;
  if (anchorScene) {
    const verdict = await deps.validateScene(anchorScene.ops);
    if (!verdict.ok) throw new LessonCompileError('Scene validation rejected the anchor scene.', verdict.issues);
  }
  return CompiledLessonSchema.parse({
    compiledLessonId: `compiled-${input.lessonKey}`,
    schemaVersion: COMPILED_LESSON_SCHEMA_VERSION,
    goal: input.goal.slice(0, 300),
    objective: input.objective.slice(0, 240),
    blueprint: {
      blueprintId: `blueprint-${input.lessonKey}`,
      goal: input.objective.slice(0, 300),
      mode: draft.mode,
      successCriteria: draft.successCriteria,
      anchor: anchorScene && draft.anchor
        ? {
            semanticGroupId: anchorScene.groupId,
            template: anchorScene.template ?? 'raw_ops',
            instructionalQuestion: draft.anchor.instructionalQuestion,
            invariantObjectIds: [],
          }
        : null,
      stages: draft.stages,
      currentStageIndex: 0,
      detourStack: [],
    },
    anchorScene,
    compiledAt: (deps.now ?? Date.now)(),
    compilerModel: deps.compilerModel,
  });
}

function buildAnchorScene(input: CompileLessonInput, anchor: NonNullable<AuthoredLesson['anchor']>): AnchorScene {
  if (anchor.kind === 'raw') {
    const validated = validateOps(anchor.ops as BoardOp[], { tier: 'authored' });
    if (validated.rejected.length > 0 || validated.ops.length !== anchor.ops.length) {
      throw new LessonCompileError('Raw anchor ops failed board validation.', validated.rejected.map((entry) => entry.reason));
    }
    if (validated.ops.some((op) => op.op === 'add' && op.spec.kind === 'image')) {
      throw new LessonCompileError('Raw anchor ops failed board validation.', [
        'image ops are Director-time only; the compiler cannot invent an assetId',
      ]);
    }
    return AnchorSceneSchema.parse({
      groupId: ANCHOR_GROUP_ID,
      groupLabel: anchor.groupLabel,
      template: null,
      ops: validated.ops,
      storyboard: anchor.storyboard,
    });
  }
  const plan = SemanticScenePlanSchema.parse({
    schemaVersion: VISUAL_PLAN_VERSION,
    planId: `compiled-${input.lessonKey}`,
    intent: {
      objective: input.objective.slice(0, 300),
      domain: anchor.domain,
      relevance: 'essential',
      questionAnswered: anchor.instructionalQuestion,
      rationale: 'Pre-compiled anchor scene authored by the lesson compiler.',
      action: 'establish',
      density: 'minimal',
    },
    groups: [{
      id: ANCHOR_GROUP_ID,
      label: anchor.groupLabel,
      revealOrder: ['outline', 'relation', 'label', 'connector', 'emphasis'],
      template: anchor.template,
      parameters: anchor.parameters,
    }],
  });
  const { ops, checkpoints } = adaptSemanticScene(plan);
  const storyboard = checkpoints.map((checkpoint) => ({
    id: checkpoint.id,
    reveal: checkpoint.reveal,
    narration: anchor.narrations[checkpoint.reveal],
    objectIds: checkpoint.ops.flatMap((op) => (op.op === 'add' ? [op.id] : [])),
  }));
  return AnchorSceneSchema.parse({
    groupId: ANCHOR_GROUP_ID,
    groupLabel: anchor.groupLabel,
    template: anchor.template,
    ops,
    storyboard,
  });
}

function conversationFallback(draft: AuthoredLesson): AuthoredLesson {
  return {
    mode: 'conversation_led',
    successCriteria: draft.successCriteria,
    anchor: null,
    stages: draft.stages.map((stage) => ({
      ...stage,
      boardPurpose: 'none',
      allowedBoardMutation: 'none',
      checks: stage.checks?.map((check) => ({ ...check, targetObjectIds: undefined })),
    })),
  };
}

async function requestValidated<Schema extends z.ZodType>(
  deps: LessonCompilerDeps,
  schema: Schema,
  systemPrompt: string,
  userContent: string,
  label: string,
  attempts: number,
): Promise<z.infer<Schema>> {
  const feedback: string[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const content = await deps.client.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: withFeedback(userContent, feedback) },
      ],
    });
    if (!content) {
      feedback.push('The model returned an empty reply.');
      continue;
    }
    try {
      return schema.parse(JSON.parse(content)) as z.infer<Schema>;
    } catch (error) {
      feedback.push(describeError(error));
    }
  }
  throw new LessonCompileError(`${label} failed validation after ${attempts} attempt(s).`, feedback);
}

function withFeedback(userContent: string, feedback: string[]): string {
  if (feedback.length === 0) return userContent;
  return `${userContent}\n\nYour previous reply was rejected for these reasons:\n${feedback.map((reason) => `- ${reason}`).join('\n')}\nFix every problem and reply again with JSON only.`;
}

function learnerContext(input: { learnerName?: string; learnerAge?: number | null }): string {
  const name = input.learnerName ? `Learner: ${input.learnerName}` : 'Learner: unnamed child';
  const age = input.learnerAge ? `, age ${input.learnerAge}` : '';
  return `${name}${age}\n`;
}

function reasonsOf(error: unknown): string[] {
  if (error instanceof LessonCompileError) return error.reasons.length > 0 ? error.reasons : [error.message];
  return [describeError(error)];
}

function describeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`).join('; ').slice(0, 600);
  }
  return String(error instanceof Error ? error.message : error).slice(0, 600);
}
