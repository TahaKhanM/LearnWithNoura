import type { ObjectPermanenceFixture } from './types.js';

export type ObjectPermanenceResult = {
  pass: boolean;
  tutorObjectsVisible: string[];
  unexplainedDisappearances: Array<{ objectId: string; cause: string; source: 'board_event' | 'metric' }>;
};

/**
 * Reconstructs tutor object permanence from a released-board event log.
 * Tutor removals outside announced section navigation or disappearance metrics fail the gate.
 */
export function scoreObjectPermanence(fixture: ObjectPermanenceFixture): ObjectPermanenceResult {
  const visibleTutor = new Set<string>();
  const unexplainedDisappearances: ObjectPermanenceResult['unexplainedDisappearances'] = [];
  const navigationTimes = fixture.sectionNavigations.map((entry) => entry.ts).sort((left, right) => left - right);

  const isDuringNavigation = (ts: number): boolean =>
    fixture.sectionNavigations.some((entry) => entry.ts === ts);

  const sortedEvents = [...fixture.releasedEvents].sort((left, right) => left.ts - right.ts);
  for (const event of sortedEvents) {
    if (event.owner !== 'tutor') continue;
    if (event.kind === 'add') {
      visibleTutor.add(event.objectId);
      continue;
    }
    if (!visibleTutor.has(event.objectId)) continue;
    visibleTutor.delete(event.objectId);
    if (!isDuringNavigation(event.ts)) {
      unexplainedDisappearances.push({
        objectId: event.objectId,
        cause: 'tutor_remove_without_navigation',
        source: 'board_event',
      });
    }
  }

  for (const metric of fixture.disappearanceMetrics) {
    unexplainedDisappearances.push({
      objectId: metric.objectId,
      cause: metric.cause,
      source: 'metric',
    });
  }

  void navigationTimes;

  return {
    pass: unexplainedDisappearances.length === 0,
    tutorObjectsVisible: [...visibleTutor].sort(),
    unexplainedDisappearances,
  };
}
