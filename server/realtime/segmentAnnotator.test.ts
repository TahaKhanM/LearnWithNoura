import { describe, expect, it } from 'vitest';
import { ResponseSegmentAnnotator } from './segmentAnnotator';

function trace(order: Array<'audio-small' | 'audio-rest' | 'text-a' | 'text-b' | 'tool' | 'final'>) {
  const annotator = new ResponseSegmentAnnotator();
  for (const step of order) {
    if (step === 'audio-small') annotator.addAudioSamples(480);
    if (step === 'audio-rest') annotator.addAudioSamples(23_520);
    if (step === 'text-a') annotator.addTranscriptDelta('Repeated phrase. ');
    if (step === 'text-b') annotator.addTranscriptDelta('Repeated phrase later.');
    if (step === 'tool') annotator.addSemanticCue({ type: 'board_ops', ops: [] }, { semanticObjectId: 'fraction-scale' });
    if (step === 'final') annotator.setFinalTranscript('Repeated phrase. Repeated phrase later.');
  }
  return annotator.seal();
}

describe('response segment annotator', () => {
  it('is invariant when transcript is before or after the PCM bursts', () => {
    const earlyText = trace(['text-a', 'text-b', 'audio-small', 'audio-rest', 'tool', 'final']);
    const earlyAudio = trace(['audio-small', 'audio-rest', 'text-a', 'text-b', 'tool', 'final']);
    expect(earlyText).toEqual(earlyAudio);
  });

  it('never squeezes multiple early deltas or semantic cues into the first 20 ms chunk', () => {
    const cues = trace(['text-a', 'text-b', 'tool', 'audio-small', 'audio-rest', 'final']);
    const captions = cues.filter((cue) => cue.payload.type === 'transcript_delta');
    expect(captions).toHaveLength(2);
    expect(captions[0].optional.audioSampleOffsets.end).toBeGreaterThan(480);
    expect(captions[1].optional.audioSampleOffsets.end).toBe(24_000);
    expect(cues.find((cue) => cue.payload.type === 'board_ops')?.optional.audioSampleOffsets).toEqual({ start: 24_000, end: 24_000 });
    expect(cues.find((cue) => cue.payload.type === 'transcript_done')?.optional.audioSampleOffsets.end).toBe(24_000);
  });

  it('does not manufacture heard text during a no-audio thinking gap', () => {
    const annotator = new ResponseSegmentAnnotator();
    annotator.addTranscriptDelta('future words');
    annotator.setFinalTranscript('future words');
    expect(annotator.seal()).toEqual([]);
  });

  it('uses delta identity/order rather than phrase matching for repeated text', () => {
    const cues = trace(['audio-small', 'text-a', 'tool', 'audio-rest', 'text-b', 'final']);
    expect(cues.filter((cue) => cue.payload.type === 'transcript_delta').map((cue) => cue.payload.delta)).toEqual([
      'Repeated phrase. ',
      'Repeated phrase later.',
    ]);
  });
});
