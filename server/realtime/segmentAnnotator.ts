import type { RuntimeEventEnvelope } from '../../shared/runtimeProtocol.js';

type CueOptional = Partial<Pick<RuntimeEventEnvelope, 'visualCueId' | 'semanticObjectId' | 'idempotencyKey'>>;

export interface AnnotatedSegmentCue {
  payload: Record<string, unknown>;
  optional: CueOptional & { audioSampleOffsets: { start: number; end: number } };
}

interface TranscriptDelta {
  delta: string;
  itemId?: string;
}

interface SemanticCue {
  payload: Record<string, unknown>;
  optional: CueOptional;
}

/**
 * Conservative response-segment annotation grounded only in PCM16 sample
 * counts. Audio chunks receive exact cumulative offsets immediately. Text is
 * buffered until the response is sealed, then its ordered deltas are spread
 * by Unicode character weight across the complete PCM segment. Semantic,
 * visual, pen and character-state cues are released at the segment boundary.
 *
 * This intentionally does not claim provider word timestamps. Buffering makes
 * annotations invariant to audio/transcript/tool network interleaving and
 * prevents early tiny audio chunks from exposing later text or visuals.
 */
export class ResponseSegmentAnnotator {
  private samples = 0;
  private transcript: TranscriptDelta[] = [];
  private semantic: SemanticCue[] = [];
  private finalTranscript: string | null = null;
  private sealed = false;

  addAudioSamples(sampleCount: number): { start: number; end: number } {
    if (this.sealed) throw new Error('Response segment is already sealed.');
    const count = Number.isInteger(sampleCount) && sampleCount > 0 ? sampleCount : 0;
    const start = this.samples;
    this.samples += count;
    return { start, end: this.samples };
  }

  addTranscriptDelta(delta: string, itemId?: string): void {
    if (this.sealed || !delta) return;
    this.transcript.push({ delta, itemId });
  }

  addSemanticCue(payload: Record<string, unknown>, optional: CueOptional = {}): void {
    if (this.sealed) return;
    this.semantic.push({ payload, optional });
  }

  setFinalTranscript(text: string): void {
    if (!this.sealed) this.finalTranscript = text;
  }

  totalSamples(): number { return this.samples; }

  seal(): AnnotatedSegmentCue[] {
    if (this.sealed) return [];
    this.sealed = true;
    const result: AnnotatedSegmentCue[] = [];
    if (this.samples > 0 && this.transcript.length > 0) {
      const weights = this.transcript.map(({ delta }) => Math.max(1, [...delta].filter((char) => !/\s/u.test(char)).length));
      const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
      let cumulativeWeight = 0;
      let start = 0;
      for (const [index, entry] of this.transcript.entries()) {
        cumulativeWeight += weights[index];
        const end = index === this.transcript.length - 1
          ? this.samples
          : Math.max(start, Math.round((this.samples * cumulativeWeight) / totalWeight));
        result.push({
          payload: { type: 'transcript_delta', delta: entry.delta, response_id: undefined, item_id: entry.itemId },
          optional: { audioSampleOffsets: { start, end } },
        });
        start = end;
      }
    }
    for (const cue of this.semantic) result.push({
      payload: cue.payload,
      optional: { ...cue.optional, audioSampleOffsets: { start: this.samples, end: this.samples } },
    });
    if (this.samples > 0 && this.finalTranscript?.trim()) result.push({
      payload: { type: 'transcript_done', text: this.finalTranscript, response_id: undefined },
      optional: { audioSampleOffsets: { start: 0, end: this.samples } },
    });
    return result;
  }
}
