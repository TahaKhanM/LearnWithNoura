import type { BoardOp } from '../../shared/boardOps';
import type { LayoutPreflightResult } from '../../shared/layoutFeedback';
import { inspectScene, repairSceneOnce, type SceneInspection } from './inspection';
import { layoutTutorAnnotations } from './annotationLayout';
import { applyOps, emptyScene, type AppliedOps, type Owner, type SceneState } from './scene';
import { sceneForGroup } from './sceneGroups';
import { resolveRelationalPlacements } from './relationalPlacement';
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

  applyManipulativeDraft(ops: BoardOp[], semanticGroupId?: string): AppliedOps {
    const applied = applyOps(this.value, ops, 'learner', semanticGroupId, { manipulativeDraft: true });
    this.value = applied.scene;
    return applied;
  }

  /**
   * A checkpoint that atomically replaces one section: the scoped clear and
   * the replacement content land in a single committed scene, so there is
   * never a frame where the old diagram is gone and the new one absent.
   */
  applyTutorCheckpoint(ops: BoardOp[], semanticGroupId?: string, replacesGroup?: string): AppliedOps | null {
    const effectiveOps: BoardOp[] = replacesGroup ? [{ op: 'clear' }, ...ops] : ops;
    const scope = replacesGroup ?? semanticGroupId;
    const applied = applyOps(this.value, effectiveOps, 'tutor', scope);
    const fullCandidate = resolveRelationalPlacements(repairStructureBeforePlacement(applied.scene, scope));
    let candidate = layoutTutorAnnotations(scope ? sceneForGroup(fullCandidate, scope) : fullCandidate);
    let inspection = tutorInspection(candidate);
    if (!inspection.accepted) {
      candidate = repairSceneOnce(candidate, inspection);
      inspection = tutorInspection(candidate);
    }
    if (!inspection.accepted) return null;
    const quality = evaluateBoardQuality(candidate);
    this.quality = quality;
    if (!quality.accepted) return null;
    const committed = scope ? mergeScopedScene(fullCandidate, candidate) : candidate;
    this.value = committed;
    return { ...applied, scene: committed };
  }

  /**
   * Compiles and inspects a complete candidate plan offscreen, without
   * touching the visible scene. The model only hears "accepted" for plans
   * whose entire final scene passes deterministic layout and quality checks,
   * so no later checkpoint can fail after earlier ones committed.
   */
  preflightTutorOps(ops: BoardOp[], semanticGroupId?: string, replacesGroup?: string): LayoutPreflightResult {
    const effectiveOps: BoardOp[] = replacesGroup ? [{ op: 'clear' }, ...ops] : ops;
    const scope = replacesGroup ?? semanticGroupId;
    const applied = applyOps(this.value, effectiveOps, 'tutor', scope);
    const placed = resolveRelationalPlacements(repairStructureBeforePlacement(applied.scene, scope));
    let candidate = layoutTutorAnnotations(scope ? sceneForGroup(placed, scope) : placed);
    let inspection = tutorInspection(candidate);
    if (!inspection.accepted) {
      candidate = repairSceneOnce(candidate, inspection);
      inspection = tutorInspection(candidate);
    }
    if (!inspection.accepted) {
      return {
        accepted: false,
        reasons: inspection.issues.slice(0, 8).map((issue) => `${issue.code}:${issue.itemId}${issue.withItemId ? `:${issue.withItemId}` : ''}`),
        layoutIssues: inspection.issues.slice(0, 8).map((issue) => ({
          code: issue.code,
          itemId: issue.itemId,
          ...(issue.withItemId ? { withItemId: issue.withItemId } : {}),
          ...(issue.itemBounds ? { itemBounds: issue.itemBounds } : {}),
          ...(issue.withItemBounds ? { withItemBounds: issue.withItemBounds } : {}),
        })),
      };
    }
    const quality = evaluateBoardQuality(candidate);
    return quality.accepted
      ? { accepted: true, reasons: [], layoutIssues: [] }
      : { accepted: false, reasons: quality.reasons.slice(0, 8), layoutIssues: quality.layoutIssues.slice(0, 8) };
  }

  applyReplay(ops: BoardOp[], owner: Owner, semanticGroupId?: string, replacesGroup?: string): AppliedOps | null {
    if (owner === 'learner') {
      const hasManipulative = ops.some((op) => op.op === 'update');
      const applied = hasManipulative
        ? applyOps(this.value, ops, owner, semanticGroupId, { manipulativeDraft: true })
        : applyOps(this.value, ops, owner, semanticGroupId);
      this.value = applied.scene;
      return applied;
    }
    // Released replay is historical visible truth. Re-run deterministic
    // annotation layout under current code, but never make an older accepted
    // section disappear because today's quality budget became stricter.
    const effectiveOps: BoardOp[] = replacesGroup ? [{ op: 'clear' }, ...ops] : ops;
    const scope = replacesGroup ?? semanticGroupId;
    const applied = applyOps(this.value, effectiveOps, 'tutor', scope, { tier: 'authored' });
    const placed = resolveRelationalPlacements(repairStructureBeforePlacement(applied.scene, scope));
    const scoped = layoutTutorAnnotations(scope ? sceneForGroup(placed, scope) : placed);
    const committed = scope ? mergeScopedScene(placed, scoped) : scoped;
    this.value = committed;
    return { ...applied, scene: committed };
  }
}

function repairStructureBeforePlacement(scene: SceneState, scope?: string): SceneState {
  if (!scene.items.some((item) => item.place)) return scene;
  const structure = { ...scene, items: scene.items.filter((item) => !item.place) };
  const scoped = scope ? sceneForGroup(structure, scope) : structure;
  const inspection = tutorInspection(scoped);
  if (inspection.accepted) return scene;
  const repaired = repairSceneOnce(scoped, inspection);
  const byId = new Map(repaired.items.map((item) => [item.id, item]));
  return { ...scene, items: scene.items.map((item) => byId.get(item.id) ?? item) };
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
