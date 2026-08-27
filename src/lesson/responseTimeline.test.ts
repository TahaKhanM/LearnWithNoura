import { describe, expect, it } from 'vitest';
import type { GenerationIdentity } from '../../shared/runtimeProtocol';
import { ResponseCueTimeline, type ResponseCue } from './responseTimeline';

const identity: GenerationIdentity = { sessionId: 'session', connectionEpoch: 1, turnId: 'turn-1', generationId: 'generation-1' };
const nextIdentity: GenerationIdentity = { ...identity, connectionEpoch: 2, turnId: 'turn-2', generationId: 'generation-2' };

function visual(id: string, sequence: number, responseId = 'response', active = identity): ResponseCue {
  return { kind: 'visual', cueId: id, responseId, sequence, identity: active, ops: [], eventId: 1, semanticObjectId: 'fraction-scale', visualCueId: id };
}

function semantic(id: string, sequence: number, responseId = 'response', active = identity): ResponseCue {
  return { kind: 'semantic', cueId: id, responseId, sequence, identity: active, state: { activeConcept: id } };
}

function final(id: string, sequence: number, responseId = 'response', active = identity): ResponseCue {
  return { kind: 'final', cueId: id, responseId, sequence, identity: active, text: 'Heard phrase.' };
}

describe('response cue timeline (playback-bound)', () => {
  it('holds cues while their response is audibly playing and releases them in sequence order on stop', () => {
    const timeline = new ResponseCueTimeline();
    timeline.enqueue(visual('visual-2', 4));
    timeline.enqueue(semantic('semantic-1', 1));
    timeline.enqueue(visual('visual-1', 3));
    timeline.enqueue(final('final-1', 5));
    expect(timeline.drain((responseId) => responseId === 'response')).toEqual([]);
    expect(timeline.pendingCount()).toBe(4);
    expect(timeline.drain(() => false).map((cue) => cue.cueId))
      .toEqual(['semantic-1', 'visual-1', 'visual-2', 'final-1']);
    expect(timeline.pendingCount()).toBe(0);
  });

  it('releases cues for a response that is not playing while holding the playing one', () => {
    const timeline = new ResponseCueTimeline();
    timeline.enqueue(visual('tool-first-plan', 1, 'tool-first'));
    timeline.enqueue(visual('spoken-plan', 2, 'spoken'));
    const released = timeline.drain((responseId) => responseId === 'spoken');
    expect(released.map((cue) => cue.cueId)).toEqual(['tool-first-plan']);
    expect(timeline.pendingCount('visual')).toBe(1);
  });

  it('rejects repeated cue IDs so replays and retries stay idempotent', () => {
    const timeline = new ResponseCueTimeline();
    expect(timeline.enqueue(visual('once', 1))).toBe(true);
    expect(timeline.enqueue(visual('once', 1))).toBe(false);
    expect(timeline.pendingCount()).toBe(1);
  });

  it('clears unreached visual, semantic, and final state synchronously on repeated interruption', () => {
    const timeline = new ResponseCueTimeline();
    timeline.enqueue(semantic('late-state', 1));
    timeline.enqueue(visual('late-drawing', 2));
    timeline.enqueue(final('late-final', 3));
    expect(timeline.cancel(identity)).toHaveLength(3);
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
    expect(timeline.drain(() => false).map((cue) => cue.cueId)).toEqual(['new']);
  });

  it('navigation cleanup removes every pending cue', () => {
    const timeline = new ResponseCueTimeline();
    timeline.enqueue(semantic('state', 1));
    timeline.enqueue(visual('visual', 2));
    expect(timeline.cancel()).toHaveLength(2);
    expect(timeline.pendingCount()).toBe(0);
  });
});
