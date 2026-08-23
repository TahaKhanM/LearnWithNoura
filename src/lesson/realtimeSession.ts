import type { BoardOp } from '../../shared/boardOps';
import { AudioOut } from './audioOut';
import { AudioIn } from './audioIn';

/**
 * Owns one live lesson: the WebSocket to the server proxy, microphone
 * capture, speech playback, and the turn discipline that makes
 * interruption feel instant.
 *
 * Synchronisation: the model generates faster than it speaks, so board
 * operations and caption words arrive early. Each is stamped with how
 * much audio had been received for the response at that moment, and
 * released only when playback reaches that point. Interruption drops
 * everything unreleased — stale marks never touch the board.
 */

export type Phase =
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'reconnecting'
  | 'fallback'
  | 'failed'
  | 'ended';

export interface CaptionLine {
  role: 'tutor' | 'child';
  text: string;
  live: boolean;
}

export interface LessonState {
  activeConcept?: string;
  strategy?: string;
  nextStep?: string;
}

export interface EvidenceEntry {
  concept: string;
  observation: string;
  verdict: string;
  confidence: string;
}

export interface TurnMetrics {
  askToFirstAudioMs?: number;
  interruptToSilenceMs?: number;
}

export interface SessionSnapshot {
  phase: Phase;
  micAvailable: boolean;
  micDenied: boolean;
  muted: boolean;
  captions: CaptionLine[];
  lessonState: LessonState;
  evidenceCount: number;
  lastEvidence: EvidenceEntry | null;
  micEnergy: number;
  voiceEnergy: number;
  error: string | null;
  metrics: TurnMetrics;
}

interface StampedOps {
  stampMs: number;
  responseId: string;
  ops: BoardOp[];
  arrivedAt: number;
  eventId: number | null;
}

interface StampedText {
  stampMs: number;
  responseId: string;
  delta: string;
  arrivedAt: number;
}

/** If playback never advances (suspended context), release anyway. */
const SILENT_RELEASE_MS = 5000;

type Listener = () => void;

export class RealtimeSession {
  private ws: WebSocket | null = null;
  private audioOut = new AudioOut();
  private audioIn: AudioIn | null = null;
  private sessionId: string;
  private listeners = new Set<Listener>();
  private snapshot: SessionSnapshot;
  private pendingOps: StampedOps[] = [];
  private pendingText: StampedText[] = [];
  private releaseTimer: number | null = null;
  private currentResponseId: string | null = null;
  /** Responses killed by interruption; their late events must be ignored. */
  private deadResponses = new Set<string>();
  private tutorLine = '';
  /** Which response the live caption line belongs to. */
  private liveLineResponse: string | null = null;
  private reconnectAttempts = 0;
  private closedByUs = false;
  /** Sustained mic energy while the tutor speaks trips a local barge-in. */
  private hotFrames = 0;
  private askAt = 0;
  private firstAudioSeen = false;

  onBoardOps: (ops: BoardOp[], animate: boolean) => void = () => {};
  onEnded: () => void = () => {};

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.snapshot = {
      phase: 'connecting',
      micAvailable: AudioIn.supported(),
      micDenied: false,
      muted: false,
      captions: [],
      lessonState: {},
      evidenceCount: 0,
      lastEvidence: null,
      micEnergy: 0,
      voiceEnergy: 0,
      error: null,
      metrics: {},
    };
  }

  // ----- external store interface for React ---------------------------------

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.snapshot;

  private update(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  // ----- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    await this.audioOut.unlock();
    this.audioOut.onPlaybackEnd = () => this.handlePlaybackEnd();
    if (AudioIn.supported()) {
      this.audioIn = new AudioIn({
        onChunk: (base64) => this.send({ type: 'input_audio', audio: base64 }),
        onEnergy: (rms) => this.handleMicEnergy(rms),
      });
      try {
        await this.audioIn.start();
      } catch {
        this.audioIn = null;
        this.update({ micDenied: true, micAvailable: false });
      }
    }
    this.connect();
    this.releaseTimer = window.setInterval(() => this.releasePending(), 50);
  }

  private connect(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${protocol}://${window.location.host}/ws/lesson?session=${encodeURIComponent(this.sessionId)}`,
    );
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
    };
    ws.onmessage = (event) => {
      try {
        this.handleServer(JSON.parse(String(event.data)));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (this.closedByUs) return;
      this.audioOut.stop();
      if (this.reconnectAttempts < 3) {
        this.reconnectAttempts += 1;
        this.update({ phase: 'reconnecting' });
        window.setTimeout(() => this.connect(), 600 * this.reconnectAttempts);
      } else {
        this.update({
          phase: 'fallback',
          error: 'Voice connection lost — continuing in text mode.',
        });
      }
    };
    ws.onerror = () => {
      /* onclose follows and owns recovery */
    };
  }

  end(): void {
    this.closedByUs = true;
    if (this.releaseTimer !== null) window.clearInterval(this.releaseTimer);
    this.audioIn?.stop();
    void this.audioOut.close();
    this.ws?.close();
    this.update({ phase: 'ended' });
    this.onEnded();
  }

  // ----- user actions --------------------------------------------------------

  sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.snapshot.phase === 'fallback') {
      void this.runFallbackTurn(trimmed);
      return;
    }
    this.interruptLocally('text');
    this.askAt = performance.now();
    this.firstAudioSeen = false;
    this.send({ type: 'user_text', text: trimmed });
    this.update({ phase: 'thinking' });
  }

  setMuted(muted: boolean): void {
    if (this.audioIn) this.audioIn.muted = muted;
    this.update({ muted });
  }

  // ----- barge-in ------------------------------------------------------------

  private handleMicEnergy(rms: number): void {
    if (this.snapshot.micEnergy * 0.7 + rms * 0.3 !== this.snapshot.micEnergy) {
      this.update({ micEnergy: this.snapshot.micEnergy * 0.7 + rms * 0.3 });
    }
    if (this.snapshot.muted) return;
    // Fast local interruption: the tutor is audibly speaking and the child
    // is clearly talking over it. The server's semantic VAD will confirm,
    // but the local stop is what makes it feel instant.
    if (this.audioOut.speaking && rms > 0.03) {
      this.hotFrames += 1;
      if (this.hotFrames >= 4) this.interruptLocally('voice');
    } else {
      this.hotFrames = 0;
    }
  }

  /** Stops sound and stale work now, without waiting for the server. */
  private interruptLocally(reason: 'voice' | 'text' | 'server'): void {
    if (!this.audioOut.speaking && this.pendingOps.length === 0 && this.pendingText.length === 0) {
      return;
    }
    const interruptedAt = performance.now();
    const heard = this.audioOut.stop();
    if (this.currentResponseId !== null) {
      this.deadResponses.add(this.currentResponseId);
      if (this.deadResponses.size > 24) {
        this.deadResponses.delete(this.deadResponses.values().next().value as string);
      }
    }
    this.pendingOps = [];
    this.pendingText = [];
    this.hotFrames = 0;
    this.commitTutorLine();
    // Tell the model exactly how much of each spoken item the child heard.
    for (const item of heard) {
      if (!item.fullyPlayed) {
        this.send({ type: 'truncate', item_id: item.itemId, audio_end_ms: item.heardMs });
      }
    }
    if (reason !== 'server') this.send({ type: 'interrupt' });
    const interruptToSilenceMs = Math.round(performance.now() - interruptedAt);
    this.send({ type: 'metric', name: `interrupt_local_stop_${reason}`, ms: interruptToSilenceMs });
    this.update({
      phase: 'listening',
      metrics: { ...this.snapshot.metrics, interruptToSilenceMs },
    });
  }

  // ----- server events -------------------------------------------------------

  private handleServer(message: Record<string, unknown>): void {
    switch (message.type) {
      case 'ready':
        this.update({ phase: 'listening', error: null });
        this.send({ type: 'start' });
        break;

      case 'board_replay': {
        const batches = Array.isArray(message.batches) ? message.batches : [];
        for (const batch of batches) {
          if (Array.isArray(batch)) this.onBoardOps(batch as BoardOp[], false);
        }
        break;
      }

      case 'response_started':
        this.currentResponseId = typeof message.response_id === 'string' ? message.response_id : null;
        break;

      case 'audio': {
        if (typeof message.delta !== 'string') break;
        const responseId = String(message.response_id ?? '');
        if (this.deadResponses.has(responseId)) break;
        const itemId = typeof message.item_id === 'string' ? message.item_id : null;
        if (!this.firstAudioSeen && this.askAt > 0) {
          this.firstAudioSeen = true;
          const askToFirstAudioMs = Math.round(performance.now() - this.askAt);
          this.send({ type: 'metric', name: 'ask_to_first_audio', ms: askToFirstAudioMs });
          this.update({ metrics: { ...this.snapshot.metrics, askToFirstAudioMs } });
        }
        this.audioOut.append(responseId, itemId, message.delta);
        if (this.snapshot.phase !== 'speaking') this.update({ phase: 'speaking' });
        break;
      }

      case 'transcript_delta': {
        if (typeof message.delta !== 'string') break;
        const responseId = String(message.response_id ?? '');
        if (this.deadResponses.has(responseId)) break;
        this.pendingText.push({
          stampMs: this.audioOut.scheduledMs(responseId),
          responseId,
          delta: message.delta,
          arrivedAt: performance.now(),
        });
        break;
      }

      case 'transcript_done':
        // The full line is already streaming out via deltas; nothing to do.
        break;

      case 'board_ops': {
        if (!Array.isArray(message.ops)) break;
        const responseId = String(message.response_id ?? '');
        if (this.deadResponses.has(responseId)) break;
        this.pendingOps.push({
          stampMs: this.audioOut.scheduledMs(responseId),
          responseId,
          ops: message.ops as BoardOp[],
          arrivedAt: performance.now(),
          eventId: typeof message.event_id === 'number' ? message.event_id : null,
        });
        break;
      }

      case 'user_transcript': {
        const text = String(message.text ?? '');
        if (!text) break;
        this.commitTutorLine();
        this.appendCaption({ role: 'child', text, live: false });
        break;
      }

      case 'speech_started':
        // Server VAD heard the child: stop locally too (usually a no-op —
        // the local energy gate has already fired).
        this.interruptLocally('server');
        this.update({ phase: 'listening' });
        break;

      case 'lesson_state': {
        const state = message.state as LessonState;
        this.update({ lessonState: { ...this.snapshot.lessonState, ...state } });
        break;
      }

      case 'evidence': {
        const entry = message.entry as EvidenceEntry;
        this.update({
          evidenceCount: this.snapshot.evidenceCount + 1,
          lastEvidence: entry,
        });
        break;
      }

      case 'response_done': {
        // If nothing is left to play, we're back to listening.
        if (!this.audioOut.speaking && this.pendingText.length === 0) {
          this.commitTutorLine();
          if (this.snapshot.phase === 'speaking') this.update({ phase: 'listening' });
        }
        break;
      }

      case 'error': {
        const text = String(message.message ?? 'Something went wrong.');
        this.update({ error: text });
        // Transient snags shouldn't linger on a child's screen.
        window.setTimeout(() => {
          if (this.snapshot.error === text) this.update({ error: null });
        }, 6000);
        break;
      }

      case 'upstream_closed':
        // The proxy lost OpenAI; our socket will close next and reconnect.
        break;

      default:
        break;
    }
  }

  // ----- synchronised release ------------------------------------------------

  private shouldRelease(item: { stampMs: number; responseId: string; arrivedAt: number }, leadMs: number): boolean {
    if (this.audioOut.playedMs(item.responseId) + leadMs >= item.stampMs) return true;
    // Backstop for silent/suspended audio: don't hold content forever.
    return performance.now() - item.arrivedAt > SILENT_RELEASE_MS;
  }

  private releasePending(): void {
    const energy = this.audioOut.currentEnergy();
    if (Math.abs(energy - this.snapshot.voiceEnergy) > 0.01) {
      this.update({ voiceEnergy: energy });
    }

    while (this.pendingText.length > 0 && this.shouldRelease(this.pendingText[0], 120)) {
      const item = this.pendingText.shift() as StampedText;
      if (this.liveLineResponse !== item.responseId) {
        // A new spoken segment begins: settle the previous caption line.
        this.commitTutorLine();
        this.liveLineResponse = item.responseId;
      }
      this.tutorLine += item.delta;
      this.showTutorLine();
    }

    while (this.pendingOps.length > 0 && this.shouldRelease(this.pendingOps[0], 60)) {
      const item = this.pendingOps.shift() as StampedOps;
      this.releaseOps(item);
    }
  }

  /** Puts a batch on the board and confirms it as seen, for honest replay. */
  private releaseOps(item: StampedOps): void {
    this.onBoardOps(item.ops, true);
    if (item.eventId !== null) this.send({ type: 'ops_shown', event_id: item.eventId });
  }

  private handlePlaybackEnd(): void {
    // Natural end of speech: flush what the stamps didn't quite release,
    // still respecting caption boundaries between spoken segments.
    for (const item of this.pendingText) {
      if (this.liveLineResponse !== item.responseId) {
        this.commitTutorLine();
        this.liveLineResponse = item.responseId;
      }
      this.tutorLine += item.delta;
    }
    this.pendingText = [];
    this.showTutorLine();
    for (const item of this.pendingOps) this.releaseOps(item);
    this.pendingOps = [];
    if (this.snapshot.phase === 'speaking') {
      this.commitTutorLine();
      this.update({ phase: 'listening' });
    }
  }

  // ----- captions -------------------------------------------------------------

  private showTutorLine(): void {
    if (!this.tutorLine.trim()) return;
    const captions = [...this.snapshot.captions];
    const last = captions[captions.length - 1];
    if (last?.role === 'tutor' && last.live) {
      captions[captions.length - 1] = { ...last, text: this.tutorLine };
    } else {
      captions.push({ role: 'tutor', text: this.tutorLine, live: true });
    }
    this.update({ captions: captions.slice(-80) });
  }

  private commitTutorLine(): void {
    if (this.tutorLine.trim()) {
      const captions = [...this.snapshot.captions];
      const last = captions[captions.length - 1];
      if (last?.role === 'tutor' && last.live) {
        captions[captions.length - 1] = { ...last, text: this.tutorLine, live: false };
        this.update({ captions });
      }
    }
    this.tutorLine = '';
  }

  private appendCaption(line: CaptionLine): void {
    this.update({ captions: [...this.snapshot.captions, line].slice(-80) });
  }

  // ----- fallback text mode ----------------------------------------------------

  private async runFallbackTurn(text: string): Promise<void> {
    this.appendCaption({ role: 'child', text, live: false });
    this.update({ phase: 'thinking' });
    try {
      const response = await fetch('/api/fallback-turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sessionId, text }),
      });
      if (!response.ok || !response.body) throw new Error(`fallback failed (${response.status})`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            this.handleFallbackStep(JSON.parse(line));
          } catch {
            /* skip malformed line */
          }
        }
      }
    } catch {
      this.update({ error: 'The tutor is unreachable right now.' });
    } finally {
      if (this.snapshot.phase === 'thinking') this.update({ phase: 'fallback' });
    }
  }

  private handleFallbackStep(step: Record<string, unknown>): void {
    if (step.type === 'say' && typeof step.text === 'string') {
      this.appendCaption({ role: 'tutor', text: step.text, live: false });
    } else if (step.type === 'board_ops' && Array.isArray(step.ops)) {
      this.onBoardOps(step.ops as BoardOp[], true);
    } else if (step.type === 'evidence') {
      this.update({ evidenceCount: this.snapshot.evidenceCount + 1 });
    } else if (step.type === 'error') {
      this.update({ error: String(step.message ?? 'The tutor failed.') });
    }
  }

  // ----- misc -------------------------------------------------------------------

  sendBoardEvent(description: string): void {
    this.send({ type: 'board_event', description });
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }
}
