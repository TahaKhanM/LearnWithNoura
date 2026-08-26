import type { DeliveredTask } from '../../shared/lessonTurn.js';
import {
  evaluateManipulativeCheck,
  type ManipulativeCheck,
  type ManipulativeCheckResult,
  type ManipulativeSceneItem,
} from '../../shared/manipulativeCheck.js';
import { currentStage, type LessonOrchestrationState } from '../lesson/orchestrator.js';

/**
 * Looks up the server-owned manipulative check for a submitted task.
 * Client-supplied check specs are never trusted.
 */
export function serverOwnedManipulativeCheck(input: {
  taskId?: string;
  lessonState: LessonOrchestrationState;
  pendingTask: DeliveredTask | null;
}): ManipulativeCheck | null {
  const taskId = input.taskId?.trim();
  if (!taskId) return null;

  if (input.pendingTask?.taskId === taskId && input.pendingTask.manipulativeCheck) {
    return input.pendingTask.manipulativeCheck;
  }

  const stage = currentStage(input.lessonState);
  const stageCheck = stage?.checks?.find((check) => check.id === taskId);
  if (stageCheck?.manipulativeCheck) return stageCheck.manipulativeCheck;

  const blueprint = input.lessonState.blueprint;
  if (!blueprint) return null;
  for (const candidate of blueprint.stages) {
    const check = candidate.checks?.find((entry) => entry.id === taskId);
    if (check?.manipulativeCheck) return check.manipulativeCheck;
  }
  for (const detour of blueprint.detourStack) {
    for (const candidate of detour.plan?.stages ?? []) {
      const check = candidate.checks?.find((entry) => entry.id === taskId);
      if (check?.manipulativeCheck) return check.manipulativeCheck;
    }
  }
  return null;
}

export function evaluateBoardSubmissionCheck(input: {
  taskId?: string;
  clientCheck?: ManipulativeCheck | null;
  lessonState: LessonOrchestrationState;
  pendingTask: DeliveredTask | null;
  items: ManipulativeSceneItem[];
}): (ManipulativeCheckResult & { check: ManipulativeCheck; localCheckPassed: boolean }) | null {
  void input.clientCheck;
  const check = serverOwnedManipulativeCheck(input);
  if (!check) return null;
  const result = evaluateManipulativeCheck({ check, items: input.items });
  return { ...result, check, localCheckPassed: result.passed };
}
