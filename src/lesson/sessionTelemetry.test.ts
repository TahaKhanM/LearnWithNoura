import { describe, expect, it } from 'vitest';
import { ResponseTimingTracker } from './sessionTelemetry';

describe('ResponseTimingTracker', () => {
  it('reports signed reveal timing with bounded cue correlation', () => {
    const tracker = new ResponseTimingTracker();
    tracker.noteNarrationScheduled('response-1', 1_000);

    expect(tracker.noteBoardReveal('response-1', 1_820, {
      visualCueId: 'cue-1',
      semanticObjectId: 'anchor-1',
    })).toEqual({
      schemaVersion: '1.0.0',
      name: 'board_reveal_to_narration',
      unit: 'ms',
      value: -820,
      visualCueId: 'cue-1',
      semanticObjectId: 'anchor-1',
    });
  });

  it('reports a positive value when the board reveals before narration', () => {
    const tracker = new ResponseTimingTracker();
    tracker.noteNarrationScheduled('response-1', 1_000);

    expect(tracker.noteBoardReveal('response-1', 820, {
      visualCueId: 'cue-before',
    })).toMatchObject({ value: 180 });
  });

  it('ignores duplicate visual cues and reveals without narration', () => {
    const tracker = new ResponseTimingTracker();
    tracker.noteNarrationScheduled('response-1', 1_000);

    expect(tracker.noteBoardReveal('response-1', 1_100, {
      visualCueId: 'cue-1',
    })).not.toBeNull();
    expect(tracker.noteBoardReveal('response-1', 1_200, {
      visualCueId: 'cue-1',
    })).toBeNull();
    expect(tracker.noteBoardReveal('missing-response', 1_200, {
      visualCueId: 'cue-missing',
    })).toBeNull();
  });

  it('clears response and cue correlation between generations', () => {
    const tracker = new ResponseTimingTracker();
    tracker.noteNarrationScheduled('response-1', 1_000);
    expect(tracker.noteBoardReveal('response-1', 1_100, {
      visualCueId: 'cue-1',
    })).not.toBeNull();

    tracker.resetGeneration();
    expect(tracker.noteBoardReveal('response-1', 1_200, {
      visualCueId: 'cue-1',
    })).toBeNull();

    tracker.noteNarrationScheduled('response-1', 1_300);
    expect(tracker.noteBoardReveal('response-1', 1_400, {
      visualCueId: 'cue-1',
    })).not.toBeNull();
  });

  it('retains only the latest 64 response and cue boundaries', () => {
    const tracker = new ResponseTimingTracker();
    for (let index = 0; index < 65; index += 1) {
      tracker.noteNarrationScheduled(`response-${index}`, index);
      expect(tracker.noteBoardReveal(`response-${index}`, index + 1, {
        visualCueId: `cue-${index}`,
      })).not.toBeNull();
    }

    expect(tracker.noteBoardReveal('response-0', 100, {
      visualCueId: 'cue-retry',
    })).toBeNull();
    tracker.noteNarrationScheduled('response-current', 200);
    expect(tracker.noteBoardReveal('response-current', 201, {
      visualCueId: 'cue-0',
    })).not.toBeNull();
  });
});
