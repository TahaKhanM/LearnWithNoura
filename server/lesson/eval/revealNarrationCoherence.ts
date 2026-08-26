import { storyboardRunSteps } from '../../realtime/storyboardRunner.js';
import type { RevealNarrationFixture } from './types.js';

export type RevealNarrationCoherenceResult = {
  pass: boolean;
  stepsExpected: number;
  stepsNarratedBeforeNextReveal: number;
  violations: string[];
};

function storyboardStepById(fixture: RevealNarrationFixture, stepId: string) {
  return fixture.storyboard.find((step) => step.id === stepId);
}

function validateStoryboardRunnerBinding(fixture: RevealNarrationFixture): string[] {
  if (!fixture.anchorScene) return [];
  const violations: string[] = [];
  const anchorScene = {
    ops: fixture.anchorScene.ops,
    storyboard: fixture.anchorScene.storyboard.map((step) => ({
      id: step.id,
      reveal: step.reveal,
      narration: step.narration,
      objectIds: step.objectIds,
    })),
  };
  const derivedSteps = storyboardRunSteps(anchorScene);
  const derivedById = new Map(derivedSteps.map((step) => [step.id, step]));

  for (const step of fixture.storyboard) {
    const derived = derivedById.get(step.id);
    if (!derived) {
      violations.push(`storyboard step ${step.id} missing from storyboardRunSteps output.`);
      continue;
    }
    if (derived.objectIds.join(',') !== step.objectIds.join(',')) {
      violations.push(
        `storyboard step ${step.id} objectIds diverge from storyboardRunSteps (${derived.objectIds.join(', ')}).`,
      );
    }
  }

  for (const event of fixture.timeline) {
    if (event.kind !== 'reveal') continue;
    const derived = derivedById.get(event.stepId);
    if (!derived) continue;
    const derivedIds = [...derived.objectIds].sort().join(',');
    const eventIds = [...event.objectIds].sort().join(',');
    if (derivedIds !== eventIds) {
      violations.push(
        `timeline reveal ${event.stepId} objectIds (${event.objectIds.join(', ')}) do not match storyboardRunSteps (${derived.objectIds.join(', ')}).`,
      );
    }
    const derivedOpIds = derived.ops
      .filter((op): op is Extract<typeof op, { op: 'add' }> => op.op === 'add')
      .map((op) => op.id)
      .sort()
      .join(',');
    if (derivedOpIds !== eventIds) {
      violations.push(
        `timeline reveal ${event.stepId} ops from storyboardRunSteps (${derivedOpIds || 'none'}) do not match reveal objectIds.`,
      );
    }
  }

  return violations;
}

/**
 * Scores reveal–narration ordering from a scripted storyboard timeline.
 * Narration must cover each reveal before the next; referenced object ids are
 * derived from the storyboard step's objectIds. When anchorScene is present,
 * reveal ops are bound to production storyboardRunSteps.
 */
export function scoreRevealNarrationCoherence(fixture: RevealNarrationFixture): RevealNarrationCoherenceResult {
  const violations = validateStoryboardRunnerBinding(fixture);
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

    const step = storyboardStepById(fixture, event.stepId);
    const referencedObjectIds = step?.objectIds ?? [];
    for (const objectId of referencedObjectIds) {
      if (!visible.has(objectId)) {
        violations.push(
          `timeline[${index}]: narration for ${event.stepId} references ${objectId} before it is visible.`,
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
