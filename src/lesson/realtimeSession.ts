import type { BoardOp, ImageRegionSelector } from '../../shared/boardOps';
import {
  createRuntimeEvent,
  RuntimeEventEnvelopeSchema,
  RuntimeEventGate,
  type GenerationIdentity,
  type RuntimeEventEnvelope,
} from '../../shared/runtimeProtocol';
import { GenerationScope } from './generationScope';
import { ResponseCueTimeline, type ResponseCue, type ResponsePlaybackStatus } from './responseTimeline';
import { VoiceInterruptionGate } from './voiceInterruption';
import { WebRtcVoiceTransport, type PlaybackBoundary, type PlaybackFailureReason, type VoiceTransport, type VoiceTransportHandlers } from './voiceTransport';
import type { LearnerBoardAnalysis } from '../../shared/learnerBoard';
import { DeliveredTaskSchema, type DeliveredTask } from '../../shared/lessonTurn';
import {
  MetricInputSchema,
  TELEMETRY_SCHEMA_VERSION,
  type MetricInput,
} from '../../shared/sessionTelemetry';
import { ResponseTimingTracker } from './sessionTelemetry';
import type { NavigationCause } from '../board/renderedObjectTracker';
import type { LayoutPreflightResult } from '../../shared/layoutFeedback';
import { ResponseCaptionTimeline, type CaptionLine } from './captionTimeline';

export type { CaptionLine } from './captionTimeline';
export { segmentPhrases } from './captionTimeline';

export type Phase = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'reconnecting' | 'fallback' | 'failed' | 'ended';
export interface LessonState { activeConcept?: string; strategy?: string; nextStep?: string; phase?: string; activeSemanticObjectId?: string; characterAttentionTarget?: string }
export interface EvidenceEntry { concept: string; observation: string; verdict: string; confidence: string }
export interface SubmissionProgress { submissionId: string; status: 'sending' | 'accepted' | 'failed'; error?: string }
export interface ImageGroundingTapRequest { requestId: string; imageId: string; hint: string }
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
  manipulativeCheck?: import('../../shared/manipulativeCheck.js').ManipulativeCheck;
  manipulativeResult?: import('../../shared/manipulativeCheck.js').ManipulativeCheckResult;
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
  audioBlocked: boolean;
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
  /** Transient illustration preparation; never a persisted board op. */
  illustration: IllustrationStatus | null;
  imageGrounding: ImageGroundingTapRequest | null;
}

export interface IllustrationStatus {
  status: 'preparing' | 'partial' | 'ready' | 'failed';
  alt?: string;
  /** Transient preview; never written to the event log. */
  partialDataUrl?: string;
}

interface QueuedAsk { text: string; idempotencyKey: string; identity: GenerationIdentity }
export interface VisualCueMetadata { responseId?: string; visualCueId?: string; semanticObjectId?: string; groupLabel?: string; checkpoint?: string; replacesGroup?: string; awaitNarration?: boolean; eventId?: number }

export type VoiceTransportFactory = (input: {
  sessionId: string;
  lessonCapability: string;
  handlers: VoiceTransportHandlers;
}) => VoiceTransport;

type Listener = () => void;
const CONNECT_TIMEOUT_MS = 8_000;
const MAX_RECONNECTS = 2;
const MAX_PENDING_UNCORRELATED_METRICS = 64;
const MIC_ENERGY_POLL_MS = 40;
/** How long a done-but-never-played response may still begin audio before
 * it is treated as genuinely silent and its held cues are released. */
const SILENT_RESPONSE_GRACE_MS = 2_500;

export class RealtimeSession {
  private ws: WebSocket | null = null;
  private voice: VoiceTransport | null = null;
  private readonly injectedVoiceTransport: VoiceTransportFactory | null;
  private readonly sessionId: string;
  private listeners = new Set<Listener>();
  private snapshot: SessionSnapshot;
  private timeline = new ResponseCueTimeline();
  private captionTimeline = new ResponseCaptionTimeline();
  private currentResponseId: string | null = null;
  private deadResponses = new Set<string>();
  /** Responses whose audible playback has started (playback binds reveals). */
  private startedResponses = new Set<string>();
  /** When each response's generation finished (response_done), playing or
   * not. A done response whose audio has NOT started yet only counts as
   * finished after a grace window: audio may still be about to begin. */
  private responseDoneAt = new Map<string, number>();
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
  private reportedPlaybackFailures = new Set<string>();

  onBoardOps: (ops: BoardOp[], animate: boolean, identity: GenerationIdentity, cue?: VisualCueMetadata) => Promise<boolean | void> | boolean | void = () => {};
  onLearnerBoardReplay: (ops: BoardOp[], semanticGroupId?: string) => void = () => {};
  onGenerationCancelled: (identity: GenerationIdentity) => void = () => {};
  onGenerationActivated: (identity: GenerationIdentity, reason: 'interruption' | 'ordinary') => void = () => {};
  onCaptionQuestion: (identity: GenerationIdentity) => void = () => {};
  onSubmissionResult: (submissionId: string, accepted: boolean, error?: string) => void = () => {};
  /** Compile-checks a complete candidate visual plan without committing it. */
  onVisualPreflight: (ops: BoardOp[], semanticGroupId?: string, replacesGroup?: string) => Promise<LayoutPreflightResult> | LayoutPreflightResult = () => ({ accepted: true, reasons: [], layoutIssues: [] });
  /** Renders immutable candidate ops through the learner's real browser
   * pipeline for Director vision inspection. */
  onVisualRender: (ops: BoardOp[], semanticGroupId?: string) => Promise<string | null> | string | null = () => null;
  onEnded: () => void = () => {};

  constructor(sessionId: string, injectedVoiceTransport?: VoiceTransportFactory) {
    this.sessionId = sessionId;
    this.injectedVoiceTransport = injectedVoiceTransport ?? null;
    this.lessonCapability = window.sessionStorage.getItem(`noura.lessonCapability.${sessionId}`);
    const identity = this.makeIdentity();
    this.scope = new GenerationScope(identity);
    this.gate = new RuntimeEventGate(identity);
    this.snapshot = {
      phase: 'connecting', identity, micAvailable: WebRtcVoiceTransport.microphoneSupported(), micDenied: false, audioBlocked: false, muted: false,
      captions: [], lessonState: {}, evidenceCount: 0, lastEvidence: null,
      micEnergy: 0, voiceEnergy: 0, error: null, metrics: {}, task: null, submission: null, illustration: null, imageGrounding: null,
    };
  }

  subscribe = (listener: Listener): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = (): SessionSnapshot => this.snapshot;
  getIdentity = (): GenerationIdentity => this.scope.identity;

  noteBoardReveal(identity: GenerationIdentity, cue: VisualCueMetadata): void {
    if (!this.isCurrent(identity)) return;
    if (cue.eventId !== undefined) {
      // First committed paint: the server may now tell the model these marks
      // are visible. Durable replay still waits for animation completion.
      this.send('ops_presented', { event_id: cue.eventId });
    }
    if (cue.awaitNarration) {
      // A storyboard step: the narration that describes it is the NEXT
      // playback start, not this cue's own (already finished) response.
      this.responseTiming.noteAwaitedReveal(performance.now(), {
        visualCueId: cue.visualCueId,
        semanticObjectId: cue.semanticObjectId,
      });
      return;
    }
    if (!cue.responseId) return;
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
    const voiceReady = await this.connectVoice();
    if (voiceReady) {
      this.connect();
    } else {
      this.update({
        phase: 'fallback',
        error: 'Live voice is unavailable on this device — continue by typing below.',
        micAvailable: false,
      });
    }
  }

  /**
   * The audio plane: a direct browser ↔ provider WebRTC call bootstrapped
   * through the server (which holds the API key and attaches its control
   * sideband before answering). Voice being unavailable — denied microphone,
   * missing WebRTC, bootstrap failure — never blocks the lesson: the envelope
   * still carries captions, board, and typed turns.
   */
  private async connectVoice(): Promise<boolean> {
    if (!this.lessonCapability) return false;
    // Playwright installs a page-level fake transport so E2E suites run
    // fully offline; vitest injects one through the constructor.
    const pageFactory = (window as Window & { __nouraVoiceTransport?: VoiceTransportFactory }).__nouraVoiceTransport ?? null;
    const injected = this.injectedVoiceTransport ?? pageFactory;
    if (!injected && !WebRtcVoiceTransport.supported()) return false;
    const playbackError = 'Noura’s audio is blocked by the browser. Tap “Enable voice” to continue hearing her.';
    const handlers: VoiceTransportHandlers = {
      onPlaybackBoundary: (boundary, responseId, playedMs) => this.handlePlaybackBoundary(boundary, responseId, playedMs),
      onStateChange: (state) => {
        if (state === 'blocked' && !this.closedByUs && this.snapshot.phase !== 'ended') {
          if (this.captionTimeline.audioUnavailableForPending()) this.syncCaptions();
          this.update({ audioBlocked: true, error: playbackError });
        }
        if (state === 'connected' && this.snapshot.audioBlocked) {
          this.update({ audioBlocked: false, error: this.snapshot.error === playbackError ? null : this.snapshot.error });
        }
        if (state === 'failed' && !this.closedByUs && this.snapshot.phase !== 'ended') {
          if (this.captionTimeline.audioUnavailableForPending()) this.syncCaptions();
          this.update({ error: 'Noura’s voice connection was lost — captions continue below.' });
        }
      },
      onMicrophoneState: (available, denied) => this.update({ micAvailable: available, micDenied: denied }),
      onPlaybackFailure: (responseId, reason) => this.handlePlaybackFailure(responseId, reason),
    };
    const factory = injected ?? ((input) => new WebRtcVoiceTransport(input));
    const voice = factory({
      sessionId: this.sessionId,
      lessonCapability: this.lessonCapability,
      handlers,
    });
    // Attach before negotiating so playback boundaries arriving during the
    // handshake already bind cues; a failed connect detaches again.
    this.voice = voice;
    try {
      await voice.connect();
      return true;
    } catch (error) {
      this.voice = null;
      voice.close();
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      this.update(denied ? { micDenied: true, micAvailable: false } : { micAvailable: false });
      return false;
    }
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
      let decoded: unknown;
      try { decoded = JSON.parse(String(event.data)); }
      catch { return; }
      try { this.handleServer(decoded); }
      catch (error) {
        // Protocol validation still rejects malformed frames quietly; an
        // exception after validation is our bug and must not become a silent
        // audio/caption/drawing stall.
        console.error('Noura control event failed', error);
        this.update({ error: 'Noura could not apply a live lesson update. Please try again.' });
      }
    };
    ws.onclose = () => {
      if (this.closedByUs || this.ws !== ws) return;
      this.cancelGeneration('transport closed');
      // The envelope is control-plane only: the WebRTC voice call keeps
      // playing through a reconnect (Vercel recycles the function around
      // 300 s), so a sideband blip never cuts Noura off mid-sentence.
      if (this.reconnectAttempts < MAX_RECONNECTS) {
        this.reconnectAttempts += 1;
        this.connectionEpoch += 1;
        this.activateScope(false);
        if (this.latestQueuedAsk) this.latestQueuedAsk = { ...this.latestQueuedAsk, identity: this.scope.identity };
        this.update({ phase: 'reconnecting' });
        this.scope.timeout(() => this.connect(), 600 * this.reconnectAttempts);
      } else {
        // Terminal degradation to captions-only: silence any residual voice
        // buffered on the call so REST answers do not overlap stale audio.
        this.voice?.stopPlayback();
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
    this.voice?.close();
    this.voice = null;
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
    this.voice?.setMicMuted(muted);
    if (muted) this.voiceInterruption.reset();
    this.update({ muted });
  }

  async resumeAudio(): Promise<void> {
    const resumed = await this.voice?.resumePlayback();
    if (resumed) {
      this.emitMetric({
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        name: 'media_playback_outcome',
        unit: 'count',
        value: 1,
        dimensions: { outcome: 'resumed' },
      });
      this.update({ audioBlocked: false, error: null });
    }
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

  submitImageRegionTap(selector: Extract<ImageRegionSelector, { type: 'PointSelector' }>): boolean {
    const request = this.snapshot.imageGrounding;
    if (!request || this.snapshot.phase === 'ended' || this.ws?.readyState !== WebSocket.OPEN) return false;
    this.send('image_region_tap', {
      request_id: request.requestId,
      image_id: request.imageId,
      selector,
    });
    this.update({ imageGrounding: null });
    return true;
  }

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
      ...(input.manipulativeCheck ? { manipulativeCheck: input.manipulativeCheck } : {}),
      ...(input.manipulativeResult ? { manipulativeResult: input.manipulativeResult } : {}),
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

  private pollMicEnergy(): void {
    if (!this.voice) return;
    this.handleMicEnergy(this.voice.readMicEnergy());
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
    if (this.voice?.playingResponseId()) return true;
    return ['speaking', 'thinking'].includes(this.snapshot.phase);
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

  private rememberBounded(set: Set<string>, responseId: string): void {
    set.add(responseId);
    if (set.size > 48) set.delete(set.values().next().value as string);
  }

  /**
   * The playback truth a cue binds to. A storyboard reveal waits for its
   * tagged response to FINISH playing; "finished" also covers responses
   * that will never play — retired ones and sessions with no voice plane —
   * so a build can never deadlock on silence.
   *
   * A response that is done generating but has not started playing is NOT
   * finished yet: `response.done` routinely arrives on the sideband before
   * the data channel's `output_audio_buffer.started`, and releasing there
   * would reveal the next step at generation-complete instead of playback
   * end. Only after a bounded grace window with no audio is the response
   * treated as genuinely silent and released.
   */
  private responsePlaybackStatus(responseId: string): ResponsePlaybackStatus {
    const voice = this.voice;
    if (!voice || !this.audioExpected() || this.deadResponses.has(responseId)) return 'finished';
    if (voice.playingResponseId() === responseId) return 'playing';
    if (this.startedResponses.has(responseId)) return 'finished';
    const doneAt = this.responseDoneAt.get(responseId);
    if (doneAt !== undefined && performance.now() - doneAt >= SILENT_RESPONSE_GRACE_MS) return 'finished';
    return 'pending';
  }

  private audioExpected(): boolean {
    return this.voice !== null && !['blocked', 'failed', 'closed'].includes(this.voice.state);
  }

  private handlePlaybackFailure(responseId: string | null, reason: PlaybackFailureReason): void {
    const failureKey = `${responseId ?? 'unbound'}:${reason}`;
    if (!this.reportedPlaybackFailures.has(failureKey)) {
      this.rememberBounded(this.reportedPlaybackFailures, failureKey);
      this.emitMetric({
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        name: 'media_playback_outcome',
        unit: 'count',
        value: 1,
        dimensions: { outcome: reason },
      });
    }
    if (responseId && this.captionTimeline.audioUnavailable(responseId)) this.syncCaptions();
    if (reason === 'autoplay_blocked') return;
    if (responseId === this.currentResponseId && this.snapshot.phase === 'speaking') {
      this.update({ phase: 'listening', voiceEnergy: 0 });
    }
  }

  private interruptLocally(reason: 'voice' | 'text' | 'server' | 'interaction'): void {
    const identity = this.scope.identity;
    const interruptedResponseId = this.voice?.playingResponseId() ?? this.currentResponseId;
    this.markResponseDead(interruptedResponseId);
    if (interruptedResponseId) this.voice?.suppressResponse(interruptedResponseId);
    const detectorAt = performance.now();
    const heardMs = this.voice?.stopPlayback() ?? 0;
    const detectorToStopScheduledMs = Math.max(0, performance.now() - detectorAt);
    this.timeline.cancel(identity);
    if (interruptedResponseId && this.captionTimeline.interrupt(interruptedResponseId)) this.syncCaptions();
    this.voiceInterruption.reset();
    this.interruptionPending = true;
    this.cancelGeneration(`interrupted by ${reason}`);
    if (reason !== 'server') {
      this.cancelRequestedAt = performance.now();
      // heardMs lets the server truncate the interrupted conversation item
      // truthfully; the played duration also feeds the telemetry pipeline.
      this.sendUsingIdentity(identity, 'interrupt', {
        reason,
        ...(heardMs > 0 ? { heardMs } : {}),
      });
      if (heardMs > 0 && interruptedResponseId) {
        this.sendUsingIdentity(identity, 'playback_boundary', {
          response_id: interruptedResponseId, boundary: 'stopped', playedMs: heardMs,
        });
      }
    }
    this.update({ phase: 'listening', metrics: { ...this.snapshot.metrics, detectorToStopScheduledMs } });
  }

  /**
   * A real playback boundary from the provider's WebRTC data channel. This is
   * the clock the cue timeline binds to, and — relayed over the envelope — the
   * server's source for audio-duration telemetry.
   */
  private handlePlaybackBoundary(boundary: PlaybackBoundary, responseId: string | null, playedMs: number): void {
    if (!this.scope.active || this.snapshot.phase === 'ended') return;
    // Only stop boundaries are relayed: they carry the heard duration the
    // server's audio-output telemetry needs. Starts are a local clock signal.
    if (boundary !== 'started' && responseId && !this.deadResponses.has(responseId)) {
      this.send('playback_boundary', {
        response_id: responseId,
        boundary: 'stopped',
        ...(playedMs > 0 ? { playedMs } : {}),
      });
    }
    if (boundary === 'started' && responseId && !this.deadResponses.has(responseId)) {
      this.currentResponseId = responseId;
      this.rememberBounded(this.startedResponses, responseId);
      if (this.captionTimeline.playbackStarted(responseId, performance.now())) this.syncCaptions();
      const awaitedRevealMetric = this.responseTiming.noteNarrationScheduled(responseId, performance.now());
      if (awaitedRevealMetric) this.emitMetric(awaitedRevealMetric, this.scope.identity, responseId);
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
      if (this.snapshot.phase !== 'speaking') this.update({ phase: 'speaking' });
      return;
    }
    // stopped / cleared: finish only this response. Flushing every transcript
    // buffer here used to leak a future response into an earlier boundary.
    if (responseId && this.captionTimeline.playbackFinished(responseId)) this.syncCaptions();
    if (responseId && responseId === this.currentResponseId) this.currentResponseId = null;
    this.releasePending();
    if (this.snapshot.phase === 'speaking') this.update({ phase: 'listening', voiceEnergy: 0 });
  }

  private handleServer(raw: unknown): void {
    const parsed = RuntimeEventEnvelopeSchema.safeParse(raw);
    if (!parsed.success || !this.gate.accept(parsed.data)) return;
    const envelope = parsed.data as RuntimeEventEnvelope<Record<string, unknown>>;
    const message = envelope.payload ?? {};
    const type = envelope.type;
    switch (type) {
      case 'ready': {
        const firstWake = this.snapshot.phase === 'connecting';
        this.reconnectAttempts = 0;
        this.send('start', {});
        // A reconnect must not lose an open drawing draft: re-arm the
        // server-side "learner is composing" guard for the new connection.
        if (this.draftOpen && this.draftId) this.send('draft_state', { open: true, draftId: this.draftId });
        this.flushPendingUncorrelatedMetrics();
        const ask = this.latestQueuedAsk;
        this.latestQueuedAsk = null;
        if (ask && this.isCurrent(ask.identity)) {
          this.send('user_text', { text: ask.text, idempotencyKey: ask.idempotencyKey });
          this.update({ phase: 'thinking', error: null });
        } else if (firstWake) {
          // Greeting is in flight; do not flip to Listening over a silent wait.
          this.update({ phase: 'thinking', error: null });
        } else {
          this.update({ phase: 'listening', error: null });
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
        if (this.currentResponseId) {
          this.voice?.noteResponse(this.currentResponseId);
          this.captionTimeline.registerResponse(this.currentResponseId, this.audioExpected());
        }
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
      case 'transcript_delta': {
        // Captions release on arrival: the transcript is the fastest honest
        // signal that Noura is answering, and phrase smoothing keeps the
        // reading pace natural. Ordinary board draws also apply on arrival
        // so the picture is visible while she talks; lesson state and
        // storyboard reveals still wait on playback boundaries.
        if (typeof message.delta !== 'string') break;
        const responseId = String(message.response_id ?? '');
        if (this.deadResponses.has(responseId)) break;
        if (this.captionTimeline.pushDelta(responseId, message.delta, performance.now(), this.audioExpected())) this.syncCaptions();
        break;
      }
      case 'transcript_done': {
        const responseId = String(message.response_id ?? '');
        const text = String(message.text ?? '').trim();
        if (text && !this.deadResponses.has(responseId)) {
          if (this.captionTimeline.finishTranscript(responseId, text, performance.now(), this.audioExpected())) this.syncCaptions();
        }
        break;
      }
      case 'board_ops': {
        if (!Array.isArray(message.ops)) break;
        const responseId = String(message.response_id ?? '');
        if (this.deadResponses.has(responseId)) break;
        // A persisted board event keeps ONE stable cue identity across
        // server re-sends (each re-send is a fresh envelope): a duplicate
        // re-send while the original cue is still pending must not enqueue
        // — and so can never double-draw.
        const cueId = typeof message.event_id === 'number' ? `board-event-${message.event_id}` : envelope.eventId;
        this.timeline.enqueue({
          kind: 'visual', cueId, responseId,
          sequence: envelope.sequence, identity: envelope,
          ops: message.ops as BoardOp[], eventId: typeof message.event_id === 'number' ? message.event_id : null,
          visualCueId: envelope.visualCueId, semanticObjectId: envelope.semanticObjectId,
          groupLabel: typeof message.groupLabel === 'string' ? message.groupLabel : undefined,
          checkpoint: typeof message.checkpoint === 'string' ? message.checkpoint : undefined,
          replacesGroup: typeof message.replacesGroup === 'string' ? message.replacesGroup : undefined,
          idempotencyKey: envelope.idempotencyKey,
          awaitNarration: message.await_narration === true,
        });
        this.releasePending();
        break;
      }
      case 'board_ops_cancelled': {
        const eventIds = Array.isArray(message.event_ids)
          ? message.event_ids.filter((value): value is number => Number.isSafeInteger(value) && value >= 0).slice(0, 64)
          : [];
        this.timeline.cancelVisualEvents(eventIds);
        break;
      }
      case 'user_transcript': {
        const text = String(message.text ?? '').trim();
        if (text && this.captionTimeline.appendChild(text)) this.syncCaptions();
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
        if (responseId && !this.deadResponses.has(responseId)) {
          this.timeline.enqueue({
            kind: 'task', cueId: envelope.eventId, responseId,
            sequence: envelope.sequence, identity: envelope, task: parsed.data,
          });
          this.releasePending();
        } else if (!responseId) this.update({ task: parsed.data });
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
          .then((result) => this.send('visual_preflight_result', {
            preflight_id: preflightId,
            accepted: result.accepted,
            reasons: result.reasons.slice(0, 8),
            layout_issues: result.layoutIssues.slice(0, 8),
          }))
          .catch(() => this.send('visual_preflight_result', {
            preflight_id: preflightId,
            accepted: false,
            reasons: ['preflight crashed'],
            layout_issues: [],
          }));
        break;
      }
      case 'visual_render': {
        const renderId = String(message.render_id ?? '');
        if (!renderId || !Array.isArray(message.ops)) break;
        const semanticGroupId = typeof message.semanticObjectId === 'string' ? message.semanticObjectId : undefined;
        void Promise.resolve(this.onVisualRender(message.ops as BoardOp[], semanticGroupId))
          .then((imageDataUrl) => this.send('visual_render_result', {
            render_id: renderId,
            ...(imageDataUrl ? { image_data_url: imageDataUrl } : {}),
          }))
          .catch(() => this.send('visual_render_result', { render_id: renderId }));
        break;
      }
      case 'lesson_state': {
        const state = (message.state ?? {}) as LessonState;
        const responseId = String(message.response_id ?? envelope.providerResponseId ?? '');
        if (responseId && !this.deadResponses.has(responseId)) {
          this.timeline.enqueue({
            kind: 'semantic', cueId: envelope.eventId, responseId,
            sequence: envelope.sequence, identity: envelope, state: { ...state },
            semanticObjectId: envelope.semanticObjectId,
          });
          this.releasePending();
        } else if (!responseId) this.update({ lessonState: { ...this.snapshot.lessonState, ...state } });
        break;
      }
      case 'evidence': {
        const entry = message.entry as unknown as EvidenceEntry;
        this.update({ evidenceCount: this.snapshot.evidenceCount + 1, lastEvidence: entry });
        break;
      }
      case 'response_done': {
        if (typeof message.response_id === 'string' && message.response_id) {
          this.responseDoneAt.set(message.response_id, performance.now());
          if (this.responseDoneAt.size > 48) {
            this.responseDoneAt.delete(this.responseDoneAt.keys().next().value as string);
          }
        }
        if (message.status === 'cancelled' && this.cancelRequestedAt > 0) {
          const providerCancelConfirmationMs = Math.round(performance.now() - this.cancelRequestedAt);
          this.update({ metrics: { ...this.snapshot.metrics, providerCancelConfirmationMs } });
          this.cancelRequestedAt = 0;
        }
        if (typeof message.response_id === 'string' && message.response_id && message.status === 'cancelled') {
          if (this.captionTimeline.interrupt(message.response_id)) this.syncCaptions();
        }
        if (typeof message.response_id === 'string' && message.response_id && ['failed', 'incomplete'].includes(String(message.status))) {
          if (this.captionTimeline.audioUnavailable(message.response_id)) this.syncCaptions();
        }
        this.releasePending();
        if (typeof message.response_id === 'string' && message.response_id === this.currentResponseId && !this.audioExpected()) {
          this.currentResponseId = null;
          if (['thinking', 'speaking'].includes(this.snapshot.phase)) this.update({ phase: 'listening', voiceEnergy: 0 });
        }
        const playing = this.voice?.playingResponseId() ?? null;
        if (playing === null && this.timeline.pendingCount() === 0 && this.snapshot.phase === 'speaking') this.update({ phase: 'listening' });
        break;
      }
      case 'safe_question': {
        const text = String(message.text ?? '').trim();
        if (text && this.captionTimeline.appendTutorText(text)) this.syncCaptions();
        this.update({ phase: 'listening' });
        break;
      }
      case 'fallback_caption': {
        const text = String(message.text ?? '').trim();
        if (text && this.captionTimeline.appendTutorText(text, String(message.response_id ?? '') || undefined)) this.syncCaptions();
        this.update({ phase: 'fallback' });
        break;
      }
      case 'illustration_status': {
        const status = message.status;
        if (status === 'ready' || status === 'failed') {
          this.update({ illustration: status === 'failed' ? { status: 'failed' } : null });
          if (status === 'failed') {
            this.scope.timeout(() => {
              if (this.snapshot.illustration?.status === 'failed') this.update({ illustration: null });
            }, 4000);
          }
          break;
        }
        if (status !== 'preparing' && status !== 'partial') break;
        this.update({
          illustration: {
            status,
            ...(typeof message.alt === 'string' ? { alt: message.alt } : {}),
            ...(status === 'partial' && typeof message.partialDataUrl === 'string'
              ? { partialDataUrl: message.partialDataUrl }
              : {}),
          },
        });
        break;
      }
      case 'image_region_tap_request': {
        const requestId = String(message.request_id ?? '').trim();
        const imageId = String(message.image_id ?? '').trim();
        const hint = String(message.hint ?? '').trim();
        if (requestId && imageId && hint) this.update({ imageGrounding: { requestId, imageId, hint } });
        break;
      }
      case 'image_region_grounded': {
        const requestId = String(message.request_id ?? '').trim();
        if (!requestId || this.snapshot.imageGrounding?.requestId === requestId) this.update({ imageGrounding: null });
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
    const now = performance.now();
    let captionsChanged = this.captionTimeline.advance(now);
    let silentCurrentResponse = false;
    for (const [responseId, doneAt] of this.responseDoneAt) {
      if (!this.startedResponses.has(responseId) && now - doneAt >= SILENT_RESPONSE_GRACE_MS) {
        captionsChanged = this.captionTimeline.audioUnavailable(responseId) || captionsChanged;
        if (responseId === this.currentResponseId) silentCurrentResponse = true;
      }
    }
    if (captionsChanged) this.syncCaptions();
    if (silentCurrentResponse) {
      this.currentResponseId = null;
      if (['thinking', 'speaking'].includes(this.snapshot.phase)) this.update({ phase: 'listening', voiceEnergy: 0 });
    }
    const energy = this.voice?.readVoiceEnergy() ?? 0;
    if (Math.abs(energy - this.snapshot.voiceEnergy) > 0.01) this.update({ voiceEnergy: energy });
    for (const cue of this.timeline.drain((responseId) => this.responsePlaybackStatus(responseId))) this.releaseCue(cue);
  }

  private releaseCue(cue: ResponseCue): void {
    if (!this.isCurrent(cue.identity) || this.deadResponses.has(cue.responseId)) return;
    if (cue.kind === 'visual') this.releaseOps(cue);
    else if (cue.kind === 'semantic') this.update({ lessonState: { ...this.snapshot.lessonState, ...(cue.state as LessonState) } });
    else if (cue.kind === 'task') {
      this.update({ task: cue.task });
      this.onCaptionQuestion(this.scope.identity);
    }
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
      awaitNarration: item.awaitNarration,
      eventId: item.eventId ?? undefined,
    })).then((completed) => {
      if (completed === false && item.eventId !== null) {
        this.rejectBoardCue(item, 'The checkpoint exceeded the board layout or legibility budget.');
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
          // The checkpoint is on screen. If the learner interrupts during the
          // draw-on animation, finish and acknowledge the visible checkpoint
          // using the new client identity so it stays replayable.
          this.send('ops_shown', { event_id: item.eventId });
        }
      }
    }).catch((error) => {
      this.rejectBoardCue(item, 'The board renderer failed before the checkpoint could be committed.');
      console.error('Noura board checkpoint failed', error);
      this.update({ error: 'Noura could not show that board update. The lesson will continue with the visible work.' });
    });
  }

  private rejectBoardCue(item: Extract<ResponseCue, { kind: 'visual' }>, reason: string): void {
    if (item.eventId === null) return;
    this.send('ops_rejected', {
      event_id: item.eventId,
      response_id: item.responseId,
      reason,
    });
  }

  private syncCaptions(): void {
    const next = this.captionTimeline.lines();
    if (sameCaptions(this.snapshot.captions, next)) return;
    const previousTutor = [...this.snapshot.captions].reverse().find((line) => line.role === 'tutor');
    const nextTutor = [...next].reverse().find((line) => line.role === 'tutor');
    this.update({ captions: next });
    if (nextTutor && nextTutor.text !== previousTutor?.text && /[?？]\s*$/.test(nextTutor.text)) {
      this.onCaptionQuestion(this.scope.identity);
    }
  }

  private async runFallbackTurn(text: string, idempotencyKey: string, scope: GenerationScope): Promise<void> {
    if (this.captionTimeline.appendChild(text)) this.syncCaptions();
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
    const handleLine = (line: string) => {
      if (!line.trim() || !scope.active) return;
      try {
        const decoded = JSON.parse(line) as unknown;
        if (RuntimeEventEnvelopeSchema.safeParse(decoded).success) this.handleServer(decoded);
        else this.handleFallbackStep(decoded as Record<string, unknown>, scope.identity);
      } catch { /* malformed line */ }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !scope.active) {
        buffer += decoder.decode();
        handleLine(buffer);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
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
    this.scope.interval(() => this.pollMicEnergy(), MIC_ENERGY_POLL_MS);
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

function sameCaptions(left: readonly CaptionLine[], right: readonly CaptionLine[]): boolean {
  return left.length === right.length && left.every((line, index) => {
    const candidate = right[index];
    return line.role === candidate.role && line.text === candidate.text &&
      line.live === candidate.live && line.responseId === candidate.responseId;
  });
}
