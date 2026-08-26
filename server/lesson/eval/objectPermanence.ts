import { applyOps, emptyScene, type SceneState } from '../../../src/board/scene.js';
import { RenderedTutorObjectTracker } from '../../../src/board/renderedObjectTracker.js';
import type { ObjectPermanenceFixture } from './types.js';

export type ObjectPermanenceResult = {
  pass: boolean;
  tutorObjectsVisible: string[];
  unexplainedDisappearances: Array<{ objectId: string; cause: string; source: 'board_event' }>;
};

/**
 * Replays production BoardOps through applyOps and scores tutor permanence with
 * RenderedTutorObjectTracker. Tutor erase/clear/same-id overwrite outside
 * announced section navigation fail the gate.
 */
export function scoreObjectPermanence(fixture: ObjectPermanenceFixture): ObjectPermanenceResult {
  const tracker = new RenderedTutorObjectTracker();
  let scene: SceneState = emptyScene;
  const unexplainedDisappearances: ObjectPermanenceResult['unexplainedDisappearances'] = [];
  const navigationByTs = new Map(
    fixture.sectionNavigations.map((entry) => [entry.ts, entry] as const),
  );

  const sortedBatches = [...fixture.boardOpBatches].sort((left, right) => left.ts - right.ts);
  for (const batch of sortedBatches) {
    const navigation = navigationByTs.get(batch.ts);
    const tutorIdsBefore = new Set(
      scene.items.filter((item) => item.owner === 'tutor').map((item) => item.id),
    );

    const applied = applyOps(scene, batch.ops, batch.owner, batch.semanticGroupId);
    scene = applied.scene;

    if (batch.owner === 'tutor' && !navigation) {
      for (const op of batch.ops) {
        if (op.op === 'add' && tutorIdsBefore.has(op.id) && !applied.added.includes(op.id)) {
          unexplainedDisappearances.push({
            objectId: op.id,
            cause: 'tutor_same_id_overwrite_without_navigation',
            source: 'board_event',
          });
        }
      }
    }

    const tutorIds = scene.items.filter((item) => item.owner === 'tutor').map((item) => item.id);
    const disappearances = tracker.observe({
      visibleTutorIds: tutorIds,
      allTutorIds: tutorIds,
      navigation: navigation
        ? {
            previousGroupId: navigation.previousSemanticGroupId,
            nextGroupId: navigation.nextSemanticGroupId,
            cause: 'picker',
          }
        : null,
    });
    for (const disappearance of disappearances) {
      unexplainedDisappearances.push({
        objectId: disappearance.objectId,
        cause: disappearance.cause,
        source: 'board_event',
      });
    }
  }

  return {
    pass: unexplainedDisappearances.length === 0,
    tutorObjectsVisible: scene.items.filter((item) => item.owner === 'tutor').map((item) => item.id).sort(),
    unexplainedDisappearances,
  };
}
