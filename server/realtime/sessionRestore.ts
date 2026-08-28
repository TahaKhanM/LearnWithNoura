import { validateOps } from '../../shared/boardOps.js';
import { learnerBoardOps } from '../../shared/learnerSubmissionOps.js';
import { AnchorSceneSchema, type AnchorScene } from '../../shared/compiledLesson.js';
import { LessonBlueprintSchema, type LessonBlueprint } from '../../shared/pedagogy.js';
import { DeliveredTaskSchema, type DeliveredTask } from '../../shared/lessonTurn.js';
import { reduceLesson } from '../lesson/orchestrator.js';
import type { DomainRepository } from '../store/domain.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import { startStoryboardRun, storyboardRunSteps, type StoryboardSource } from './storyboardRunner.js';
import { anchorHandoff, directorHandoff } from './visualRequests.js';

/**
 * Session bootstrap after connect/reconnect: replay the board the child
 * actually saw, restore the durable blueprint and any unanswered task, and
 * hand a cold upstream model the story so far.
 */

type StoredEvents = Awaited<ReturnType<DomainRepository['listEvents']>>;

export async function replayBoard(ctx: CoordinatorContext): Promise<void> {
  // Only marks the child actually saw; ops cancelled mid-speech were
  // never released and must not reappear after a refresh. Stored ops are
  // re-validated so yesterday's data always meets today's rules.
  const events = await ctx.repo.listEvents(ctx.sessionId, 2000);
  const batches = events
    .filter((e) => ['board_ops', 'semantic_scene'].includes(e.type) && e.released)
    .map((e) => {
      const payload = e.payload as { ops?: unknown[]; semanticObjectId?: unknown; groupLabel?: unknown; replacesGroup?: unknown; plan?: { groups?: Array<{ id?: unknown; label?: unknown }> } };
      const ops = validateOps(payload.ops, { tier: 'authored' }).ops;
      const semanticObjectId = typeof payload.semanticObjectId === 'string'
        ? payload.semanticObjectId
        : typeof payload.plan?.groups?.[0]?.id === 'string' ? payload.plan.groups[0].id : undefined;
      const groupLabel = typeof payload.groupLabel === 'string'
        ? payload.groupLabel
        : typeof payload.plan?.groups?.[0]?.label === 'string' ? payload.plan.groups[0].label : undefined;
      return {
        ops,
        ...(semanticObjectId ? { semanticObjectId } : {}),
        ...(groupLabel ? { groupLabel } : {}),
        ...(typeof payload.replacesGroup === 'string' && payload.replacesGroup ? { replacesGroup: payload.replacesGroup } : {}),
      };
    })
    .filter((batch) => batch.ops.length > 0);
  if (batches.length > 0) ctx.sendClient({ type: 'board_replay', batches });
  const learnerBatches = events
    .filter((event) => event.type === 'learner_board' && event.released)
    .map((event) => {
      const payload = event.payload as { ops?: unknown; semanticObjectId?: unknown };
      const ops = learnerBoardOps(payload.ops, { trustPersistedManipulativeUpdates: true });
      return { ops, ...(typeof payload.semanticObjectId === 'string' ? { semanticObjectId: payload.semanticObjectId } : {}) };
    })
    .filter((batch) => batch.ops.length > 0);
  if (learnerBatches.length > 0) ctx.sendClient({ type: 'learner_board_replay', batches: learnerBatches });
  restoreBlueprint(ctx, events);
  await restoreDeliveredTask(ctx, events);
  restoreStoryboardRun(ctx, events);
}

/**
 * A reconnect resumes an in-progress storyboard build: the revealed steps
 * were replayed above as released board truth; the run restarts paused at
 * the first unrevealed step and continues once the resume greeting has
 * played out, with reconnect framing in the next beat.
 */
function restoreStoryboardRun(ctx: CoordinatorContext, events: StoredEvents): void {
  interface StoredProgress { runId: string; source: StoryboardSource; revealedSteps: number; totalSteps: number; status: string }
  let progress: StoredProgress | null = null;
  const directedScenes = new Map<string, AnchorScene>();
  for (const event of events) {
    if (event.type === 'storyboard_progress') {
      const payload = event.payload as Partial<StoredProgress>;
      if (typeof payload.runId === 'string' &&
          (payload.source === 'anchor' || payload.source === 'director') &&
          typeof payload.revealedSteps === 'number' &&
          typeof payload.totalSteps === 'number' &&
          typeof payload.status === 'string') {
        progress = payload as StoredProgress;
      }
    } else if (event.type === 'directed_scene') {
      const payload = event.payload as { runId?: unknown; scene?: unknown };
      const scene = AnchorSceneSchema.safeParse(payload.scene);
      if (typeof payload.runId === 'string' && scene.success) directedScenes.set(payload.runId, scene.data);
    }
  }
  // An active run with every step revealed is a reconnect inside the
  // closing-handoff window: it restores too, so the stage check that had
  // not finished being handed off is recreated rather than lost.
  if (!progress || progress.status !== 'active') return;
  const scene = progress.source === 'anchor'
    ? ctx.compiledLesson?.anchorScene ?? null
    : directedScenes.get(progress.runId) ?? null;
  if (!scene) return;
  ctx.state.visualPlanState = 'rendering';
  startStoryboardRun(ctx, {
    runId: progress.runId,
    source: progress.source,
    groupId: scene.groupId,
    groupLabel: scene.groupLabel,
    steps: storyboardRunSteps(scene),
    revealAfterResponseId: null,
    startPaused: true,
    firstBeatFraming: ['The lesson just resumed after a reconnection. Briefly reconnect to the picture you were building before this beat.'],
    handoff: progress.source === 'anchor' ? anchorHandoff(ctx) : directorHandoff(),
    alreadyRevealedSteps: progress.revealedSteps,
  });
}

/** A refresh resumes the same blueprint at the same stage; the lesson plan
 * is durable and never regenerated by reconnecting. The compiled blueprint
 * is pre-seeded at connect; legacy sessions replay their stored
 * `lesson_blueprint` event. Either way, recorded progress reapplies. */
function restoreBlueprint(ctx: CoordinatorContext, events: StoredEvents): void {
  const preSeeded = ctx.state.lessonState.blueprint;
  let blueprint: LessonBlueprint | null = preSeeded;
  let progress: { currentStageIndex: number; detourStack: LessonBlueprint['detourStack'] } | null = null;
  for (const event of events) {
    if (event.type === 'lesson_blueprint' && !preSeeded) {
      const parsed = LessonBlueprintSchema.safeParse((event.payload as { blueprint?: unknown }).blueprint);
      if (parsed.success) { blueprint = parsed.data; progress = null; }
    } else if (event.type === 'blueprint_progress' && blueprint) {
      const payload = event.payload as { blueprintId?: unknown; currentStageIndex?: unknown; detourStack?: unknown };
      const matches = typeof payload.blueprintId !== 'string' || payload.blueprintId === blueprint.blueprintId;
      if (matches && typeof payload.currentStageIndex === 'number') {
        progress = {
          currentStageIndex: Math.max(0, Math.min(blueprint.stages.length - 1, payload.currentStageIndex)),
          detourStack: Array.isArray(payload.detourStack)
            ? (payload.detourStack as LessonBlueprint['detourStack']).slice(-4)
            : [],
        };
      }
    }
  }
  if (!blueprint) return;
  try {
    if (!preSeeded) {
      ctx.state.lessonState = reduceLesson(ctx.state.lessonState, { type: 'BLUEPRINT_CREATED', blueprint });
    }
    if (progress) {
      ctx.state.lessonState = {
        ...ctx.state.lessonState,
        blueprint: { ...blueprint, currentStageIndex: progress.currentStageIndex, detourStack: progress.detourStack },
      };
    }
  } catch { /* restoring an old blueprint never breaks the live lesson */ }
}

/** After a refresh, an unanswered task must survive: restore the contract
 * and show the banner again rather than losing the learner's turn. */
async function restoreDeliveredTask(ctx: CoordinatorContext, events: StoredEvents): Promise<void> {
  let openTask: DeliveredTask | null = null;
  for (const event of events) {
    if (event.type === 'learner_task') {
      const parsed = DeliveredTaskSchema.safeParse((event.payload as { task?: unknown }).task);
      if (parsed.success) openTask = parsed.data;
    } else if (['learner_said', 'learner_board'].includes(event.type)) openTask = null;
  }
  if (!openTask) return;
  try {
    ctx.state.lessonState = reduceLesson(ctx.state.lessonState, {
      type: 'QUESTION_DELIVERED', taskId: openTask.taskId, text: openTask.prompt, responseMode: openTask.responseMode,
    });
  } catch { /* restoring an old task never breaks the live lesson */ }
  ctx.sendClient({ type: 'learner_task', task: openTask, restored: true });
}

/** After a refresh the upstream model starts cold; hand it the story so far. */
export async function conversationContext(ctx: CoordinatorContext): Promise<string | null> {
  const events = await ctx.repo.listEvents(ctx.sessionId, 2000);
  const lines: string[] = [];
  for (const e of events) {
    const p = e.payload as { text?: string };
    if (e.type === 'tutor_said' && p.text) lines.push(`Tutor: ${p.text}`);
    if (e.type === 'learner_said' && p.text) lines.push(`Learner: ${p.text}`);
  }
  if (lines.length === 0) return null;
  return [
    'This lesson was interrupted by a page reload and is now resuming.',
    'What was said so far (oldest first):',
    ...lines.slice(-40),
    'The board still shows what was drawn. Resume naturally from where things left off — do not start over or repeat the greeting.',
  ].join('\n');
}

export { learnerBoardOps } from '../../shared/learnerSubmissionOps.js';

export function safeBoardImage(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 320_000) return null;
  return /^data:image\/(?:png|jpeg);base64,[a-z0-9+/=]+$/i.test(value) ? value : null;
}
