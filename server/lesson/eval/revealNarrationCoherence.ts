import type { RevealNarrationFixture } from './types.js';

export type RevealNarrationCoherenceResult = {
  pass: boolean;
  stepsExpected: number;
  stepsNarratedBeforeNextReveal: number;
  violations: string[];
};

/**
 * Scores reveal–narration ordering from a scripted storyboard timeline.
 * Does not claim live A/V sync — only fixture event order and object visibility.
 */
export function scoreRevealNarrationCoherence(fixture: RevealNarrationFixture): RevealNarrationCoherenceResult {
  const violations: string[] = [];
  const visible = new Set<string>();
  let pendingRevealStepId: string | null = null;
  let stepsNarratedBeforeNextReveal = 0;

  for (const [index, event] of fixture.timeline.entries()) {
    if (event.kind === 'reveal') {
      if (pendingRevealStepId !== null) {
        violations.push(
          `timeline[${index}]: reveal of ${event.stepId} occurred before narration of ${pendingRevealStepId}.`,
        );
      } else {
        stepsNarratedBeforeNextReveal += 1;
      }
      for (const objectId of event.objectIds) visible.add(objectId);
      pendingRevealStepId = event.stepId;
      continue;
    }

    if (pendingRevealStepId === null) {
      violations.push(`timeline[${index}]: narration for ${event.stepId} without a preceding reveal.`);
    } else if (pendingRevealStepId !== event.stepId) {
      violations.push(
        `timeline[${index}]: narration step ${event.stepId} does not match pending reveal ${pendingRevealStepId}.`,
      );
    }

    for (const objectId of event.referencedObjectIds) {
      if (!visible.has(objectId)) {
        violations.push(
          `timeline[${index}]: narration references ${objectId} before it is visible.`,
        );
      }
    }
    pendingRevealStepId = null;
  }

  if (pendingRevealStepId !== null) {
    violations.push(`final state: reveal ${pendingRevealStepId} was never narrated.`);
  }

  const storyboardIds = new Set(fixture.storyboard.map((step) => step.id));
  const timelineRevealIds = fixture.timeline.filter((event) => event.kind === 'reveal').map((event) => event.stepId);
  for (const stepId of storyboardIds) {
    if (!timelineRevealIds.includes(stepId)) {
      violations.push(`storyboard step ${stepId} never appears in the timeline.`);
    }
  }

  return {
    pass: violations.length === 0,
    stepsExpected: fixture.storyboard.length,
    stepsNarratedBeforeNextReveal,
    violations,
  };
}
