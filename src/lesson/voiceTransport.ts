/**
 * The lesson's voice plane: a direct browser ↔ provider WebRTC call.
 *
 * The microphone track goes up and the tutor's voice comes back as a remote
 * media track that the browser plays natively — no PCM ever transits the
 * server. The provider's data channel marks real playback boundaries
 * (`output_audio_buffer.started/stopped/cleared`), which the session uses to
 * bind board reveals, task delivery, and truncation to what the child has
 * actually heard. All control (session config, tools, response ownership)
 * lives on the server sideband; this transport never sees the API key.
 */

export type PlaybackBoundary = 'started' | 'stopped' | 'cleared';
export type VoiceTransportState = 'new' | 'connecting' | 'connected' | 'blocked' | 'failed' | 'closed';
export type PlaybackFailureReason = 'autoplay_blocked' | 'connection_failed' | 'not_played';

export interface VoiceTransportHandlers {
  /** A provider playback boundary, with how long this response has played. */
  onPlaybackBoundary: (boundary: PlaybackBoundary, responseId: string | null, playedMs: number) => void;
  onStateChange: (state: VoiceTransportState) => void;
  onMicrophoneState?: (available: boolean, denied: boolean) => void;
  onPlaybackFailure?: (responseId: string | null, reason: PlaybackFailureReason) => void;
}

export interface VoiceTransport {
  readonly state: VoiceTransportState;
  /** Requests the microphone, negotiates the call, and starts playback. */
  connect(): Promise<void>;
  /** Correlates an independently delivered sideband response with WebRTC
   * playback events that may omit or race its response id. */
  noteResponse(responseId: string): void;
  /** Prevents a cancelled response from becoming audible if a late provider
   * buffer-start event races the local clear. */
  suppressResponse(responseId: string): void;
  /** Explicit recovery for browser autoplay policy. Must be callable from a
   * learner gesture and reports whether local media playback resumed. */
  resumePlayback(): Promise<boolean>;
  setMicMuted(muted: boolean): void;
  /** The response the provider is audibly playing right now, if any. */
  playingResponseId(): string | null;
  /** How long the currently playing response has been audible, in ms. */
  playedMs(): number;
  /**
   * Immediate local silence for barge-in: mutes the remote track and asks the
   * provider to drop its buffered audio. Returns how much of the active
   * response the child actually heard.
   */
  stopPlayback(): number;
  /** Local microphone loudness (RMS 0..~1) for the barge-in gate and meter. */
  readMicEnergy(): number;
  /** Tutor voice loudness (RMS 0..~1) driving the avatar's mouth. */
  readVoiceEnergy(): number;
  close(): void;
}

const ICE_GATHERING_TIMEOUT_MS = 2_000;
export const MICROPHONE_PERMISSION_TIMEOUT_MS = 3_000;
const ANALYSER_FFT_SIZE = 1024;

export class WebRtcVoiceTransport implements VoiceTransport {
  state: VoiceTransportState = 'new';

  private readonly sessionId: string;
  private readonly lessonCapability: string;
  private readonly handlers: VoiceTransportHandlers;
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private micStream: MediaStream | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private analyserContext: AudioContext | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private voiceAnalyser: AnalyserNode | null = null;
  private analyserFrame = new Float32Array(ANALYSER_FFT_SIZE);
  private activeResponseId: string | null = null;
  private providerResponseId: string | null = null;
  private responseHint: string | null = null;
  private providerBufferActive = false;
  private playbackStartedAt = 0;
  private micMuted = false;
  private mediaPlaying = false;
  private resumeListenersArmed = false;
  private suppressedResponses = new Set<string>();

  constructor(input: { sessionId: string; lessonCapability: string; handlers: VoiceTransportHandlers }) {
    this.sessionId = input.sessionId;
    this.lessonCapability = input.lessonCapability;
    this.handlers = input.handlers;
  }

  static supported(): boolean {
    return typeof RTCPeerConnection !== 'undefined';
  }

  static microphoneSupported(): boolean {
    return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
  }

  async connect(): Promise<void> {
    if (this.state !== 'new') return;
    this.setState('connecting');
    try {
      const pc = new RTCPeerConnection();
      this.pc = pc;
      this.ensureAudioElement();
      const microphone = await this.requestMicrophone();
      if (
        this.pc !== pc
        || (this.state as VoiceTransportState) === 'closed'
        || (this.state as VoiceTransportState) === 'failed'
      ) {
        for (const track of microphone.stream?.getAudioTracks() ?? []) track.stop();
        throw new DOMException('Voice connection was closed.', 'AbortError');
      }
      this.micStream = microphone.stream;
      const micTracks = this.micStream?.getAudioTracks() ?? [];
      if (micTracks.length > 0 && this.micStream) {
        this.handlers.onMicrophoneState?.(true, false);
        for (const track of micTracks) {
          track.enabled = !this.micMuted;
          pc.addTrack(track, this.micStream);
        }
        this.attachMicAnalyser(this.micStream);
      } else {
        this.handlers.onMicrophoneState?.(false, microphone.denied);
        // A denied/missing microphone must not prevent typed lessons, tutor
        // audio, or subtitles. A permission prompt that is ignored is bounded
        // too: negotiate a listen-only media section instead of leaving the
        // lesson on “Waking Noura up…” indefinitely.
        pc.addTransceiver('audio', { direction: 'recvonly' });
      }
      pc.ontrack = (event) => this.attachRemoteTrack(event.streams[0] ?? new MediaStream([event.track]));
      const dataChannel = pc.createDataChannel('oai-events');
      dataChannel.onmessage = (event) => this.handleDataChannelMessage(String(event.data));
      this.dataChannel = dataChannel;
      pc.onconnectionstatechange = () => {
        if (!this.pc) return;
        if (pc.connectionState === 'connected' && this.state !== 'blocked') this.setState('connected');
        // A short blip may recover on its own; `failed` is terminal for this
        // negotiation. The session degrades to captions (sideband transcripts
        // keep flowing) rather than hanging silently.
        if (pc.connectionState === 'failed') this.failMediaConnection();
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.waitForIceGathering(pc);
      const offerSdp = pc.localDescription?.sdp ?? offer.sdp ?? '';
      const response = await fetch(`/api/webrtc-call?session=${encodeURIComponent(this.sessionId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', Authorization: `Lesson ${this.lessonCapability}` },
        body: offerSdp,
      });
      if (!response.ok) throw new Error(`voice call bootstrap failed (${response.status})`);
      const answerSdp = await response.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      if ((this.state as VoiceTransportState) !== 'blocked') this.setState('connected');
    } catch (error) {
      this.close('failed');
      throw error;
    }
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    for (const track of this.micStream?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  noteResponse(responseId: string): void {
    if (!responseId) return;
    this.responseHint = responseId;
    if (this.providerBufferActive && !this.providerResponseId) {
      this.providerResponseId = responseId;
      this.startLocalBoundaryIfReady();
    }
  }

  suppressResponse(responseId: string): void {
    if (!responseId) return;
    this.suppressedResponses.add(responseId);
    if (this.suppressedResponses.size > 64) {
      this.suppressedResponses.delete(this.suppressedResponses.values().next().value as string);
    }
  }

  async resumePlayback(): Promise<boolean> {
    const audio = this.audioElement;
    if (!audio || !audio.srcObject || this.state === 'closed' || this.state === 'failed') return false;
    try {
      await audio.play();
      this.mediaPlaying = !audio.paused;
      this.disarmResumeListeners();
      if (this.state === 'blocked') this.setState('connected');
      this.startLocalBoundaryIfReady();
      return this.mediaPlaying;
    } catch {
      this.mediaPlaying = false;
      this.setState('blocked');
      this.armResumeListeners();
      this.handlers.onPlaybackFailure?.(this.providerResponseId ?? this.responseHint, 'autoplay_blocked');
      return false;
    }
  }

  playingResponseId(): string | null {
    return this.activeResponseId;
  }

  playedMs(): number {
    if (!this.activeResponseId) return 0;
    return Math.max(0, Math.round(performance.now() - this.playbackStartedAt));
  }

  stopPlayback(): number {
    const heardMs = this.playedMs();
    if (this.audioElement) this.audioElement.muted = true;
    this.clearProviderBuffer();
    this.activeResponseId = null;
    this.providerResponseId = null;
    this.providerBufferActive = false;
    this.responseHint = null;
    return heardMs;
  }

  readMicEnergy(): number {
    return this.readAnalyser(this.micAnalyser);
  }

  readVoiceEnergy(): number {
    if (!this.activeResponseId) return 0;
    return this.readAnalyser(this.voiceAnalyser);
  }

  close(finalState: VoiceTransportState = 'closed'): void {
    if (this.state === 'closed') return;
    for (const track of this.micStream?.getAudioTracks() ?? []) track.stop();
    this.micStream = null;
    this.dataChannel = null;
    this.disarmResumeListeners();
    try { this.pc?.close(); } catch { /* already closed */ }
    this.pc = null;
    if (this.audioElement) {
      this.audioElement.srcObject = null;
      this.audioElement.remove();
      this.audioElement = null;
    }
    void this.analyserContext?.close().catch(() => undefined);
    this.analyserContext = null;
    this.micAnalyser = null;
    this.voiceAnalyser = null;
    this.activeResponseId = null;
    this.providerResponseId = null;
    this.responseHint = null;
    this.providerBufferActive = false;
    this.mediaPlaying = false;
    this.setState(finalState);
  }

  private setState(state: VoiceTransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onStateChange(state);
  }

  private attachRemoteTrack(stream: MediaStream): void {
    const audio = this.ensureAudioElement();
    audio.srcObject = stream;
    audio.muted = false;
    for (const track of stream.getAudioTracks?.() ?? []) {
      track.addEventListener('ended', () => this.failMediaConnection());
    }
    void this.resumePlayback();
    try {
      const context = this.context();
      if (!context) return;
      this.voiceAnalyser = context.createAnalyser();
      this.voiceAnalyser.fftSize = ANALYSER_FFT_SIZE;
      context.createMediaStreamSource(stream).connect(this.voiceAnalyser);
    } catch {
      this.voiceAnalyser = null;
    }
  }

  private attachMicAnalyser(stream: MediaStream): void {
    try {
      const context = this.context();
      if (!context) return;
      this.micAnalyser = context.createAnalyser();
      this.micAnalyser.fftSize = ANALYSER_FFT_SIZE;
      context.createMediaStreamSource(stream).connect(this.micAnalyser);
    } catch {
      // Metering and barge-in energy are optional observers. They must never
      // abort SDP negotiation, remote audio, or subtitles.
      this.micAnalyser = null;
    }
  }

  private context(): AudioContext | null {
    if (typeof AudioContext === 'undefined') return null;
    if (!this.analyserContext) this.analyserContext = new AudioContext();
    if (this.analyserContext.state === 'suspended') void this.analyserContext.resume().catch(() => undefined);
    return this.analyserContext;
  }

  private readAnalyser(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(this.analyserFrame);
    let sum = 0;
    for (let index = 0; index < this.analyserFrame.length; index += 1) {
      sum += this.analyserFrame[index] * this.analyserFrame[index];
    }
    return Math.sqrt(sum / this.analyserFrame.length);
  }

  private handleDataChannelMessage(raw: string): void {
    let event: { type?: unknown; response_id?: unknown };
    try { event = JSON.parse(raw) as { type?: unknown; response_id?: unknown }; }
    catch { return; }
    const responseId = typeof event.response_id === 'string' ? event.response_id : null;
    switch (event.type) {
      case 'output_audio_buffer.started': {
        this.providerBufferActive = true;
        this.providerResponseId = responseId ?? this.responseHint;
        if (this.providerResponseId && this.suppressedResponses.has(this.providerResponseId)) {
          if (this.audioElement) this.audioElement.muted = true;
          this.clearProviderBuffer();
          this.providerBufferActive = false;
          this.providerResponseId = null;
          break;
        }
        if (this.audioElement) this.audioElement.muted = false;
        this.startLocalBoundaryIfReady();
        if (!this.mediaPlaying) void this.resumePlayback();
        break;
      }
      case 'output_audio_buffer.stopped': {
        this.finishProviderBoundary('stopped', responseId);
        break;
      }
      case 'output_audio_buffer.cleared': {
        this.finishProviderBoundary('cleared', responseId);
        break;
      }
      default:
        break;
    }
  }

  private ensureAudioElement(): HTMLAudioElement {
    if (this.audioElement) return this.audioElement;
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.preload = 'auto';
    audio.style.display = 'none';
    audio.addEventListener('playing', () => {
      this.mediaPlaying = true;
      this.disarmResumeListeners();
      if (this.state === 'blocked') this.setState('connected');
      this.startLocalBoundaryIfReady();
    });
    audio.addEventListener('pause', () => { this.mediaPlaying = false; });
    audio.addEventListener('error', () => this.failMediaConnection());
    document.body.appendChild(audio);
    this.audioElement = audio;
    return audio;
  }

  private startLocalBoundaryIfReady(): void {
    const responseId = this.providerResponseId;
    if (!this.providerBufferActive || !this.mediaPlaying || !responseId || this.activeResponseId === responseId) return;
    this.activeResponseId = responseId;
    this.playbackStartedAt = performance.now();
    this.handlers.onPlaybackBoundary('started', responseId, 0);
  }

  private finishProviderBoundary(boundary: Exclude<PlaybackBoundary, 'started'>, eventResponseId: string | null): void {
    const responseId = this.activeResponseId ?? this.providerResponseId ?? eventResponseId ?? this.responseHint;
    const playedMs = this.playedMs();
    const locallyStarted = this.activeResponseId !== null;
    this.activeResponseId = null;
    this.providerResponseId = null;
    this.providerBufferActive = false;
    if (responseId === this.responseHint) this.responseHint = null;
    if (locallyStarted) this.handlers.onPlaybackBoundary(boundary, responseId, playedMs);
    else this.handlers.onPlaybackFailure?.(responseId, 'not_played');
  }

  private clearProviderBuffer(): void {
    if (this.dataChannel?.readyState !== 'open') return;
    try { this.dataChannel.send(JSON.stringify({ type: 'output_audio_buffer.clear' })); }
    catch { /* a sideband cancel still follows */ }
  }

  private readonly resumeFromGesture = (): void => { void this.resumePlayback(); };

  private failMediaConnection(): void {
    if (this.state === 'closed' || this.state === 'failed') return;
    this.handlers.onPlaybackFailure?.(this.activeResponseId ?? this.providerResponseId ?? this.responseHint, 'connection_failed');
    this.activeResponseId = null;
    this.providerResponseId = null;
    this.providerBufferActive = false;
    this.mediaPlaying = false;
    this.setState('failed');
  }

  private armResumeListeners(): void {
    if (this.resumeListenersArmed) return;
    this.resumeListenersArmed = true;
    document.addEventListener('pointerdown', this.resumeFromGesture, true);
    document.addEventListener('keydown', this.resumeFromGesture, true);
    document.addEventListener('touchend', this.resumeFromGesture, true);
  }

  private disarmResumeListeners(): void {
    if (!this.resumeListenersArmed) return;
    this.resumeListenersArmed = false;
    document.removeEventListener('pointerdown', this.resumeFromGesture, true);
    document.removeEventListener('keydown', this.resumeFromGesture, true);
    document.removeEventListener('touchend', this.resumeFromGesture, true);
  }

  private requestMicrophone(): Promise<{ stream: MediaStream | null; denied: boolean }> {
    const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    if (!getUserMedia) return Promise.resolve({ stream: null, denied: false });

    return new Promise((resolve) => {
      let finished = false;
      const finish = (result: { stream: MediaStream | null; denied: boolean }) => {
        if (finished) {
          for (const track of result.stream?.getAudioTracks() ?? []) track.stop();
          return;
        }
        finished = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ stream: null, denied: false }),
        MICROPHONE_PERMISSION_TIMEOUT_MS,
      );

      void getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }).then(
        (stream) => finish({ stream, denied: false }),
        (error: unknown) => finish({
          stream: null,
          denied: error instanceof DOMException && error.name === 'NotAllowedError',
        }),
      );
    });
  }

  private waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
      function finish(): void {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
      function onChange(): void {
        if (pc.iceGatheringState === 'complete') finish();
      }
      pc.addEventListener('icegatheringstatechange', onChange);
    });
  }
}
