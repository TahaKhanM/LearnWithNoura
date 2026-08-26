import type { BoardOp } from '../../shared/boardOps.js';
import type { CompiledLesson } from '../../shared/compiledLesson.js';
import type { GenerationIdentity, RuntimeEventEnvelope } from '../../shared/runtimeProtocol.js';
import type { DeliveredTask } from '../../shared/lessonTurn.js';
import type { LessonStage } from '../../shared/pedagogy.js';
import type { BoardDirector } from '../board/director.js';
import type { LessonOrchestrationState } from '../lesson/orchestrator.js';
import type { DomainRepository } from '../store/domain.js';
import type { SessionTelemetryWriter } from '../session/telemetryWriter.js';
import type { SessionTelemetryRepository } from '../session/telemetryRepository.js';
import type { BoardContextTracker } from './boardContext.js';
import type { StoryboardRunState } from './storyboardRunner.js';

/**
 * Shared mutable state and wiring for one lesson's realtime coordination.
 *
 * The coordinator was decomposed from a single closure into focused modules
 * (turn/floor ownership, tool handling, board plan staging, session
 * bootstrap, telemetry glue, event dispatch). They all operate on this one
 * context so the runtime semantics of the original closure are preserved
 * exactly: one lesson, one upstream provider connection, one browser client.
 */

export type ResponseCreateSource = 'tool' | 'user' | 'board' | 'voice' | 'start' | 'beat';

export interface PendingBoardOpsEntry {
  ops: BoardOp[];
  semanticGroupId?: string;
  groupLabel?: string;
  replacesGroup?: string;
}

export interface CoordinatorState {
  /** True once the upstream session configuration has been acknowledged. */
  upstreamReady: boolean;
  toolContinues: number;
  /** response ids we know were cancelled by barge-in. */
  cancelledResponses: Set<string>;
  started: boolean;
  /**
   * True from the moment the child takes the floor (speech started, or an
   * explicit interrupt) until they finish their turn. While the child
   * holds the floor, tool results must not spawn continuation responses.
   */
  childHoldsFloor: boolean;
  /** What the most recent response.create was for, to target retries. */
  lastCreateSource: ResponseCreateSource;
  /** A user ask hit an active response; ask again once it finishes. */
  retryCreateOnDone: boolean;
  /** Tool results wait for this response to finish before continuing. */
  toolContinueAfterResponseId: string | null;
  clientIdentity: GenerationIdentity | null;
  clientSequence: number;
  lastClientSequence: number;
  seenClientEvents: Set<string>;
  seenIdempotencyKeys: Set<string>;
  pendingClientPayloads: unknown[];
  responseIdentities: Map<string, GenerationIdentity>;
  responseTranscript: Map<string, string>;
  /** The conversation item each response speaks, for truthful truncation. */
  responseItems: Map<string, string>;
  pendingVoiceBargeInResponses: Set<string>;
  terminalTelemetryResponses: Set<string>;
  /** Responses whose client-reported playback duration was already recorded. */
  reportedPlaybackResponses: Set<string>;
  pendingBoardOps: Map<number, PendingBoardOpsEntry>;
  activeResponseId: string | null;
  speechInProgress: boolean;
  endpointingEagerness: 'medium' | 'high';
  lessonState: LessonOrchestrationState;
  lastLearnerEventId: number | null;
  /** The learner is composing a drawing; nothing may auto-create a response. */
  draftOpen: boolean;
  /** Board submissions already answered — duplicate Done must be a no-op. */
  respondedSubmissionIds: Set<string>;
  /** Every response.create is keyed; a key never creates twice. */
  usedResponseKeys: Set<string>;
  voiceTurnCounter: number;
  /** A task the model proposed but has not yet finished speaking. */
  pendingDeliveredTask: DeliveredTask | null;
  preflightCounter: number;
  pendingPreflights: Map<string, (result: { accepted: boolean; reasons: string[] }) => void>;
  /**
   * Logical tutor-turn visual budget. At most one semantic plan may be
   * prepared per tutor turn; the budget resets only when a genuine learner
   * turn (voice, text, or board submission) starts the next teaching turn.
   */
  visualPlanState: 'none' | 'preparing' | 'rendering' | 'visible' | 'failed';
  /**
   * Monotonic scope for asynchronous visual work (anchor preflights and
   * Director scenes). Captured when a request is accepted and re-checked
   * after every await: a genuine learner turn advances the epoch, so stale
   * completions are abandoned explicitly instead of building mid-turn.
   */
  visualRequestEpoch: number;
  /** Request ids whose stale completion was already abandoned — the honest
   * "will not appear" note must fire at most once per request. */
  abandonedVisualRequests: Set<string>;
  planStagedThisTurn: boolean;
  /** A failed plan may retry once with a simpler plan; never more. */
  planAttemptsThisTurn: number;
  /** Tutor objects created in the current logical turn may not be erased. */
  objectsCreatedThisTurn: Set<string>;
  /** Resolvers waiting for the browser to confirm a checkpoint on screen. */
  pendingVisibility: Map<number, (shown: boolean) => void>;
  /** Count of announced comparison sections beside the anchor. */
  comparisonSectionCounter: number;
  /** Server-side mirror of the board the learner has actually seen. */
  boardContext: BoardContextTracker;
  /** response.create sends not yet confirmed by a response.created event.
   * The storyboard runner never starts a beat while one is in flight. */
  pendingResponseCreates: number;
  /** The last terminal, non-cancelled provider response — the playback
   * boundary a deferred reveal cue binds to on the client. */
  lastCompletedResponseId: string | null;
  /** Provider responses created as storyboard narration beats. Beats are
   * tutor-floor continuations: they never trigger handoff machinery. The
   * runner's closing handoff response is deliberately NOT in this set — it
   * delivers the stage task through the ordinary contract. */
  beatResponses: Set<string>;
  /** The storyboard run currently revealing a scene beat by beat. */
  storyboardRun: StoryboardRunState | null;
}

export type ClientCueOptional = Partial<Pick<
  RuntimeEventEnvelope,
  'visualCueId' | 'semanticObjectId' | 'idempotencyKey'
>>;

export interface CoordinatorContext {
  readonly repo: DomainRepository;
  readonly sessionId: string;
  readonly lessonGoal: string;
  /** The pre-compiled, validated lesson this session executes; null only
   * for legacy sessions recorded before the lesson compiler existed. */
  readonly compiledLesson: CompiledLesson | null;
  readonly baseInstructions: string;
  readonly log: (line: string) => void;
  readonly telemetryWriter: SessionTelemetryWriter;
  readonly telemetryRepo: SessionTelemetryRepository;
  readonly preflightTimeoutMs: number;
  readonly visibilityTimeoutMs: number;
  /** Compiler entry point that authors a bounded detour mini-plan; null
   * when no compiler is wired (the simple detour then always stands). */
  readonly planDetour: ((input: { objective: string; reason: string; returnStageObjective: string }) => Promise<LessonStage[]>) | null;
  readonly detourPlanTimeoutMs: number;
  /** The Board Director for slow-tier scene requests; null when none is
   * wired — new-scene requests then fail closed with a clean rejection. */
  readonly directVisual: BoardDirector | null;
  /** How long one storyboard step may await its visibility confirmation
   * (covers the previous beat's playback plus the draw-on animation). */
  readonly stepRevealTimeoutMs: number;
  readonly state: CoordinatorState;
  sendClient(
    payload: Record<string, unknown>,
    identity?: GenerationIdentity | null,
    optional?: ClientCueOptional,
  ): void;
  sendUpstream(payload: unknown): void;
  clientConnected(): boolean;
  trackSideEffect(task: Promise<void>): void;
  trackTelemetry(task: Promise<void>): void;
}
