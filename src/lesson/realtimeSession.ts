import type { BoardOp } from '../../shared/boardOps';
import {
  createRuntimeEvent,
  RuntimeEventEnvelopeSchema,
  RuntimeEventGate,
  type GenerationIdentity,
  type RuntimeEventEnvelope,
} from '../../shared/runtimeProtocol';
import { AudioOut } from './audioOut';
import { AudioIn } from './audioIn';
import { GenerationScope } from './generationScope';

export type Phase = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'reconnecting' | 'fallback' | 'failed' | 'ended';
export interface CaptionLine { role: 'tutor' | 'child'; text: string; live: boolean; responseId?: string }
export interface LessonState { activeConcept?: string; strategy?: string; nextStep?: string }
export interface EvidenceEntry { concept: string; observation: string; verdict: string; confidence: string }
export interface TurnMetrics { askToFirstAudioMs?: number; detectorToStopScheduledMs?: number; providerCancelConfirmationMs?: number }
export interface SessionSnapshot {
  phase: Phase;
  identity: GenerationIdentity;
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

interface StampedOps { stampMs: number; responseId: string; ops: BoardOp[]; eventId: number | null; identity: GenerationIdentity }
interface StampedText { stampMs: number; responseId: string; delta: string; identity: GenerationIdentity }
interface QueuedAsk { text: string; idempotencyKey: string; identity: GenerationIdentity }

type Listener = () => void;
const CONNECT_TIMEOUT_MS = 8_000;
const MAX_RECONNECTS = 2;

export class RealtimeSession {
  private ws: WebSocket | null = null;
  private audioOut = new AudioOut();
  private audioIn: AudioIn | null = null;
  private readonly sessionId: string;
  private listeners = new Set<Listener>();
  private snapshot: SessionSnapshot;
  private pendingOps: StampedOps[] = [];
  private pendingText: StampedText[] = [];
  private phraseBuffers = new Map<string, string>();
  private currentResponseId: string | null = null;
  private deadResponses = new Set<string>();
  private reconnectAttempts = 0;
  private closedByUs = false;
  private started = false;
  private hotFrames = 0;
  private askAt = 0;
  private cancelRequestedAt = 0;
  private firstAudioSeen = false;
  private connectionEpoch = 0;
  private turnCounter = 0;
  private generationCounter = 0;
  private outboundSequence = 0;
  private latestQueuedAsk: QueuedAsk | null = null;
  private lessonCapability: string | null;
  private scope: GenerationScope;
  private gate: RuntimeEventGate;

  onBoardOps: (ops: BoardOp[], animate: boolean, identity: GenerationIdentity) => Promise<boolean | void> | boolean | void = () => {};
  onGenerationCancelled: (identity: GenerationIdentity) => void = () => {};
  onEnded: () => void = () => {};

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.lessonCapability = window.sessionStorage.getItem(`noura.lessonCapability.${sessionId}`);
    const identity = this.makeIdentity();
    this.scope = new GenerationScope(identity);
    this.gate = new RuntimeEventGate(identity);
    this.snapshot = {
      phase: 'connecting', identity, micAvailable: AudioIn.supported(), micDenied: false, muted: false,
      captions: [], lessonState: {}, evidenceCount: 0, lastEvidence: null,
      micEnergy: 0, voiceEnergy: 0, error: null, metrics: {},
    };
  }

  subscribe = (listener: Listener): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = (): SessionSnapshot => this.snapshot;
  getIdentity = (): GenerationIdentity => this.scope.identity;

  private update(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  async start(): Promise<void> {
    if (this.started && !this.closedByUs) return;
    this.started = true;
    this.closedByUs = false;
    this.reconnectAttempts = 0;
    this.connectionEpoch += 1;
    this.activateScope(false);
    this.update({ phase: 'connecting' });
    await this.audioOut.unlock();
    this.audioOut.onPlaybackEnd = () => this.handlePlaybackEnd();
    if (AudioIn.supported()) {
      this.audioIn = new AudioIn({
        onChunk: (audio) => this.send('input_audio', { audio }),
        onEnergy: (rms) => this.handleMicEnergy(rms),
      });
      try { await this.audioIn.start(); }
      catch { this.audioIn = null; this.update({ micDenied: true, micAvailable: false }); }
    }
    this.connect();
  }

  private connect(): void {
    if (this.closedByUs || this.snapshot.phase === 'ended') return;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    if (!this.lessonCapability) {
      this.update({ phase: 'failed', error: 'This lesson link is missing its short-lived access capability. Return to Parent setup.' });
      return;
    }
    const ws = new WebSocket(
      `${protocol}://${window.location.host}/ws/lesson?session=${encodeURIComponent(this.sessionId)}`,
      ['noura.v1', `cap.${this.lessonCapability}`],
    );
    this.ws = ws;
    const identity = this.scope.identity;
    this.scope.timeout(() => {
      if (this.ws === ws && ws.readyState !== WebSocket.OPEN) ws.close();
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (!this.isCurrent(identity)) { ws.close(); return; }
      this.send('hello', {});
    };
    ws.onmessage = (event) => {
      try { this.handleServer(JSON.parse(String(event.data))); }
      catch { /* malformed frames never mutate state */ }
    };
    ws.onclose = () => {
      if (this.closedByUs || this.ws !== ws) return;
      this.cancelGeneration('transport closed');
      this.audioOut.stop();
      if (this.reconnectAttempts < MAX_RECONNECTS) {
        this.reconnectAttempts += 1;
        this.connectionEpoch += 1;
        this.activateScope(false);
        if (this.latestQueuedAsk) this.latestQueuedAsk = { ...this.latestQueuedAsk, identity: this.scope.identity };
        this.update({ phase: 'reconnecting' });
        this.scope.timeout(() => this.connect(), 600 * this.reconnectAttempts);
      } else {
        this.generationCounter += 1;
        this.activateScope(false);
        this.update({ phase: 'fallback', error: 'Voice connection lost — continuing in captions-only text mode.' });
        const ask = this.latestQueuedAsk;
        this.latestQueuedAsk = null;
        if (ask) void this.runFallbackTurn(ask.text, ask.idempotencyKey, this.scope);
      }
    };
    ws.onerror = () => { /* close owns recovery */ };
  }

  end(): void {
    if (this.closedByUs) return;
    this.closedByUs = true;
    this.cancelGeneration('lesson ended');
    this.audioIn?.stop();
    this.audioIn = null;
    void this.audioOut.close();
    this.ws?.close();
    this.ws = null;
    this.update({ phase: 'ended' });
    this.onEnded();
  }

  sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.snapshot.phase === 'ended') return;
    const wasFallback = this.snapshot.phase === 'fallback';
    const wasReconnecting = this.snapshot.phase === 'reconnecting';
    this.interruptLocally('text');
    this.turnCounter += 1;
    this.activateScope(true);
    this.askAt = performance.now();
    this.firstAudioSeen = false;
    const idempotencyKey = `${this.sessionId}:${this.scope.identity.turnId}:${crypto.randomUUID()}`;
    if (wasFallback) {
      this.update({ phase: 'fallback' });
      void this.runFallbackTurn(trimmed, idempotencyKey, this.scope);
      return;
    }
    if (this.ws?.readyState !== WebSocket.OPEN || wasReconnecting) {
      this.latestQueuedAsk = { text: trimmed, idempotencyKey, identity: this.scope.identity };
      this.update({ phase: 'reconnecting' });
      this.scope.timeout(() => this.connect(), 0);
      return;
    }
    this.send('user_text', { text: trimmed, idempotencyKey });
    this.update({ phase: 'thinking' });
  }

  setMuted(muted: boolean): void {
    if (this.audioIn) this.audioIn.muted = muted;
    this.update({ muted });
  }

  beginLearnerActivity(): void {
    if (!['speaking', 'thinking'].includes(this.snapshot.phase)) return;
    this.interruptLocally('interaction');
    this.turnCounter += 1;
    this.activateScope(true);
    this.update({ phase: 'listening' });
  }

  private handleMicEnergy(rms: number): void {
    const nextEnergy = this.snapshot.micEnergy * 0.7 + rms * 0.3;
    if (Math.abs(nextEnergy - this.snapshot.micEnergy) > 0.002) this.update({ micEnergy: nextEnergy });
    if (this.snapshot.muted) return;
    if (this.audioOut.speaking && rms > 0.03) {
      this.hotFrames += 1;
      if (this.hotFrames === 4) {
        this.interruptLocally('voice');
        this.turnCounter += 1;
        this.activateScope(true);
      }
    } else this.hotFrames = 0;
  }

  private markResponseDead(responseId: string | null): void {
    if (!responseId) return;
    this.deadResponses.add(responseId);
    if (this.deadResponses.size > 48) this.deadResponses.delete(this.deadResponses.values().next().value as string);
  }

  private interruptLocally(reason: 'voice' | 'text' | 'server' | 'interaction'): void {
    const identity = this.scope.identity;
    this.markResponseDead(this.currentResponseId);
    const detectorAt = performance.now();
    const heard = this.audioOut.stop();
    const detectorToStopScheduledMs = Math.max(0, performance.now() - detectorAt);
    this.pendingOps = [];
    this.pendingText = [];
    this.phraseBuffers.clear();
    this.hotFrames = 0;
    this.cancelGeneration(`interrupted by ${reason}`);
    for (const item of heard) {
      if (!item.fullyPlayed) this.sendUsingIdentity(identity, 'truncate', { item_id: item.itemId, audio_end_ms: item.heardMs });
    }
    if (reason !== 'server') {
      this.cancelRequestedAt = performance.now();
      this.sendUsingIdentity(identity, 'interrupt', { reason });
    }
    this.update({ phase: 'listening', metrics: { ...this.snapshot.metrics, detectorToStopScheduledMs } });
  }

  private handleServer(raw: unknown): void {
    const parsed = RuntimeEventEnvelopeSchema.safeParse(raw);
    if (!parsed.success || !this.gate.accept(parsed.data)) return;
    const envelope = parsed.data as RuntimeEventEnvelope<Record<string, unknown>>;
    const message = envelope.payload ?? {};
    const type = envelope.type;
    switch (type) {
      case 'ready': {
        this.reconnectAttempts = 0;
        this.update({ phase: 'listening', error: null });
        this.send('start', {});
        const ask = this.latestQueuedAsk;
        this.latestQueuedAsk = null;
        if (ask && this.isCurrent(ask.identity)) {
          this.send('user_text', { text: ask.text, idempotencyKey: ask.idempotencyKey });
          this.update({ phase: 'thinking' });
        }
        break;
      }
      case 'board_replay': {
        const batches = Array.isArray(message.batches) ? message.batches : [];
        for (const batch of batches) if (Array.isArray(batch)) void this.onBoardOps(batch as BoardOp[], false, envelope);
        break;
      }
      case 'response_started': {
        this.currentResponseId = typeof message.response_id === 'string' ? message.response_id : null;
        if (this.currentResponseId) this.scope.providerResponseIds.add(this.currentResponseId);
        break;
      }
      case 'audio': {
        if (typeof message.delta !== 'string') break;
        const responseId = String(message.response_id ?? '');
        if (this.deadResponses.has(responseId)) break;
        this.currentResponseId = responseId;
        const itemId = typeof message.item_id === 'string' ? message.item_id : null;
        if (!this.firstAudioSeen && this.askAt > 0) {
          this.firstAudioSeen = true;
          const askToFirstAudioMs = Math.round(performance.now() - this.askAt);
          this.send('metric', { name: 'ask_to_first_audio', ms: askToFirstAudioMs });
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
        this.pendingText.push({ stampMs: this.audioOut.scheduledMs(responseId), responseId, delta: message.delta, identity: envelope });
        break;
      }
      case 'transcript_done': {
        const responseId = String(message.response_id ?? '');
        const text = String(message.text ?? '').trim();
        if (text && !this.deadResponses.has(responseId)) this.applyFinalTranscript(responseId, text);
        break;
      }
      case 'board_ops': {
        if (!Array.isArray(message.ops)) break;
        const responseId = String(message.response_id ?? '');
        if (this.deadResponses.has(responseId)) break;
        this.pendingOps.push({ stampMs: this.audioOut.scheduledMs(responseId), responseId, ops: message.ops as BoardOp[], eventId: typeof message.event_id === 'number' ? message.event_id : null, identity: envelope });
        break;
      }
      case 'user_transcript': {
        const text = String(message.text ?? '').trim();
        if (text) this.appendCaption({ role: 'child', text, live: false });
        break;
      }
      case 'speech_started': {
        this.interruptLocally('server');
        this.turnCounter += 1;
        this.activateScope(true);
        this.update({ phase: 'listening' });
        break;
      }
      case 'lesson_state': this.update({ lessonState: { ...this.snapshot.lessonState, ...(message.state as LessonState) } }); break;
      case 'evidence': {
        const entry = message.entry as unknown as EvidenceEntry;
        this.update({ evidenceCount: this.snapshot.evidenceCount + 1, lastEvidence: entry });
        break;
      }
      case 'response_done': {
        if (message.status === 'cancelled' && this.cancelRequestedAt > 0) {
          const providerCancelConfirmationMs = Math.round(performance.now() - this.cancelRequestedAt);
          this.update({ metrics: { ...this.snapshot.metrics, providerCancelConfirmationMs } });
          this.cancelRequestedAt = 0;
        }
        if (!this.audioOut.speaking && this.pendingText.length === 0 && this.snapshot.phase === 'speaking') this.update({ phase: 'listening' });
        break;
      }
      case 'safe_question': {
        const text = String(message.text ?? '').trim();
        if (text) this.appendCaption({ role: 'tutor', text, live: false });
        this.update({ phase: 'listening' });
        break;
      }
      case 'error': {
        const text = String(message.message ?? 'Something went wrong.');
        this.update({ error: text });
        this.scope.timeout(() => { if (this.snapshot.error === text) this.update({ error: null }); }, 6000);
        break;
      }
      default: break;
    }
  }

  private releasePending(): void {
    if (!this.scope.active) return;
    const energy = this.audioOut.currentEnergy();
    if (Math.abs(energy - this.snapshot.voiceEnergy) > 0.01) this.update({ voiceEnergy: energy });
    while (this.pendingText.length > 0 && this.audioOut.playedMs(this.pendingText[0].responseId) + 120 >= this.pendingText[0].stampMs) {
      const item = this.pendingText.shift() as StampedText;
      if (!this.isCurrent(item.identity) || this.deadResponses.has(item.responseId)) continue;
      this.pushTranscriptDelta(item.responseId, item.delta);
    }
    while (this.pendingOps.length > 0 && this.audioOut.playedMs(this.pendingOps[0].responseId) + 60 >= this.pendingOps[0].stampMs) {
      const item = this.pendingOps.shift() as StampedOps;
      this.releaseOps(item);
    }
  }

  private releaseOps(item: StampedOps): void {
    if (!this.isCurrent(item.identity) || this.deadResponses.has(item.responseId)) return;
    void Promise.resolve(this.onBoardOps(item.ops, true, item.identity)).then((completed) => {
      if (completed !== false && this.isCurrent(item.identity) && item.eventId !== null) this.send('ops_shown', { event_id: item.eventId });
    });
  }

  private handlePlaybackEnd(): void {
    if (!this.scope.active) return;
    for (const item of this.pendingText.splice(0)) if (this.isCurrent(item.identity) && !this.deadResponses.has(item.responseId)) this.pushTranscriptDelta(item.responseId, item.delta, true);
    for (const item of this.pendingOps.splice(0)) this.releaseOps(item);
    for (const responseId of this.phraseBuffers.keys()) this.flushPhrase(responseId, false);
    if (this.snapshot.phase === 'speaking') this.update({ phase: 'listening', voiceEnergy: 0 });
  }

  private pushTranscriptDelta(responseId: string, delta: string, force = false): void {
    let buffer = (this.phraseBuffers.get(responseId) ?? '') + delta;
    const boundary = force ? buffer.length : phraseBoundary(buffer);
    if (boundary > 0) {
      const phrase = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary);
      if (phrase) this.appendCaption({ role: 'tutor', text: phrase, live: !force, responseId });
    }
    this.phraseBuffers.set(responseId, buffer);
  }

  private flushPhrase(responseId: string, live: boolean): void {
    const phrase = (this.phraseBuffers.get(responseId) ?? '').trim();
    this.phraseBuffers.delete(responseId);
    if (phrase) this.appendCaption({ role: 'tutor', text: phrase, live, responseId });
  }

  private applyFinalTranscript(responseId: string, text: string): void {
    this.phraseBuffers.delete(responseId);
    const withoutResponse = this.snapshot.captions.filter((caption) => caption.responseId !== responseId);
    const corrected = segmentPhrases(text).map((phrase) => ({ role: 'tutor' as const, text: phrase, live: false, responseId }));
    this.update({ captions: [...withoutResponse, ...corrected].slice(-100) });
  }

  private appendCaption(line: CaptionLine): void { this.update({ captions: [...this.snapshot.captions, line].slice(-100) }); }

  private async runFallbackTurn(text: string, idempotencyKey: string, scope: GenerationScope): Promise<void> {
    this.appendCaption({ role: 'child', text, live: false });
    this.update({ phase: 'thinking' });
    try {
      const response = await fetch('/api/fallback-turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Lesson ${this.lessonCapability ?? ''}` },
        body: JSON.stringify({ sessionId: this.sessionId, text, idempotencyKey }), signal: scope.signal,
      });
      if (!response.ok || !response.body) throw new Error(`fallback failed (${response.status})`);
      const reader = response.body.getReader();
      scope.addCleanup(() => void reader.cancel().catch(() => undefined));
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !scope.active) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) if (line.trim() && scope.active) {
          try { this.handleFallbackStep(JSON.parse(line), scope.identity); }
          catch { /* malformed line */ }
        }
      }
    } catch {
      if (!scope.signal.aborted) this.update({ error: 'Noura is unreachable right now.' });
    } finally {
      if (scope.active && this.snapshot.phase === 'thinking') this.update({ phase: 'fallback' });
    }
  }

  private handleFallbackStep(step: Record<string, unknown>, identity: GenerationIdentity): void {
    if (!this.isCurrent(identity)) return;
    if (step.type === 'say' && typeof step.text === 'string') for (const phrase of segmentPhrases(step.text)) this.appendCaption({ role: 'tutor', text: phrase, live: false });
    else if (step.type === 'board_ops' && Array.isArray(step.ops)) void this.onBoardOps(step.ops as BoardOp[], true, identity);
    else if (step.type === 'evidence') this.update({ evidenceCount: this.snapshot.evidenceCount + 1 });
    else if (step.type === 'error') this.update({ error: String(step.message ?? 'The tutor failed.') });
  }

  sendBoardEvent(description: string): void { this.send('board_event', { description }); }

  private activateScope(advanceGeneration: boolean): void {
    if (advanceGeneration) this.generationCounter += 1;
    const identity = this.makeIdentity();
    this.scope = new GenerationScope(identity);
    this.gate.replace(identity);
    this.outboundSequence = 0;
    this.scope.interval(() => this.releasePending(), 50);
    this.update?.({ identity });
  }

  private cancelGeneration(reason: string): void {
    const identity = this.scope.identity;
    this.scope.cancel(reason);
    this.onGenerationCancelled(identity);
  }

  private makeIdentity(): GenerationIdentity {
    return { sessionId: this.sessionId, connectionEpoch: this.connectionEpoch, turnId: `turn-${this.turnCounter}`, generationId: `generation-${this.generationCounter}` };
  }

  private isCurrent(identity: GenerationIdentity): boolean {
    const current = this.scope.identity;
    return identity.sessionId === current.sessionId && identity.connectionEpoch === current.connectionEpoch && identity.turnId === current.turnId && identity.generationId === current.generationId && this.scope.active;
  }

  private send(type: string, payload: Record<string, unknown>): void { this.sendUsingIdentity(this.scope.identity, type, payload); }
  private sendUsingIdentity(identity: GenerationIdentity, type: string, payload: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(createRuntimeEvent(identity, this.outboundSequence++, type, payload, payload.idempotencyKey ? { idempotencyKey: String(payload.idempotencyKey) } : {})));
  }
}

function phraseBoundary(text: string): number {
  const punctuation = [...text.matchAll(/[.!?;:]\s+/g)].at(-1);
  if (punctuation && punctuation.index !== undefined) return punctuation.index + punctuation[0].length;
  if (text.length < 92) return 0;
  const breakAt = text.lastIndexOf(' ', 92);
  return breakAt > 36 ? breakAt + 1 : 92;
}

export function segmentPhrases(text: string): string[] {
  const phrases: string[] = [];
  let remaining = text.trim();
  while (remaining) {
    const boundary = phraseBoundary(remaining);
    if (boundary === 0) { phrases.push(remaining); break; }
    phrases.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  return phrases.filter(Boolean);
}
