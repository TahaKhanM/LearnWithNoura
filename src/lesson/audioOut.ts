/**
 * Plays the tutor's PCM stream through Web Audio with a sample-accurate
 * clock. Chunks are scheduled ahead as they arrive; because we know
 * exactly how much audio has been scheduled and how much has played,
 * (a) stopping locally on interruption is instant, (b) captions and board
 * operations can be released at the exact moment in speech where the
 * model emitted them, and (c) truncation can tell the server precisely
 * how much the child heard.
 */

const RATE = 24000;

interface ActiveSource {
  node: AudioBufferSourceNode;
  gain: GainNode;
}

export class AudioOut {
  private ctx: AudioContext | null = null;
  private cursor = 0;
  private sources = new Set<ActiveSource>();
  /** Context time at which the current response's audio began. */
  private responseStart = 0;
  private responseScheduledSec = 0;
  private responseId: string | null = null;
  /** RMS energy per scheduled chunk, for avatar mouth movement. */
  private energyTimeline: { at: number; rms: number }[] = [];
  onPlaybackEnd: () => void = () => {};

  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext({ sampleRate: RATE });
    return this.ctx;
  }

  /** Must be called from a user gesture so the context may start. */
  async unlock(): Promise<void> {
    const ctx = this.context();
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* stays suspended; play() will retry */
      }
    }
  }

  get supported(): boolean {
    return typeof AudioContext !== 'undefined';
  }

  /** Decodes a base64 PCM16 chunk and schedules it after what's queued. */
  append(responseId: string, base64: string): void {
    const ctx = this.context();
    const bytes = atob(base64);
    const samples = bytes.length >> 1;
    if (samples === 0) return;

    const buffer = ctx.createBuffer(1, samples, RATE);
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

    if (responseId !== this.responseId) {
      this.responseId = responseId;
      this.responseScheduledSec = 0;
      this.responseStart = Math.max(ctx.currentTime + 0.05, this.cursor);
      this.energyTimeline = [];
    }

    const at = Math.max(ctx.currentTime + 0.05, this.cursor);
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
    this.responseScheduledSec += buffer.duration;
    this.energyTimeline.push({
      at: at - this.responseStart,
      rms: Math.sqrt(sumSquares / samples),
    });
  }

  /** How much of response `id` has actually been heard, in ms. */
  playedMs(id: string | null = this.responseId): number {
    const ctx = this.ctx;
    if (!ctx || id === null || id !== this.responseId) return 0;
    const played = (ctx.currentTime - this.responseStart) * 1000;
    return Math.max(0, Math.min(played, this.responseScheduledSec * 1000));
  }

  /** Total audio received for the current response, in ms. */
  scheduledMs(): number {
    return this.responseScheduledSec * 1000;
  }

  get speaking(): boolean {
    return this.sources.size > 0 && this.playedMs() < this.scheduledMs() - 1;
  }

  /** Voice loudness right now (0..~0.5), driving the avatar's mouth. */
  currentEnergy(): number {
    if (!this.ctx || this.sources.size === 0) return 0;
    const t = (this.ctx.currentTime - this.responseStart);
    let latest = 0;
    for (const entry of this.energyTimeline) {
      if (entry.at <= t) latest = entry.rms;
      else break;
    }
    return latest;
  }

  /**
   * Immediate local stop. Returns how many ms of the current response had
   * been heard, so the caller can truncate the conversation item.
   */
  stop(): number {
    const heard = this.playedMs();
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
    this.sources.clear();
    this.cursor = 0;
    this.responseId = null;
    this.responseScheduledSec = 0;
    this.energyTimeline = [];
    this.onPlaybackEnd();
    return Math.round(heard);
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
