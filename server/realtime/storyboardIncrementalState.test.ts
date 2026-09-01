import { describe, expect, it } from 'vitest';
import {
  appendIncrementalStoryboardStepState,
  closeIncrementalStoryboardState,
  type StoryboardRunState,
  type StoryboardRunStep,
} from './storyboardRunner.js';

describe('incremental storyboard intake state', () => {
  it('accepts ordered unique steps while open and refuses additions after close', () => {
    const run = openRun();
    expect(appendIncrementalStoryboardStepState(run, step('s1', 'a'))).toBe(true);
    expect(appendIncrementalStoryboardStepState(run, step('s2', 'b'))).toBe(true);
    expect(run.steps.map((item) => item.id)).toEqual(['s1', 's2']);
    expect(closeIncrementalStoryboardState(run)).toBe(true);
    expect(run.streamOpen).toBe(false);
    expect(appendIncrementalStoryboardStepState(run, step('s3', 'c'))).toBe(false);
  });

  it('rejects duplicate step and object identities before scheduler intake', () => {
    const run = openRun();
    expect(appendIncrementalStoryboardStepState(run, step('s1', 'a'))).toBe(true);
    expect(appendIncrementalStoryboardStepState(run, step('s1', 'b'))).toBe(false);
    expect(appendIncrementalStoryboardStepState(run, step('s2', 'a'))).toBe(false);
    expect(run.steps).toHaveLength(1);
  });

  it('cannot close an empty stream and accidentally create a handoff', () => {
    const run = openRun();
    expect(closeIncrementalStoryboardState(run)).toBe(false);
    expect(run.streamOpen).toBe(true);
  });
});

function openRun(): StoryboardRunState {
  return {
    runId: 'run-stream', source: 'director', groupId: 'group', groupLabel: 'Stream',
    steps: [], revealedSteps: 0, narratedSteps: 0, beatCreateInFlight: false,
    pendingBeatStepIndex: null, handoffResponseId: null, cancelPendingBeat: false,
    pendingStepEventId: null, stepCueCreateInFlight: false, needsResend: false, stepTimer: null,
    firstRevealHeld: false, subsequentRevealsHeld: false,
    firstRevealAfterResponseId: null, onFirstPaint: null, onFirstDurable: null,
    onSubsequentRevealBlocked: null, onAbandoned: null,
    auditBoundaryResponseId: null,
    nextBeatFraming: [], handoff: 'Ask the check.', visualIntentStartedAtMs: 1,
    firstPaintRecorded: false, sceneCompleteRecorded: false, streamOpen: true,
    progressWrite: Promise.resolve(),
  };
}

function step(id: string, objectId: string): StoryboardRunStep {
  return {
    id, reveal: 'outline', narration: `Explain ${id}.`, objectIds: [objectId],
    ops: [{ op: 'add', id: objectId, spec: { kind: 'box', at: [500, 300], text: id } }],
  };
}
