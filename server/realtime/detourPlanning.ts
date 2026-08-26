import type { LessonStage } from '../../shared/pedagogy.js';
import { reduceLesson } from '../lesson/orchestrator.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import { refreshBoardInstructions } from './sessionConfig.js';

/**
 * Bounded mid-lesson replanning. When evidence classification records a
 * missing prerequisite (a deterministic server decision, not a model whim),
 * the compiler is asked for a one-to-two-stage detour mini-plan while the
 * tutor bridges verbally. The plan upgrades the simple detour entry that
 * evidence already pushed; a timeout or failure leaves that simple detour
 * standing, and the lesson always returns to the recorded stage.
 */

export const DETOUR_PLAN_TIMEOUT_MS = 8_000;

function withTimeout(promise: Promise<LessonStage[]>, timeoutMs: number): Promise<LessonStage[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Detour planning timed out.')), timeoutMs);
    timer.unref?.();
    promise.then(
      (stages) => { clearTimeout(timer); resolve(stages); },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

export function schedulePlannedDetour(ctx: CoordinatorContext): void {
  const blueprint = ctx.state.lessonState.blueprint;
  const planDetour = ctx.planDetour;
  if (!blueprint || !planDetour) return;
  const top = blueprint.detourStack[blueprint.detourStack.length - 1];
  if (!top || top.plan) return;
  const snapshot = { reason: top.reason, returnStageIndex: top.returnStageIndex, depth: blueprint.detourStack.length };
  const returnStage = blueprint.stages[Math.min(top.returnStageIndex, blueprint.stages.length - 1)];
  const task = (async () => {
    let stages: LessonStage[];
    try {
      stages = await withTimeout(planDetour({
        objective: ctx.compiledLesson?.objective ?? blueprint.goal,
        reason: snapshot.reason,
        returnStageObjective: returnStage.objective,
      }), ctx.detourPlanTimeoutMs);
    } catch (error) {
      ctx.log(`session ${ctx.sessionId}: detour planning fell back to the simple detour (${String(error).slice(0, 160)})`);
      return;
    }
    // The lesson moved on while the plan was authored? Apply it only if the
    // very same simple detour is still open; otherwise the plan is stale.
    const live = ctx.state.lessonState.blueprint;
    const liveTop = live?.detourStack[live.detourStack.length - 1];
    if (!live || !liveTop || liveTop.plan ||
        live.detourStack.length !== snapshot.depth ||
        liveTop.reason !== snapshot.reason ||
        liveTop.returnStageIndex !== snapshot.returnStageIndex) return;
    try {
      ctx.state.lessonState = reduceLesson(ctx.state.lessonState, { type: 'DETOUR_PLANNED', reason: snapshot.reason, stages });
    } catch (error) {
      ctx.log(`session ${ctx.sessionId}: detour plan rejected (${String(error).slice(0, 160)})`);
      return;
    }
    const updated = ctx.state.lessonState.blueprint;
    if (!updated) return;
    await ctx.repo.addEvent(ctx.sessionId, 'blueprint_progress', {
      blueprintId: updated.blueprintId,
      currentStageIndex: updated.currentStageIndex,
      detourStack: updated.detourStack,
    });
    // The injected stage context now describes the detour stage.
    refreshBoardInstructions(ctx);
  })();
  ctx.trackSideEffect(task);
}
