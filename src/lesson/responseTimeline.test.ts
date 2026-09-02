import { describe, expect, it } from 'vitest';
import type { GenerationIdentity } from '../../shared/runtimeProtocol';
import { ResponseCueTimeline, type ResponseCue } from './responseTimeline';

const identity: GenerationIdentity = { sessionId: 'session', connectionEpoch: 1, turnId: 'turn-1', generationId: 'generation-1' };
const nextIdentity: GenerationIdentity = { ...identity, connectionEpoch: 2, turnId: 'turn-2', generationId: 'generation-2' };

function visual(id: string, sequence: number, responseId = 'response', active = identity): Extract<ResponseCue, { kind: 'visual' }> {
  return { kind: 'visual', cueId: id, responseId, sequence, identity: active, ops: [], eventId: 1, semanticObjectId: 'fraction-scale', visualCueId: id };
}

function semantic(id: string, sequence: number, responseId = 'response', active = identity): ResponseCue {
  return { kind: 'semantic', cueId: id, responseId, sequence, identity: active, state: { activeConcept: id } };
}

describe('response cue timeline (playback-bound)', () => {
  it('releases ordinary visuals immediately and holds lesson state until speech ends', () => {
    const timeline = new ResponseCueTimeline();
    timeline.enqueue(visual('visual-2', 4));
    timeline.enqueue(semantic('semantic-1', 1));
    timeline.enqueue(visual('visual-1', 3));
    expect(timeline.drain((responseId) => responseId === 'response' ? 'playing' : 'finished').map((cue) => cue.cueId))
      .toEqual(['visual-1', 'visual-2']);
    expect(timeline.pendingCount()).toBe(1);
    expect(timeline.drain(() => 'finished').map((cue) => cue.cueId))
      .toEqual(['semantic-1']);
    expect(timeline.pendingCount()).toBe(0);
  });

  it('holds semantic state and tasks while audio is pending but not started', () => {
    const timeline = new ResponseCueTimeline();
    timeline.enqueue(semantic('pending-state', 1, 'pending-response'));
    expect(timeline.drain(() => 'pending')).toEqual([]);
    expect(timeline.drain(() => 'finished').map((cue) => cue.cueId)).toEqual(['pending-state']);
  });

  it('releases ordinary visuals even while their response is still speaking', () => {
    const timeline = new ResponseCueTimeline();
    timeline.enqueue(visual('tool-first-plan', 1, 'tool-first'));
    timeline.enqueue(visual('spoken-plan', 2, 'spoken'));
    const released = timeline.drain((responseId) => responseId === 'spoken' ? 'playing' : 'pending');
    expect(released.map((cue) => cue.cueId)).toEqual(['tool-first-plan', 'spoken-plan']);
    expect(timeline.pendingCount('visual')).toBe(0);
  });

  it('rejects repeated cue IDs so replays and retries stay idempotent', () => {
    const timeline = new ResponseCueTimeline();
    expect(timeline.enqueue(visual('once', 1))).toBe(true);
    expect(timeline.enqueue(visual('once', 1))).toBe(false);
    expect(timeline.pendingCount()).toBe(1);
  });

  it('clears unreached visual and semantic state synchronously on repeated interruption', () => {
    const timeline = new ResponseCueTimeline();
    timeline.enqueue(semantic('late-state', 1));
    timeline.enqueue(visual('late-drawing', 2));
    expect(timeline.cancel(identity)).toHaveLength(2);
    expect(timeline.cancel(identity)).toEqual([]);
    expect(timeline.pendingCount()).toBe(0);
    expect(timeline.enqueue(visual('stale-cue', 4))).toBe(false);
  });

  it('rejects stale reconnect events while accepting the new generation', () => {
    const timeline = new ResponseCueTimeline();
    timeline.enqueue(visual('old', 1));
    timeline.cancel(identity);
    expect(timeline.enqueue(visual('old-late', 2))).toBe(false);
    expect(timeline.enqueue(visual('new', 1, 'response', nextIdentity))).toBe(true);
    expect(timeline.drain(() => 'finished').map((cue) => cue.cueId)).toEqual(['new']);
  });

  it('holds a storyboard reveal until its tagged response has finished playing', () => {
    const timeline = new ResponseCueTimeline();
    timeline.enqueue({ ...visual('step-2', 1, 'beat-1'), awaitNarration: true });
    // Pending playback (the beat has not started speaking yet) still holds
    // the reveal — an ordinary cue would already have been released.
    expect(timeline.drain(() => 'pending')).toEqual([]);
    expect(timeline.drain(() => 'playing')).toEqual([]);
    expect(timeline.drain(() => 'finished').map((cue) => cue.cueId)).toEqual(['step-2']);
  });

  it('deduplicates a re-sent board event by stable cue id across separate envelopes', () => {
    const timeline = new ResponseCueTimeline();
    expect(timeline.enqueue({ ...visual('board-event-503', 1, 'beat-0'), awaitNarration: true })).toBe(true);
    // The server re-sent the same board event under a fresh envelope while
    // the original cue is still pending: it must not enqueue twice.
    expect(timeline.enqueue({ ...visual('board-event-503', 2, 'blip-response'), awaitNarration: true })).toBe(false);
    expect(timeline.pendingCount()).toBe(1);
  });

  it('allows a cancelled board event to re-enqueue under a fresh generation identity', () => {
    const timeline = new ResponseCueTimeline();
    timeline.enqueue(visual('board-event-503', 1));
    timeline.cancel(identity);
    // The stale identity stays rejected…
    expect(timeline.enqueue(visual('board-event-503', 2))).toBe(false);
    // …but the legitimate post-interruption re-send of the SAME board event
    // arrives under the new generation and must apply.
    expect(timeline.enqueue(visual('board-event-503', 2, 'resume-response', nextIdentity))).toBe(true);
    expect(timeline.drain(() => 'finished').map((cue) => cue.cueId)).toEqual(['board-event-503']);
  });

  it('cancels only unrevealed board events by event id and preserves the generation', () => {
    const timeline = new ResponseCueTimeline();
    timeline.enqueue({ ...visual('board-event-11', 1, 'cover'), eventId: 11, awaitNarration: true });
    timeline.enqueue({ ...visual('board-event-12', 2, 'cover'), eventId: 12, awaitNarration: true });

    expect(timeline.cancelVisualEvents([11]).map((cue) => cue.cueId)).toEqual(['board-event-11']);
    expect(timeline.drain(() => 'finished').map((cue) => cue.cueId)).toEqual(['board-event-12']);
    expect(timeline.enqueue({ ...visual('board-event-11', 3, 'later'), eventId: 11 })).toBe(true);

    // Drained means already first-painted, so a late cancellation cannot
    // retract it or poison other cues from the same generation.
    expect(timeline.drain(() => 'finished').map((cue) => cue.cueId)).toEqual(['board-event-11']);
    expect(timeline.cancelVisualEvents([11])).toEqual([]);
  });

  it('navigation cleanup removes every pending cue', () => {
    const timeline = new ResponseCueTimeline();
    timeline.enqueue(semantic('state', 1));
    timeline.enqueue(visual('visual', 2));
    expect(timeline.cancel()).toHaveLength(2);
    expect(timeline.pendingCount()).toBe(0);
  });
});
