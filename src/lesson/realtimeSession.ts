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
import { ResponseCueTimeline, type ResponseCue } from './responseTimeline';
import { VoiceInterruptionGate } from './voiceInterruption';
import type { LearnerBoardAnalysis } from '../../shared/learnerBoard';
import { DeliveredTaskSchema, type DeliveredTask } from '../../shared/lessonTurn';
import {
  MetricInputSchema,
  TELEMETRY_SCHEMA_VERSION,
  type MetricInput,
} from '../../shared/sessionTelemetry';
import { ResponseTimingTracker } from './sessionTelemetry';
import type { NavigationCause } from '../board/renderedObjectTracker';

export type Phase = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'reconnecting' | 'fallback' | 'failed' | 'ended';
export interface CaptionLine { role: 'tutor' | 'child'; text: string; live: boolean; responseId?: string }
export interface LessonState { activeConcept?: string; strategy?: string; nextStep?: string; phase?: string; activeSemanticObjectId?: string; characterAttentionTarget?: string }
export interface EvidenceEntry { concept: string; observation: string; verdict: string; confidence: string }
export interface SubmissionProgress { submissionId: string; status: 'sending' | 'accepted' | 'failed'; error?: string }
export interface BoardSubmissionInput {
  submissionId: string;
  draftId: string;
  taskId?: string;
  semanticGroupId?: string;
  semanticGroupLabel?: string;
  baseBoardRevision?: number;
  submittedBoardRevision?: number;
  description: string;
  ops: BoardOp[];
  analysis?: LearnerBoardAnalysis;
  imageDataUrl?: string | null;
}
export interface TurnMetrics {
  askToFirstAudioMs?: number;
  detectorToStopScheduledMs?: number;
  providerCancelConfirmationMs?: number;
  speechEndToResponseStartedMs?: number;
  speechEndToFirstAudioMs?: number;
}
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
  /** The task Noura has actually asked and the learner has heard. */
  task: DeliveredTask | null;
  /** Progress of the learner's current board submission, if any. */
  submission: SubmissionProgress | null;
}

interface QueuedAsk { text: string; idempotencyKey: string; identity: GenerationIdentity }
export interface VisualCueMetadata { responseId?: string; visualCueId?: string; semanticObjectId?: string; groupLabel?: string; checkpoint?: string; replacesGroup?: string }

type Listener = () => void;
const CONNECT_TIMEOUT_MS = 8_000;
const MAX_RECONNECTS = 2;
const MAX_PENDING_UNCORRELATED_METRICS = 64;

export class RealtimeSession {
  private ws: WebSocket | null = null;
  private audioOut = new AudioOut();
  private audioIn: AudioIn | null = null;
  private readonly sessionId: string;
  private listeners = new Set<Listener>();
  private snapshot: SessionSnapshot;
  private timeline = new ResponseCueTimeline();
  private phraseBuffers = new Map<string, string>();
  private currentResponseId: string | null = null;
  private deadResponses = new Set<string>();
  private reconnectAttempts = 0;
  private closedByUs = false;
  private started = false;
  private voiceInterruption = new VoiceInterruptionGate();
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
  private interruptionPending = false;
  private speechStoppedAt = 0;
  private speechResponseStartMeasured = false;
  /** The learner is composing a drawing draft; nothing auto-submits it. */
  private draftOpen = false;
  private draftId: string | null = null;
  private submissionAckTimer: number | null = null;
  private responseTiming = new ResponseTimingTracker();
  private pendingUncorrelatedMetrics: MetricInput[] = [];
  private pendingClientMetricGapCount = 0;

  onBoardOps: (ops: BoardOp[], animate: boolean, identity: GenerationIdentity, cue?: VisualCueMetadata) => Promise<boolean | void> | boolean | void = () => {};
  onLearnerBoardReplay: (ops: BoardOp[], semanticGroupId?: string) => void = () => {};
  onGenerationCancelled: (identity: GenerationIdentity) => void = () => {};
  onGenerationActivated: (identity: GenerationIdentity, reason: 'interruption' | 'ordinary') => void = () => {};
  onCaptionQuestion: (identity: GenerationIdentity) => void = () => {};
  onSubmissionResult: (submissionId: string, accepted: boolean, error?: string) => void = () => {};
  /** Compile-checks a complete candidate visual plan without committing it. */
  onVisualPreflight: (ops: BoardOp[], semanticGroupId?: string, replacesGroup?: string) => Promise<{ accepted: boolean; reasons: string[] }> | { accepted: boolean; reasons: string[] } = () => ({ accepted: true, reasons: [] });
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
      micEnergy: 0, voiceEnergy: 0, error: null, metrics: {}, task: null, submission: null,
    };
  }

  subscribe = (listener: Listener): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = (): SessionSnapshot => this.snapshot;
  getIdentity = (): GenerationIdentity => this.scope.identity;

  noteBoardReveal(identity: GenerationIdentity, cue: VisualCueMetadata): void {
    if (!this.isCurrent(identity) || !cue.responseId) return;
    const metric = this.responseTiming.noteBoardReveal(
      cue.responseId,
      performance.now(),
      {
        visualCueId: cue.visualCueId,
        semanticObjectId: cue.semanticObjectId,
      },
    );
    if (metric) this.emitMetric(metric, identity, cue.responseId);
  }

  recordSectionNavigation(input: {
    previousGroupId: string | null;
    nextGroupId: string;
    cause: NavigationCause;
  }): void {
    const metric = MetricInputSchema.safeParse({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      name: 'section_navigation',
      unit: 'count',
      value: 1,
      dimensions: {
        previousSemanticGroupId: input.previousGroupId ?? 'group-root',
        nextSemanticGroupId: input.nextGroupId,
        cause: input.cause,
      },
    });
    if (metric.success) this.emitMetric(metric.data);
  }

  recordTutorObjectDisappearance(input: {
    objectId: string;
    cause: 'scene_mutation' | 'unknown';
  }): void {
    const metric = MetricInputSchema.safeParse({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      name: 'tutor_object_disappearance',
      unit: 'count',
      value: 1,
      dimensions: input,
    });
    if (metric.success) this.emitMetric(metric.data);
  }

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
    this.pendingUncorrelatedMetrics = [];
    this.pendingClientMetricGapCount = 0;
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
    if (['speaking', 'thinking'].includes(this.snapshot.phase)) this.interruptLocally('text');
    else this.cancelGeneration('new learner text turn');
    this.turnCounter += 1;
    this.activateScope(true);
    this.askAt = performance.now();
    this.speechStoppedAt = 0;
    this.speechResponseStartMeasured = false;
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
    if (muted) this.voiceInterruption.reset();
    this.update({ muted });
  }

  /**
   * A deliberate first touch of the board. It may stop Noura mid-sentence and
   * acquire the learner floor, but it never submits anything: the stroke that
   * follows opens (or continues) a local draft that only Done sends.
   */
  beginLearnerActivity(): void {
    if (!['listening', 'speaking', 'thinking', 'fallback'].includes(this.snapshot.phase)) return;
    if (['speaking', 'thinking'].includes(this.snapshot.phase)) {
      this.interruptLocally('interaction');
      this.turnCounter += 1;
      this.activateScope(true);
      this.update({ phase: 'listening' });
      return;
    }
    if (this.draftOpen || this.snapshot.phase === 'fallback') return;
    this.cancelGeneration('new learner board turn');
    this.turnCounter += 1;
    this.activateScope(true);
    this.update({ phase: 'listening' });
  }

  /** The lesson opened/closed a drawing draft; the server must not let any
   * speech pause or timer complete the turn while it is open. */
  notifyDraftState(open: boolean, draftId: string): void {
    this.draftOpen = open;
    this.draftId = open ? draftId : null;
    if (this.snapshot.phase !== 'fallback') this.send('draft_state', { open, draftId });
  }

  get hasOpenDraft(): boolean { return this.draftOpen; }

  /**
   * The learner pressed Done: exactly one idempotent submission, exactly one
   * tutor response. Retries reuse the same submissionId and never duplicate.
   */
  submitBoardSubmission(input: BoardSubmissionInput): void {
    if (this.snapshot.phase === 'ended') return;
    this.draftOpen = false;
    this.draftId = null;
    if (this.snapshot.phase === 'fallback') {
      this.update({ submission: { submissionId: input.submissionId, status: 'sending' } });
      void this.runFallbackBoardTurn(input, this.scope);
      return;
    }
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.update({ submission: { submissionId: input.submissionId, status: 'failed', error: 'Not connected — your drawing is safe. Try Done again in a moment.' } });
      this.onSubmissionResult(input.submissionId, false, 'not connected');
      return;
    }
    this.send('board_submission', {
      submissionId: input.submissionId,
      draftId: input.draftId,
      description: input.description,
      ops: input.ops,
      baseBoardRevision: input.baseBoardRevision ?? 0,
      submittedBoardRevision: input.submittedBoardRevision ?? 0,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.semanticGroupId ? { semanticGroupId: input.semanticGroupId } : {}),
      ...(input.semanticGroupLabel ? { semanticGroupLabel: input.semanticGroupLabel } : {}),
      ...(input.analysis ? { analysis: input.analysis } : {}),
      ...(input.imageDataUrl ? { imageDataUrl: input.imageDataUrl } : {}),
    });
    this.update({ phase: 'thinking', submission: { submissionId: input.submissionId, status: 'sending' } });
    if (this.submissionAckTimer !== null) window.clearTimeout(this.submissionAckTimer);
    this.submissionAckTimer = window.setTimeout(() => {
      if (this.snapshot.submission?.submissionId === input.submissionId && this.snapshot.submission.status === 'sending') {
        this.update({ phase: 'listening', submission: { submissionId: input.submissionId, status: 'failed', error: 'Noura did not receive your drawing. It is still on the board — press Done to try again.' } });
        this.onSubmissionResult(input.submissionId, false, 'timeout');
      }
    }, 8_000);
  }

  private async runFallbackBoardTurn(input: BoardSubmissionInput, scope: GenerationScope): Promise<void> {
    this.update({ phase: 'thinking' });
    try {
      const response = await fetch('/api/board-submission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Lesson ${this.lessonCapability ?? ''}` },
        body: JSON.stringify({
          submissionId: input.submissionId,
          description: input.description,
          ops: input.ops,
          ...(input.analysis ? { analysis: { summary: input.analysis.summary } } : {}),
          ...scope.identity,
        }),
        signal: scope.signal,
      });
      if (!response.ok || !response.body) throw new Error(`board submission failed (${response.status})`);
      this.update({ submission: { submissionId: input.submissionId, status: 'accepted' }, task: null });
      this.onSubmissionResult(input.submissionId, true);
      await this.consumeFallbackStream(response.body, scope);
    } catch {
      if (!scope.signal.aborted) {
        this.update({ submission: { submissionId: input.submissionId, status: 'failed', error: 'Noura could not read your drawing right now. It is still on the board — press Done to try again.' } });
        this.onSubmissionResult(input.submissionId, false, 'fallback transport failed');
      }
    } finally {
      if (scope.active && this.snapshot.phase === 'thinking') this.update({ phase: 'fallback' });
    }
  }

  private handleMicEnergy(rms: number): void {
    const nextEnergy = this.snapshot.micEnergy * 0.7 + rms * 0.3;
    if (Math.abs(nextEnergy - this.snapshot.micEnergy) > 0.002) this.update({ micEnergy: nextEnergy });
    if (this.snapshot.muted) return;
    const decision = this.voiceInterruption.observeEnergy(rms, this.tutorTurnActive(), performance.now());
    if (decision.rejectedOutcome) this.emitMetric({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      name: 'barge_in_gate_outcome',
      unit: 'count',
      value: 1,
      dimensions: { outcome: decision.rejectedOutcome },
    });
    if (decision.shouldInterrupt) this.confirmVoiceInterruption();
  }

  private tutorTurnActive(): boolean {
    return this.audioOut.speaking || ['speaking', 'thinking'].includes(this.snapshot.phase);
  }

  private confirmVoiceInterruption(): void {
    if (!this.tutorTurnActive() || this.snapshot.muted) return;
    this.interruptLocally('voice');
    this.turnCounter += 1;
    this.activateScope(true);
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
    this.timeline.cancel(identity);
    this.phraseBuffers.clear();
    this.voiceInterruption.reset();
    this.interruptionPending = true;
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
        // A reconnect must not lose an open drawing draft: re-arm the
        // server-side "learner is composing" guard for the new connection.
        if (this.draftOpen && this.draftId) this.send('draft_state', { open: true, draftId: this.draftId });
        this.flushPendingUncorrelatedMetrics();
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
        for (const batch of batches) {
          if (Array.isArray(batch)) void this.onBoardOps(batch as BoardOp[], false, envelope);
          else if (batch && typeof batch === 'object') {
            const replay = batch as { ops?: unknown; semanticObjectId?: unknown; groupLabel?: unknown };
            if (Array.isArray(replay.ops)) void this.onBoardOps(replay.ops as BoardOp[], false, envelope, {
              ...(typeof replay.semanticObjectId === 'string' ? { semanticObjectId: replay.semanticObjectId } : {}),
              ...(typeof replay.groupLabel === 'string' ? { groupLabel: replay.groupLabel } : {}),
            });
          }
        }
        break;
      }
      case 'learner_board_replay': {
        const batches = Array.isArray(message.batches) ? message.batches : [];
        for (const batch of batches) {
          if (Array.isArray(batch)) this.onLearnerBoardReplay(batch as BoardOp[]);
          else if (batch && typeof batch === 'object') {
            const replay = batch as { ops?: unknown; semanticObjectId?: unknown };
            if (Array.isArray(replay.ops)) this.onLearnerBoardReplay(
              replay.ops as BoardOp[],
              typeof replay.semanticObjectId === 'string' ? replay.semanticObjectId : undefined,
            );
          }
        }
        break;
      }
      case 'response_started': {
        this.currentResponseId = typeof message.response_id === 'string' ? message.response_id : null;
        if (this.currentResponseId) this.scope.providerResponseIds.add(this.currentResponseId);
        // A new tutor response means the learner's answer is being handled;
        // the delivered task banner has served its purpose.
        if (this.snapshot.task && !this.draftOpen) this.update({ task: null });
        if (this.speechStoppedAt > 0 && !this.speechResponseStartMeasured) {
          this.speechResponseStartMeasured = true;
          const speechEndToResponseStartedMs = Math.max(0, Math.round(performance.now() - this.speechStoppedAt));
          this.emitMetric({
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            name: 'speech_end_to_response_started',
            unit: 'ms',
            value: speechEndToResponseStartedMs,
          });
          this.update({ metrics: { ...this.snapshot.metrics, speechEndToResponseStartedMs } });
        }
        break;
      }
      case 'audio': {
        if (typeof message.delta !== 'string') break;
        const responseId = String(message.response_id ?? '');
        if (this.deadResponses.has(responseId)) break;
        this.currentResponseId = responseId;
        const itemId = typeof message.item_id === 'string' ? message.item_id : null;
        if (this.speechStoppedAt > 0) {
          const speechEndToFirstAudioMs = Math.max(0, Math.round(performance.now() - this.speechStoppedAt));
          this.emitMetric({
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            name: 'speech_end_to_first_audio',
            unit: 'ms',
            value: speechEndToFirstAudioMs,
          });
          this.speechStoppedAt = 0;
          this.update({ metrics: { ...this.snapshot.metrics, speechEndToFirstAudioMs } });
        }
        if (!this.firstAudioSeen && this.askAt > 0) {
          this.firstAudioSeen = true;
          const askToFirstAudioMs = Math.round(performance.now() - this.askAt);
          this.askAt = 0;
          this.emitMetric({
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            name: 'ask_to_first_audio',
            unit: 'ms',
            value: askToFirstAudioMs,
          });
          this.update({ metrics: { ...this.snapshot.metrics, askToFirstAudioMs } });
        }
        const receipt = this.audioOut.append(responseId, itemId, message.delta);
        if (receipt) {
          this.responseTiming.noteNarrationScheduled(
            responseId,
            performance.now() + receipt.playbackStartsInMs,
          );
        }
        if (this.snapshot.phase !== 'speaking') this.update({ phase: 'speaking' });
        break;
      }
      case 'transcript_delta': {
        if (typeof message.delta !== 'string') break;
        const responseId = String(message.response_id ?? '');
        if (this.deadResponses.has(responseId)) break;
        if (!envelope.audioSampleOffsets) break;
        this.timeline.enqueue({
          kind: 'caption', cueId: envelope.eventId, responseId,
          startSample: envelope.audioSampleOffsets.start, endSample: envelope.audioSampleOffsets.end,
          sequence: envelope.sequence, identity: envelope, delta: message.delta,
        });
        break;
      }
      case 'transcript_done': {
        const responseId = String(message.response_id ?? '');
        const text = String(message.text ?? '').trim();
        if (text && !this.deadResponses.has(responseId) && envelope.audioSampleOffsets) this.timeline.enqueue({
          kind: 'final', cueId: envelope.eventId, responseId,
          startSample: envelope.audioSampleOffsets.start, endSample: envelope.audioSampleOffsets.end,
          sequence: envelope.sequence, identity: envelope, text,
        });
        break;
      }
      case 'board_ops': {
        if (!Array.isArray(message.ops)) break;
        const responseId = String(message.response_id ?? '');
        if (this.deadResponses.has(responseId)) break;
        if (!envelope.audioSampleOffsets) {
          if (envelope.idempotencyKey) this.releaseOps({
            kind: 'visual', cueId: envelope.eventId, responseId,
            startSample: 0, endSample: 0, sequence: envelope.sequence, identity: envelope,
            ops: message.ops as BoardOp[], eventId: typeof message.event_id === 'number' ? message.event_id : null,
            visualCueId: envelope.visualCueId, semanticObjectId: envelope.semanticObjectId,
            groupLabel: typeof message.groupLabel === 'string' ? message.groupLabel : undefined,
            checkpoint: typeof message.checkpoint === 'string' ? message.checkpoint : undefined,
            replacesGroup: typeof message.replacesGroup === 'string' ? message.replacesGroup : undefined,
            idempotencyKey: envelope.idempotencyKey,
          });
          break;
        }
        this.timeline.enqueue({
          kind: 'visual', cueId: envelope.eventId, responseId,
          startSample: envelope.audioSampleOffsets.start, endSample: envelope.audioSampleOffsets.end,
          sequence: envelope.sequence, identity: envelope,
          ops: message.ops as BoardOp[], eventId: typeof message.event_id === 'number' ? message.event_id : null,
          visualCueId: envelope.visualCueId, semanticObjectId: envelope.semanticObjectId,
          groupLabel: typeof message.groupLabel === 'string' ? message.groupLabel : undefined,
          checkpoint: typeof message.checkpoint === 'string' ? message.checkpoint : undefined,
          replacesGroup: typeof message.replacesGroup === 'string' ? message.replacesGroup : undefined,
          idempotencyKey: envelope.idempotencyKey,
        });
        break;
      }
      case 'user_transcript': {
        const text = String(message.text ?? '').trim();
        if (text) this.appendCaption({ role: 'child', text, live: false });
        break;
      }
      case 'speech_started': {
        const decision = this.voiceInterruption.confirmServerSpeech(this.tutorTurnActive(), performance.now());
        if (decision.rejectedOutcome) this.emitMetric({
          schemaVersion: TELEMETRY_SCHEMA_VERSION,
          name: 'barge_in_gate_outcome',
          unit: 'count',
          value: 1,
          dimensions: { outcome: decision.rejectedOutcome },
        });
        if (decision.shouldInterrupt) this.confirmVoiceInterruption();
        break;
      }
      case 'speech_stopped': {
        const decision = this.voiceInterruption.endServerSpeech();
        if (decision.rejectedOutcome) this.emitMetric({
          schemaVersion: TELEMETRY_SCHEMA_VERSION,
          name: 'barge_in_gate_outcome',
          unit: 'count',
          value: 1,
          dimensions: { outcome: decision.rejectedOutcome },
        });
        // Ignore an unconfirmed acoustic blip while Noura still owns the
        // floor. Confirmed barge-in has already moved the phase to listening.
        if (this.tutorTurnActive()) break;
        // While a drawing draft is open, speech accumulates as context for
        // the explicit Done — no response is coming yet, so stay listening.
        if (this.draftOpen) break;
        this.speechStoppedAt = performance.now();
        this.speechResponseStartMeasured = false;
        this.firstAudioSeen = false;
        this.askAt = 0;
        this.update({ phase: 'thinking' });
        break;
      }
      case 'learner_task': {
        const parsed = DeliveredTaskSchema.safeParse(message.task);
        if (!parsed.success) break;
        const responseId = String(message.response_id ?? '');
        if (envelope.audioSampleOffsets && responseId && !this.deadResponses.has(responseId)) {
          this.timeline.enqueue({
            kind: 'task', cueId: envelope.eventId, responseId,
            startSample: envelope.audioSampleOffsets.start, endSample: envelope.audioSampleOffsets.end,
            sequence: envelope.sequence, identity: envelope, task: parsed.data,
          });
        } else this.update({ task: parsed.data });
        break;
      }
      case 'board_submission_ack': {
        const submissionId = String(message.submissionId ?? '');
        if (this.submissionAckTimer !== null) { window.clearTimeout(this.submissionAckTimer); this.submissionAckTimer = null; }
        this.update({ submission: { submissionId, status: 'accepted' }, task: null });
        this.onSubmissionResult(submissionId, true);
        break;
      }
      case 'board_submission_error': {
        const submissionId = String(message.submissionId ?? '');
        const reason = String(message.reason ?? 'Noura could not read your drawing. It is still on the board — press Done to try again.');
        if (this.submissionAckTimer !== null) { window.clearTimeout(this.submissionAckTimer); this.submissionAckTimer = null; }
        this.update({ phase: 'listening', submission: { submissionId, status: 'failed', error: reason } });
        this.onSubmissionResult(submissionId, false, reason);
        break;
      }
      case 'visual_preflight': {
        const preflightId = String(message.preflight_id ?? '');
        if (!preflightId || !Array.isArray(message.ops)) break;
        const semanticGroupId = typeof message.semanticObjectId === 'string' ? message.semanticObjectId : undefined;
        const replacesGroup = typeof message.replacesGroup === 'string' ? message.replacesGroup : undefined;
        void Promise.resolve(this.onVisualPreflight(message.ops as BoardOp[], semanticGroupId, replacesGroup))
          .then((result) => this.send('visual_preflight_result', { preflight_id: preflightId, accepted: result.accepted, reasons: result.reasons.slice(0, 8) }))
          .catch(() => this.send('visual_preflight_result', { preflight_id: preflightId, accepted: false, reasons: ['preflight crashed'] }));
        break;
      }
      case 'lesson_state': {
        const state = (message.state ?? {}) as LessonState;
        const responseId = String(message.response_id ?? envelope.providerResponseId ?? '');
        if (envelope.audioSampleOffsets && responseId) {
          this.timeline.enqueue({
            kind: 'semantic', cueId: envelope.eventId, responseId,
            startSample: envelope.audioSampleOffsets.start, endSample: envelope.audioSampleOffsets.end,
            sequence: envelope.sequence, identity: envelope, state: { ...state },
            semanticObjectId: envelope.semanticObjectId,
          });
        } else this.update({ lessonState: { ...this.snapshot.lessonState, ...state } });
        break;
      }
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
        if (!this.audioOut.speaking && this.timeline.pendingCount() === 0 && this.snapshot.phase === 'speaking') this.update({ phase: 'listening' });
        break;
      }
      case 'safe_question': {
        const text = String(message.text ?? '').trim();
        if (text) this.appendCaption({ role: 'tutor', text, live: false });
        if (text) this.onCaptionQuestion(this.scope.identity);
        this.update({ phase: 'listening' });
        break;
      }
      case 'fallback_caption': {
        const text = String(message.text ?? '').trim();
        if (text) for (const phrase of segmentPhrases(text)) this.appendCaption({ role: 'tutor', text: phrase, live: false, responseId: String(message.response_id ?? '') || undefined });
        this.update({ phase: 'fallback' });
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
    for (const cue of this.timeline.drain((responseId) => this.audioOut.playedSamples(responseId))) this.releaseCue(cue);
  }

  private releaseCue(cue: ResponseCue): void {
    if (!this.isCurrent(cue.identity) || this.deadResponses.has(cue.responseId)) return;
    if (cue.kind === 'caption') this.pushTranscriptDelta(cue.responseId, cue.delta);
    else if (cue.kind === 'visual') this.releaseOps(cue);
    else if (cue.kind === 'semantic') this.update({ lessonState: { ...this.snapshot.lessonState, ...(cue.state as LessonState) } });
    else if (cue.kind === 'task') {
      this.update({ task: cue.task });
      this.onCaptionQuestion(this.scope.identity);
    }
    else this.applyFinalTranscript(cue.responseId, cue.text);
  }

  private releaseOps(item: Extract<ResponseCue, { kind: 'visual' }>): void {
    if (!this.isCurrent(item.identity) || this.deadResponses.has(item.responseId)) return;
    void Promise.resolve(this.onBoardOps(item.ops, true, item.identity, {
      responseId: item.responseId,
      visualCueId: item.visualCueId,
      semanticObjectId: item.semanticObjectId,
      groupLabel: item.groupLabel,
      checkpoint: item.checkpoint,
      replacesGroup: item.replacesGroup,
    })).then((completed) => {
      if (completed === false && item.eventId !== null) {
        this.send('ops_rejected', {
          event_id: item.eventId,
          response_id: item.responseId,
          reason: 'The checkpoint exceeded the board layout or legibility budget.',
        });
        return;
      }
      if (completed !== false && item.eventId !== null) {
        if (item.idempotencyKey) {
          // Fallback checkpoints are part of an atomic generation and may only
          // acknowledge while that generation is still current.
          if (!this.isCurrent(item.identity)) return;
          void fetch('/api/fallback-checkpoint', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Lesson ${this.lessonCapability ?? ''}` },
            body: JSON.stringify({ eventId: item.eventId, idempotencyKey: item.idempotencyKey, ...item.identity }),
          }).catch(() => undefined);
        } else {
          // Realtime cues reached this method only after their audio boundary
          // was heard. If the learner interrupts during draw-on animation,
          // finish and acknowledge the visible checkpoint using the new
          // client identity so it remains replayable after refresh.
          this.send('ops_shown', { event_id: item.eventId });
        }
      }
    });
  }

  private handlePlaybackEnd(): void {
    if (!this.scope.active) return;
    this.releasePending();
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
      if (phrase && /[?？]\s*$/.test(phrase)) this.onCaptionQuestion(this.scope.identity);
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
    if (/[?？]\s*$/.test(text)) this.onCaptionQuestion(this.scope.identity);
  }

  private appendCaption(line: CaptionLine): void { this.update({ captions: [...this.snapshot.captions, line].slice(-100) }); }

  private async runFallbackTurn(text: string, idempotencyKey: string, scope: GenerationScope): Promise<void> {
    this.appendCaption({ role: 'child', text, live: false });
    this.update({ phase: 'thinking' });
    try {
      const response = await fetch('/api/fallback-turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Lesson ${this.lessonCapability ?? ''}` },
        body: JSON.stringify({ text, idempotencyKey, ...scope.identity }), signal: scope.signal,
      });
      if (!response.ok || !response.body) throw new Error(`fallback failed (${response.status})`);
      await this.consumeFallbackStream(response.body, scope);
    } catch {
      if (!scope.signal.aborted) this.update({ error: 'Noura is unreachable right now.' });
    } finally {
      if (scope.active && this.snapshot.phase === 'thinking') this.update({ phase: 'fallback' });
    }
  }

  private async consumeFallbackStream(body: ReadableStream<Uint8Array>, scope: GenerationScope): Promise<void> {
    const reader = body.getReader();
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
        try {
          const decoded = JSON.parse(line) as unknown;
          if (RuntimeEventEnvelopeSchema.safeParse(decoded).success) this.handleServer(decoded);
          else this.handleFallbackStep(decoded as Record<string, unknown>, scope.identity);
        }
        catch { /* malformed line */ }
      }
    }
  }

  private handleFallbackStep(step: Record<string, unknown>, identity: GenerationIdentity): void {
    if (!this.isCurrent(identity)) return;
    if (step.type === 'stream_error') this.update({ error: String(step.message ?? 'The tutor failed.') });
  }

  private activateScope(advanceGeneration: boolean): void {
    if (advanceGeneration) this.generationCounter += 1;
    const identity = this.makeIdentity();
    this.scope = new GenerationScope(identity);
    this.gate.replace(identity);
    this.outboundSequence = 0;
    this.responseTiming.resetGeneration();
    this.scope.interval(() => this.releasePending(), 50);
    this.update?.({ identity });
    const activationReason = this.interruptionPending ? 'interruption' : 'ordinary';
    this.interruptionPending = false;
    this.onGenerationActivated(identity, activationReason);
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

  private emitMetric(
    input: MetricInput,
    identity = this.scope.identity,
    providerResponseId?: string,
  ): void {
    const metric = MetricInputSchema.safeParse(input);
    if (!metric.success) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendUsingIdentity(identity, 'metric', metric.data, { providerResponseId });
      return;
    }
    if (
      providerResponseId ||
      this.closedByUs ||
      (this.snapshot.phase !== 'connecting' && this.snapshot.phase !== 'reconnecting')
    ) {
      return;
    }
    if (this.pendingUncorrelatedMetrics.length >= MAX_PENDING_UNCORRELATED_METRICS) {
      this.pendingUncorrelatedMetrics.shift();
      this.pendingClientMetricGapCount += 1;
    }
    this.pendingUncorrelatedMetrics.push(metric.data);
  }

  private flushPendingUncorrelatedMetrics(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const pending = this.pendingUncorrelatedMetrics;
    this.pendingUncorrelatedMetrics = [];
    const identity = this.scope.identity;
    if (this.pendingClientMetricGapCount > 0) {
      this.sendUsingIdentity(identity, 'metric', {
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        name: 'telemetry_gap',
        unit: 'count',
        value: this.pendingClientMetricGapCount,
        dimensions: { reason: 'client_queue_overflow' },
      });
      this.pendingClientMetricGapCount = 0;
    }
    for (const metric of pending) {
      this.sendUsingIdentity(identity, 'metric', metric);
    }
  }

  private send(type: string, payload: Record<string, unknown>): void { this.sendUsingIdentity(this.scope.identity, type, payload); }
  private sendUsingIdentity(
    identity: GenerationIdentity,
    type: string,
    payload: Record<string, unknown>,
    correlation: { providerResponseId?: string } = {},
  ): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(createRuntimeEvent(identity, this.outboundSequence++, type, payload, {
      ...(payload.idempotencyKey ? { idempotencyKey: String(payload.idempotencyKey) } : {}),
      ...(correlation.providerResponseId ? { providerResponseId: correlation.providerResponseId } : {}),
    })));
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
