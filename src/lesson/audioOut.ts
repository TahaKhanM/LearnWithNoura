/**
 * Plays the tutor's PCM stream through Web Audio with a sample-accurate
 * clock. Chunks are scheduled ahead as they arrive; because we know
 * exactly how much audio has been scheduled and how much has played —
 * per response, even when several responses are queued back to back —
 * (a) stopping locally on interruption is instant, (b) captions and board
 * operations can be released at the exact moment in speech where the
 * model emitted them, and (c) truncation can tell the server precisely
 * how much of each conversation item the child actually heard.
 */

export const PCM_SAMPLE_RATE = 24000;

interface ActiveSource {
  node: AudioBufferSourceNode;
  gain: GainNode;
}

interface Timeline {
  responseId: string;
  itemId: string | null;
  /** Context time when this response's first chunk starts playing. */
  start: number;
  scheduledSec: number;
  /** RMS energy per chunk, offsets relative to `start`. */
  energy: { at: number; rms: number }[];
}

export interface HeardItem {
  itemId: string;
  heardMs: number;
  fullyPlayed: boolean;
}

export class AudioOut {
  private ctx: AudioContext | null = null;
  private cursor = 0;
  private sources = new Set<ActiveSource>();
  private timelines: Timeline[] = [];
  /** Responses whose timeline was evicted: their audio is long past. */
  private retired = new Set<string>();
  onPlaybackEnd: () => void = () => {};

  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
    return this.ctx;
  }

  /** Must be called from a user gesture so the context may start. */
  async unlock(): Promise<void> {
    const ctx = this.context();
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* stays suspended; scheduling still works, silently */
      }
    }
  }

  get supported(): boolean {
    return typeof AudioContext !== 'undefined';
  }

  /** Decodes a base64 PCM16 chunk and schedules it after what's queued. */
  append(responseId: string, itemId: string | null, base64: string): void {
    const ctx = this.context();
    const bytes = atob(base64);
    const samples = bytes.length >> 1;
    if (samples === 0) return;

    const buffer = ctx.createBuffer(1, samples, PCM_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
      const low = bytes.charCodeAt(2 * i);
      const high = bytes.charCodeAt(2 * i + 1);
      let value = (high << 8) | low;
      if (value >= 0x8000) value -= 0x10000;
      const f = value / 0x8000;
      channel[i] = f;
      sumSquares += f * f;
    }

    const at = Math.max(ctx.currentTime + 0.05, this.cursor);
    let timeline = this.timelines[this.timelines.length - 1];
    if (!timeline || timeline.responseId !== responseId) {
      timeline = { responseId, itemId, start: at, scheduledSec: 0, energy: [] };
      this.timelines.push(timeline);
      if (this.timelines.length > 8) {
        const evicted = this.timelines.shift() as Timeline;
        this.retired.add(evicted.responseId);
        if (this.retired.size > 64) {
          this.retired.delete(this.retired.values().next().value as string);
        }
      }
    }
    if (!timeline.itemId && itemId) timeline.itemId = itemId;

    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(ctx.destination);
    const active: ActiveSource = { node: source, gain };
    this.sources.add(active);
    source.onended = () => {
      this.sources.delete(active);
      if (this.sources.size === 0) this.onPlaybackEnd();
    };
    source.start(at);
    this.cursor = at + buffer.duration;
    timeline.scheduledSec += buffer.duration;
    timeline.energy.push({ at: at - timeline.start, rms: Math.sqrt(sumSquares / samples) });
  }

  private findTimeline(responseId: string): Timeline | undefined {
    return this.timelines.find((t) => t.responseId === responseId);
  }

  /** How much of response `responseId` has actually been heard, in ms. */
  playedMs(responseId: string): number {
    const ctx = this.ctx;
    const timeline = this.findTimeline(responseId);
    if (!ctx || !timeline) {
      // A retired response finished playing long ago; anything stamped
      // against it should release rather than wait on a clock that's gone.
      return this.retired.has(responseId) ? Number.MAX_SAFE_INTEGER : 0;
    }
    const played = (ctx.currentTime - timeline.start) * 1000;
    return Math.max(0, Math.min(played, timeline.scheduledSec * 1000));
  }

  /** Total audio received so far for a response, in ms. */
  scheduledMs(responseId: string): number {
    return (this.findTimeline(responseId)?.scheduledSec ?? 0) * 1000;
  }

  playedSamples(responseId: string): number {
    const played = this.playedMs(responseId);
    return played === Number.MAX_SAFE_INTEGER ? played : Math.round((played / 1000) * PCM_SAMPLE_RATE);
  }

  scheduledSamples(responseId: string): number {
    return Math.round((this.scheduledMs(responseId) / 1000) * PCM_SAMPLE_RATE);
  }

  get speaking(): boolean {
    return this.sources.size > 0;
  }

  /** Voice loudness right now (0..~0.5), driving the avatar's mouth. */
  currentEnergy(): number {
    const ctx = this.ctx;
    if (!ctx || this.sources.size === 0) return 0;
    const now = ctx.currentTime;
    for (const timeline of this.timelines) {
      const t = now - timeline.start;
      if (t < 0 || t > timeline.scheduledSec) continue;
      let latest = 0;
      for (const entry of timeline.energy) {
        if (entry.at <= t) latest = entry.rms;
        else break;
      }
      return latest;
    }
    return 0;
  }

  /**
   * Immediate local stop. Reports how much of each conversation item had
   * been heard, so the caller can truncate the transcript truthfully.
   */
  stop(): HeardItem[] {
    const ctx = this.ctx;
    const heard: HeardItem[] = [];
    if (ctx) {
      const now = ctx.currentTime;
      for (const timeline of this.timelines) {
        if (!timeline.itemId) continue;
        const playedSec = Math.max(0, Math.min(now - timeline.start, timeline.scheduledSec));
        heard.push({
          itemId: timeline.itemId,
          heardMs: Math.round(playedSec * 1000),
          fullyPlayed: playedSec >= timeline.scheduledSec - 0.01,
        });
      }
    }
    for (const { node, gain } of this.sources) {
      node.onended = null;
      try {
        // A tiny fade avoids a click without delaying the stop meaningfully.
        gain.gain.setValueAtTime(gain.gain.value, this.ctx?.currentTime ?? 0);
        gain.gain.linearRampToValueAtTime(0, (this.ctx?.currentTime ?? 0) + 0.02);
        node.stop((this.ctx?.currentTime ?? 0) + 0.025);
      } catch {
        /* already stopped */
      }
    }
    // Deliberately no onPlaybackEnd here: stop() is the interruption path,
    // and the interrupter owns what happens to pending state.
    this.sources.clear();
    this.cursor = 0;
    this.timelines = [];
    return heard;
  }

  async close(): Promise<void> {
    this.stop();
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* already closed */
      }
      this.ctx = null;
    }
  }
}
