import { describe, expect, it } from 'vitest';
import type { GenerationIdentity } from '../../shared/runtimeProtocol';
import { ResponseCueTimeline, type ResponseCue } from './responseTimeline';

const identity: GenerationIdentity = { sessionId: 'session', connectionEpoch: 1, turnId: 'turn-1', generationId: 'generation-1' };
const nextIdentity: GenerationIdentity = { ...identity, connectionEpoch: 2, turnId: 'turn-2', generationId: 'generation-2' };

function caption(id: string, endSample: number, sequence: number, active = identity): ResponseCue {
  return { kind: 'caption', cueId: id, responseId: 'response', startSample: Math.max(0, endSample - 100), endSample, sequence, identity: active, delta: id };
}

function visual(id: string, endSample: number, sequence: number, active = identity): ResponseCue {
  return { kind: 'visual', cueId: id, responseId: 'response', startSample: endSample, endSample, sequence, identity: active, ops: [], eventId: 1, semanticObjectId: 'fraction-scale', visualCueId: id };
}

describe('response sample timeline', () => {
  it('releases normal and jittered caption/visual cues in heard-sample order', () => {
    const timeline = new ResponseCueTimeline();
    timeline.enqueue(visual('visual-2', 400, 4));
    timeline.enqueue(caption('caption-1', 100, 1));
    timeline.enqueue(visual('visual-1', 200, 3));
    timeline.enqueue(caption('caption-2', 200, 2));
    expect(timeline.drain(() => 199).map((cue) => cue.cueId)).toEqual(['caption-1']);
    expect(timeline.drain(() => 200).map((cue) => cue.cueId)).toEqual(['caption-2', 'visual-1']);
    expect(timeline.drain(() => 400).map((cue) => cue.cueId)).toEqual(['visual-2']);
  });

  it('does not reveal during a thinking gap and rejects repeated cue IDs', () => {
    const timeline = new ResponseCueTimeline();
    expect(timeline.enqueue(caption('phrase', 2_400, 1))).toBe(true);
    expect(timeline.enqueue(caption('phrase', 2_400, 1))).toBe(false);
    expect(timeline.drain(() => 0)).toEqual([]);
    expect(timeline.pendingCount()).toBe(1);
  });

  it('queues transcript_done until the final PCM sample has played', () => {
    const timeline = new ResponseCueTimeline();
    timeline.enqueue(caption('heard-phrase', 4_000, 1));
    timeline.enqueue({ kind: 'final', cueId: 'final', responseId: 'response', startSample: 0, endSample: 24_000, sequence: 2, identity, text: 'Heard phrase. Future phrase.' });
    expect(timeline.drain(() => 4_000).map((cue) => cue.kind)).toEqual(['caption']);
    expect(timeline.drain(() => 23_999)).toEqual([]);
    expect(timeline.drain(() => 24_000).map((cue) => cue.kind)).toEqual(['final']);
  });

  it('clears unreached drawing, caption, visual, and final state synchronously on repeated interruption', () => {
    const timeline = new ResponseCueTimeline();
    timeline.enqueue(caption('late-caption', 5_000, 1));
    timeline.enqueue(visual('late-drawing', 6_000, 2));
    timeline.enqueue({ kind: 'final', cueId: 'late-final', responseId: 'response', startSample: 0, endSample: 8_000, sequence: 3, identity, text: 'future' });
    expect(timeline.cancel(identity)).toHaveLength(3);
    expect(timeline.cancel(identity)).toEqual([]);
    expect(timeline.pendingCount()).toBe(0);
    expect(timeline.enqueue(caption('stale-delta', 7_000, 4))).toBe(false);
  });

  it('rejects stale reconnect events while accepting the new generation', () => {
    const timeline = new ResponseCueTimeline();
    timeline.enqueue(caption('old', 100, 1));
    timeline.cancel(identity);
    expect(timeline.enqueue(caption('old-late', 200, 2))).toBe(false);
    expect(timeline.enqueue(caption('new', 100, 1, nextIdentity))).toBe(true);
    expect(timeline.drain(() => 100).map((cue) => cue.cueId)).toEqual(['new']);
  });

  it('navigation cleanup removes every pending cue', () => {
    const timeline = new ResponseCueTimeline();
    timeline.enqueue(caption('caption', 100, 1));
    timeline.enqueue(visual('visual', 100, 2));
    expect(timeline.cancel()).toHaveLength(2);
    expect(timeline.pendingCount()).toBe(0);
  });
});
