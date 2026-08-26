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
export type VoiceTransportState = 'new' | 'connecting' | 'connected' | 'failed' | 'closed';

export interface VoiceTransportHandlers {
  /** A provider playback boundary, with how long this response has played. */
  onPlaybackBoundary: (boundary: PlaybackBoundary, responseId: string | null, playedMs: number) => void;
  onStateChange: (state: VoiceTransportState) => void;
}

export interface VoiceTransport {
  readonly state: VoiceTransportState;
  /** Requests the microphone, negotiates the call, and starts playback. */
  connect(): Promise<void>;
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
  private playbackStartedAt = 0;
  private micMuted = false;

  constructor(input: { sessionId: string; lessonCapability: string; handlers: VoiceTransportHandlers }) {
    this.sessionId = input.sessionId;
    this.lessonCapability = input.lessonCapability;
    this.handlers = input.handlers;
  }

  static supported(): boolean {
    return typeof navigator !== 'undefined' &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof RTCPeerConnection !== 'undefined';
  }

  async connect(): Promise<void> {
    if (this.state !== 'new') return;
    this.setState('connecting');
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const pc = new RTCPeerConnection();
      this.pc = pc;
      for (const track of this.micStream.getAudioTracks()) {
        track.enabled = !this.micMuted;
        pc.addTrack(track, this.micStream);
      }
      pc.ontrack = (event) => this.attachRemoteTrack(event.streams[0] ?? new MediaStream([event.track]));
      const dataChannel = pc.createDataChannel('oai-events');
      dataChannel.onmessage = (event) => this.handleDataChannelMessage(String(event.data));
      this.dataChannel = dataChannel;
      pc.onconnectionstatechange = () => {
        if (!this.pc) return;
        if (pc.connectionState === 'connected') this.setState('connected');
        // A short blip may recover on its own; `failed` is terminal for this
        // negotiation. The session degrades to captions (sideband transcripts
        // keep flowing) rather than hanging silently.
        if (pc.connectionState === 'failed') this.setState('failed');
      };
      this.attachMicAnalyser(this.micStream);

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
      this.setState('connected');
    } catch (error) {
      this.close('failed');
      throw error;
    }
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    for (const track of this.micStream?.getAudioTracks() ?? []) track.enabled = !muted;
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
    if (this.dataChannel?.readyState === 'open') {
      try { this.dataChannel.send(JSON.stringify({ type: 'output_audio_buffer.clear' })); }
      catch { /* the provider's cleared event is a courtesy, not a dependency */ }
    }
    this.activeResponseId = null;
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
    this.setState(finalState);
  }

  private setState(state: VoiceTransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onStateChange(state);
  }

  private attachRemoteTrack(stream: MediaStream): void {
    if (!this.audioElement) {
      this.audioElement = document.createElement('audio');
      this.audioElement.autoplay = true;
      this.audioElement.style.display = 'none';
      document.body.appendChild(this.audioElement);
    }
    this.audioElement.srcObject = stream;
    this.audioElement.muted = false;
    void this.audioElement.play().catch(() => {
      /* autoplay policy: playback resumes on the next user gesture */
    });
    const context = this.context();
    this.voiceAnalyser = context.createAnalyser();
    this.voiceAnalyser.fftSize = ANALYSER_FFT_SIZE;
    context.createMediaStreamSource(stream).connect(this.voiceAnalyser);
  }

  private attachMicAnalyser(stream: MediaStream): void {
    const context = this.context();
    this.micAnalyser = context.createAnalyser();
    this.micAnalyser.fftSize = ANALYSER_FFT_SIZE;
    context.createMediaStreamSource(stream).connect(this.micAnalyser);
  }

  private context(): AudioContext {
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
        this.activeResponseId = responseId;
        this.playbackStartedAt = performance.now();
        if (this.audioElement) this.audioElement.muted = false;
        this.handlers.onPlaybackBoundary('started', responseId, 0);
        break;
      }
      case 'output_audio_buffer.stopped': {
        const playedMs = this.playedMs();
        const stopped = this.activeResponseId ?? responseId;
        this.activeResponseId = null;
        this.handlers.onPlaybackBoundary('stopped', stopped, playedMs);
        break;
      }
      case 'output_audio_buffer.cleared': {
        const playedMs = this.playedMs();
        const cleared = this.activeResponseId ?? responseId;
        this.activeResponseId = null;
        this.handlers.onPlaybackBoundary('cleared', cleared, playedMs);
        break;
      }
      default:
        break;
    }
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
