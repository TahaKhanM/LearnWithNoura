import type { PlaybackBoundary, VoiceTransport, VoiceTransportHandlers, VoiceTransportState } from './voiceTransport';

/**
 * Deterministic voice transport for tests: no WebRTC, no microphone, no
 * provider. Tests drive playback boundaries and energy readings explicitly
 * and observe exactly what the session would do with a live call.
 */
export class FakeVoiceTransport implements VoiceTransport {
  state: VoiceTransportState = 'new';
  micMuted = false;
  micEnergy = 0;
  voiceEnergy = 0;
  playbackClears = 0;
  private handlers: VoiceTransportHandlers;
  private activeResponseId: string | null = null;
  private playedSoFarMs = 0;

  constructor(handlers: VoiceTransportHandlers) {
    this.handlers = handlers;
  }

  connect(): Promise<void> {
    this.state = 'connected';
    this.handlers.onStateChange('connected');
    return Promise.resolve();
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
  }

  playingResponseId(): string | null {
    return this.activeResponseId;
  }

  playedMs(): number {
    return this.activeResponseId ? this.playedSoFarMs : 0;
  }

  stopPlayback(): number {
    const heard = this.playedMs();
    this.activeResponseId = null;
    this.playedSoFarMs = 0;
    this.playbackClears += 1;
    return heard;
  }

  readMicEnergy(): number {
    return this.micEnergy;
  }

  readVoiceEnergy(): number {
    return this.activeResponseId ? this.voiceEnergy : 0;
  }

  close(): void {
    this.state = 'closed';
    this.handlers.onStateChange('closed');
  }

  /** Simulates provider playback boundaries arriving on the data channel. */
  emitBoundary(boundary: PlaybackBoundary, responseId: string | null, playedMs = 0): void {
    if (boundary === 'started') {
      this.activeResponseId = responseId;
      this.playedSoFarMs = 0;
    } else {
      this.playedSoFarMs = 0;
      this.activeResponseId = null;
    }
    this.handlers.onPlaybackBoundary(boundary, responseId, playedMs);
  }

  /** Advances the local playback clock without emitting a boundary. */
  advancePlayback(byMs: number): void {
    this.playedSoFarMs += byMs;
  }

  fail(): void {
    this.state = 'failed';
    this.handlers.onStateChange('failed');
  }
}
