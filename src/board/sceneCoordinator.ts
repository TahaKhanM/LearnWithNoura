import type { BoardOp } from '../../shared/boardOps';
import { inspectScene, repairSceneOnce, type SceneInspection } from './inspection';
import { layoutTutorAnnotations } from './annotationLayout';
import { applyOps, emptyScene, type AppliedOps, type Owner, type SceneState } from './scene';

/**
 * Owns the board state that is already true on screen.
 *
 * Draw-on animation is presentation only: once an accepted tutor checkpoint is
 * released from the heard-audio timeline, learner input and later checkpoints
 * must build on it immediately. Durable server replay is acknowledged
 * separately after the animation finishes.
 */
export class BoardSceneCoordinator {
  private value: SceneState;

  constructor(initial: SceneState = emptyScene) {
    this.value = initial;
  }

  get current(): SceneState {
    return this.value;
  }

  applyLearner(ops: BoardOp[]): AppliedOps {
    const applied = applyOps(this.value, ops, 'learner');
    this.value = applied.scene;
    return applied;
  }

  applyTutorCheckpoint(ops: BoardOp[]): AppliedOps | null {
    const applied = applyOps(this.value, ops, 'tutor');
    let candidate = layoutTutorAnnotations(applied.scene);
    let inspection = tutorInspection(candidate);
    if (!inspection.accepted) {
      candidate = repairSceneOnce(candidate, inspection);
      inspection = tutorInspection(candidate);
    }
    if (!inspection.accepted) return null;
    this.value = candidate;
    return { ...applied, scene: candidate };
  }

  applyReplay(ops: BoardOp[], owner: Owner): AppliedOps | null {
    return owner === 'learner' ? this.applyLearner(ops) : this.applyTutorCheckpoint(ops);
  }
}

/** Learner strokes are intentional input, including marks near an edge or on
 * top of an existing object. Tutor inspection may adapt tutor geometry around
 * them, but it never rejects, translates, or erases the learner layer. */
function tutorInspection(scene: SceneState): SceneInspection {
  const inspection = inspectScene(scene);
  const ownerById = new Map(scene.items.map((item) => [item.id, item.owner]));
  const issues = inspection.issues.filter((issue) => ownerById.get(issue.itemId) === 'tutor');
  return { accepted: issues.length === 0, issues };
}
