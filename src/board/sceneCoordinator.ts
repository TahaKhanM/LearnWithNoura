import type { BoardOp } from '../../shared/boardOps';
import { inspectScene, repairSceneOnce, type SceneInspection } from './inspection';
import { layoutTutorAnnotations } from './annotationLayout';
import { applyOps, emptyScene, type AppliedOps, type Owner, type SceneItem, type SceneState } from './scene';
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
    const fullCandidate = applied.scene;
    const prepared = prepareTutorCandidate(scope ? sceneForGroup(fullCandidate, scope) : fullCandidate);
    const { candidate, inspection } = prepared;
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
  preflightTutorOps(ops: BoardOp[], semanticGroupId?: string, replacesGroup?: string): { accepted: boolean; reasons: string[] } {
    const effectiveOps: BoardOp[] = replacesGroup ? [{ op: 'clear' }, ...ops] : ops;
    const scope = replacesGroup ?? semanticGroupId;
    const applied = applyOps(this.value, effectiveOps, 'tutor', scope);
    const { candidate, inspection } = prepareTutorCandidate(
      scope ? sceneForGroup(applied.scene, scope) : applied.scene,
    );
    if (!inspection.accepted) {
      return { accepted: false, reasons: inspection.issues.slice(0, 8).map((issue) => `${issue.kind}:${issue.itemId}${issue.withItemId ? `:${issue.withItemId}` : ''}`) };
    }
    const quality = evaluateBoardQuality(candidate);
    return quality.accepted ? { accepted: true, reasons: [] } : { accepted: false, reasons: quality.reasons.slice(0, 8) };
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
    const scoped = layoutTutorAnnotations(scope ? sceneForGroup(applied.scene, scope) : applied.scene);
    const committed = scope ? mergeScopedScene(applied.scene, scoped) : scoped;
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

const EXTRA_LAYOUT_REPAIR_CYCLES = 2;
const CONVERGENCE_SAFE_KINDS = new Set<SceneItem['spec']['kind']>([
  'text',
  'equation',
  'box',
]);

/**
 * Runs the existing layout + one repair unchanged, then resolves at most two
 * repair-induced annotation dependencies. The extra cycles are permitted
 * only while every failing tutor item is movable/non-semantic; measured
 * geometry (points, axes, plots, angles, marks, and strokes) is never shifted
 * merely to make a scene pass.
 */
function prepareTutorCandidate(scene: SceneState): {
  candidate: SceneState;
  inspection: SceneInspection;
} {
  let candidate = layoutTutorAnnotations(scene);
  let inspection = tutorInspection(candidate);
  if (inspection.accepted) return { candidate, inspection };

  candidate = repairSceneOnce(candidate, inspection);
  inspection = tutorInspection(candidate);
  if (inspection.accepted) return { candidate, inspection };

  for (let cycle = 0; cycle < EXTRA_LAYOUT_REPAIR_CYCLES; cycle += 1) {
    if (!onlyConvergenceSafeIssues(candidate, inspection)) break;
    candidate = layoutTutorAnnotations(candidate);
    inspection = tutorInspection(candidate);
    if (inspection.accepted) break;
    if (!onlyConvergenceSafeIssues(candidate, inspection)) break;
    candidate = repairSceneOnce(candidate, inspection);
    inspection = tutorInspection(candidate);
    if (inspection.accepted) break;
  }
  return { candidate, inspection };
}

function onlyConvergenceSafeIssues(scene: SceneState, inspection: SceneInspection): boolean {
  const byId = new Map(scene.items.map((item) => [item.id, item]));
  return inspection.issues.length > 0 && inspection.issues.every((issue) => {
    const item = byId.get(issue.itemId);
    return item?.owner === 'tutor' && CONVERGENCE_SAFE_KINDS.has(item.spec.kind);
  });
}
