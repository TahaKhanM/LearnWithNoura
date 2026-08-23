import type { BoardOp } from '../../shared/boardOps';
import { inspectScene, repairSceneOnce, type SceneInspection } from './inspection';
import { layoutTutorAnnotations } from './annotationLayout';
import { applyOps, emptyScene, type AppliedOps, type Owner, type SceneState } from './scene';
import { sceneForGroup } from './sceneGroups';
import { evaluateBoardQuality, type BoardQualityReport } from './quality';

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
  private quality: BoardQualityReport | null = null;

  constructor(initial: SceneState = emptyScene) {
    this.value = initial;
  }

  get current(): SceneState {
    return this.value;
  }

  get lastQualityReport(): BoardQualityReport | null { return this.quality; }

  applyLearner(ops: BoardOp[], semanticGroupId?: string): AppliedOps {
    const applied = applyOps(this.value, ops, 'learner', semanticGroupId);
    this.value = applied.scene;
    return applied;
  }

  applyTutorCheckpoint(ops: BoardOp[], semanticGroupId?: string): AppliedOps | null {
    const applied = applyOps(this.value, ops, 'tutor', semanticGroupId);
    const fullCandidate = applied.scene;
    let candidate = layoutTutorAnnotations(semanticGroupId ? sceneForGroup(fullCandidate, semanticGroupId) : fullCandidate);
    let inspection = tutorInspection(candidate);
    if (!inspection.accepted) {
      candidate = repairSceneOnce(candidate, inspection);
      inspection = tutorInspection(candidate);
    }
    if (!inspection.accepted) return null;
    const quality = evaluateBoardQuality(candidate);
    this.quality = quality;
    if (!quality.accepted) return null;
    const committed = semanticGroupId ? mergeScopedScene(fullCandidate, candidate) : candidate;
    this.value = committed;
    return { ...applied, scene: committed };
  }

  applyReplay(ops: BoardOp[], owner: Owner, semanticGroupId?: string): AppliedOps | null {
    if (owner === 'learner') return this.applyLearner(ops, semanticGroupId);
    // Released replay is historical visible truth. Re-run deterministic
    // annotation layout under current code, but never make an older accepted
    // section disappear because today's quality budget became stricter.
    const applied = applyOps(this.value, ops, 'tutor', semanticGroupId);
    const scoped = layoutTutorAnnotations(semanticGroupId ? sceneForGroup(applied.scene, semanticGroupId) : applied.scene);
    const committed = semanticGroupId ? mergeScopedScene(applied.scene, scoped) : scoped;
    this.value = committed;
    return { ...applied, scene: committed };
  }
}

function mergeScopedScene(full: SceneState, scoped: SceneState): SceneState {
  const replacements = new Map(scoped.items.map((item) => [item.id, item]));
  return { ...full, items: full.items.map((item) => replacements.get(item.id) ?? item) };
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
