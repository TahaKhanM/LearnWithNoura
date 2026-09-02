import { describe, expect, it } from 'vitest';
import { ResponseCaptionTimeline } from './captionTimeline';

describe('playback-aware caption timeline', () => {
  it('holds a final transcript until audio starts and then paces phrases', () => {
    const timeline = new ResponseCaptionTimeline();
    timeline.registerResponse('r1', true);
    timeline.finishTranscript('r1', 'First idea. Second idea.', 0, true);
    expect(timeline.lines()).toEqual([]);

    timeline.playbackStarted('r1', 100);
    expect(timeline.lines().map((line) => line.text)).toEqual(['First idea.']);
    timeline.advance(700);
    expect(timeline.lines().map((line) => line.text)).toEqual(['First idea.']);
    timeline.advance(800);
    expect(timeline.lines().map((line) => line.text)).toEqual(['First idea. Second idea.']);
    expect(timeline.lines().every((line) => line.live)).toBe(true);
  });

  it('corrects a late final transcript in place without reordering responses', () => {
    const timeline = new ResponseCaptionTimeline();
    timeline.registerResponse('r1', true);
    timeline.pushDelta('r1', 'First rough phrase. ', 0, true);
    timeline.playbackStarted('r1', 0);
    timeline.playbackFinished('r1');
    timeline.appendChild('A learner reply.');
    timeline.registerResponse('r2', false);
    timeline.finishTranscript('r2', 'Second response.', 1_000, false);
    timeline.finishTranscript('r1', 'First corrected phrase.', 2_000, true);

    expect(timeline.lines().map((line) => `${line.role}:${line.text}`)).toEqual([
      'tutor:First corrected phrase.',
      'child:A learner reply.',
      'tutor:Second response.',
    ]);
  });

  it('finishing one response never flushes a later pending response', () => {
    const timeline = new ResponseCaptionTimeline();
    timeline.registerResponse('r1', true);
    timeline.finishTranscript('r1', 'Audible first response.', 0, true);
    timeline.registerResponse('r2', true);
    timeline.finishTranscript('r2', 'Future response must stay hidden.', 0, true);
    timeline.playbackStarted('r1', 0);
    timeline.playbackFinished('r1');
    expect(timeline.lines().map((line) => line.text)).toEqual(['Audible first response.']);
  });

  it('an interruption drops undisplayed future text and freezes heard captions', () => {
    const timeline = new ResponseCaptionTimeline();
    timeline.registerResponse('r1', true);
    timeline.finishTranscript('r1', 'Heard phrase. Unheard future phrase.', 0, true);
    timeline.playbackStarted('r1', 0);
    timeline.interrupt('r1');
    timeline.advance(10_000);
    expect(timeline.lines()).toEqual([
      { role: 'tutor', text: 'Heard phrase.', live: false, responseId: 'r1' },
    ]);
  });

  it('releases complete captions immediately when audio is unavailable', () => {
    const timeline = new ResponseCaptionTimeline();
    timeline.registerResponse('r1', false);
    timeline.finishTranscript('r1', 'Captions-only response remains useful.', 0, false);
    expect(timeline.lines()).toEqual([
      { role: 'tutor', text: 'Captions-only response remains useful.', live: false, responseId: 'r1' },
    ]);
  });
});
