import { WebSocket as NodeWebSocket, type WebSocket as ClientSocket } from 'ws';
import { normalizeColor, validateOps, validateSpec, type BoardOp } from '../../shared/boardOps.js';
import {
  createRuntimeEvent,
  RuntimeEventEnvelopeSchema,
  type GenerationIdentity,
  type RuntimeEventEnvelope,
} from '../../shared/runtimeProtocol.js';
import {
  MetricInputSchema,
  TELEMETRY_SCHEMA_VERSION,
  type MetricInput,
} from '../../shared/sessionTelemetry.js';
import { buildInstructions } from './instructions.js';
import { REALTIME_TOOLS } from './tools.js';
import type { Confidence, Verdict } from '../store/repo.js';
import { createLessonState, currentStage, reduceLesson, responseHandoff } from '../lesson/orchestrator.js';
import { LessonBlueprintSchema, ResponseTaxonomySchema, TeachingMoveSchema, type LessonBlueprint, type ResponseTaxonomy, type TeachingMove } from '../../shared/pedagogy.js';
import { adaptSemanticScene, normalizeVisualAction, VisualActionSchema, type SemanticCheckpoint, type SemanticScenePlan } from '../../shared/semanticScene.js';
import { BoardSubmissionSchema, DeliveredTaskSchema, submitPolicyForMode, type DeliveredTask } from '../../shared/lessonTurn.js';
import { ResponseSegmentAnnotator } from './segmentAnnotator.js';
import { loadReleasedBoardContext } from './boardContext.js';
import type { DomainRepository } from '../store/domain.js';
import {
  metricContextFromIdentity,
  recordMetric,
  recordProviderUsage,
} from '../session/telemetryRecorder.js';

/**
 * Bridges one browser lesson to one OpenAI Realtime session.
 *
 * The browser never sees the API key; the server sees every event, so the
 * child experience and the parent dashboard are fed by the same stream.
 * Tool calls are executed here: board operations are validated before a
 * single mark reaches the board, and evidence is persisted as it happens.
 */

const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
const OUTPUT_AUDIO_SAMPLES_PER_MS = 24;
const RECONNECT_HISTORY_PAGE_SIZE = 5_000;

/** Stop auto-continuing tool chains after this many rounds per turn. */
const MAX_TOOL_CONTINUES = 14;

async function hasReleasedSessionStart(
  repo: DomainRepository,
  sessionId: string,
): Promise<boolean> {
  let throughEventId: number | null = null;

  try {
    while (true) {
      const page = await repo.listEvents(
        sessionId,
        RECONNECT_HISTORY_PAGE_SIZE,
        throughEventId,
      );
      if (page.some((event) => event.type === 'session_started')) return true;
      if (page.length < RECONNECT_HISTORY_PAGE_SIZE) return false;

      const oldestEventId = page[0]?.id;
      if (oldestEventId === undefined || oldestEventId <= 1) return false;
      const nextThroughEventId = oldestEventId - 1;
      if (throughEventId !== null && nextThroughEventId >= throughEventId) return false;
      throughEventId = nextThroughEventId;
    }
  } catch {
    return false;
  }
}

function isAllowedClientMetric(input: MetricInput): boolean {
  switch (input.name) {
    case 'speech_end_to_response_started':
    case 'speech_end_to_first_audio':
    case 'ask_to_first_audio':
    case 'board_reveal_to_narration':
    case 'section_navigation':
    case 'tutor_object_disappearance':
      return true;
    case 'barge_in_gate_outcome':
      return input.dimensions.outcome === 'local_only_rejected' ||
        input.dimensions.outcome === 'provider_only_rejected';
    default:
      return false;
  }
}

interface UpstreamEvent {
  type: string;
  [key: string]: unknown;
}

interface ClientMessage {
  type: string;
  [key: string]: unknown;
}

export interface ProxyOptions {
  apiKey: string;
  model: string;
  repo: DomainRepository;
  sessionId: string;
  log?: (line: string) => void;
  createUpstream?: (url: string, apiKey: string) => NodeWebSocket;
  /** How long to wait for the browser to compile-check a full visual plan. */
  preflightTimeoutMs?: number;
  /** How long to wait for the browser to confirm a staged plan is visible. */
  visibilityTimeoutMs?: number;
}

export async function connectRealtimeProxy(client: ClientSocket, options: ProxyOptions): Promise<void> {
  const { apiKey, model, repo, sessionId } = options;
  const log = options.log ?? (() => {});
  const session = await repo.getSession(sessionId);
  const child = session ? await repo.getChild(session.childId) : null;

  if (!session || !child) {
    sendClient({ type: 'error', message: 'Unknown session.' });
    client.close(4404, 'unknown session');
    return;
  }
  if (session.status !== 'active') {
    sendClient({ type: 'error', message: 'This lesson has ended and is read-only.' });
    client.close(4409, 'session ended');
    return;
  }

  const lessonGoal = session.goal;
  const baseInstructions = buildInstructions({
    childName: child.name,
    childAge: child.age,
    goal: session.goal,
  });
  let boardContext = await loadReleasedBoardContext(repo, sessionId);

  const upstreamUrl = `${REALTIME_URL}?model=${encodeURIComponent(model)}`;
  const upstream = options.createUpstream?.(upstreamUrl, apiKey) ?? new NodeWebSocket(upstreamUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  let upstreamReady = false;
  let closed = false;
  let toolContinues = 0;
  /** response ids we know were cancelled by barge-in. */
  const cancelledResponses = new Set<string>();
  let started = false;
  /**
   * True from the moment the child takes the floor (speech started, or an
   * explicit interrupt) until they finish their turn. While the child
   * holds the floor, tool results must not spawn continuation responses.
   */
  let childHoldsFloor = false;
  /** What the most recent response.create was for, to target retries. */
  let lastCreateSource: 'tool' | 'user' | 'board' | 'voice' | 'start' = 'start';
  /** A user ask hit an active response; ask again once it finishes. */
  let retryCreateOnDone = false;
  let clientIdentity: GenerationIdentity | null = null;
  let clientSequence = 0;
  let lastClientSequence = -1;
  const seenClientEvents = new Set<string>();
  const seenIdempotencyKeys = new Set<string>();
  const pendingClientPayloads: unknown[] = [];
  const responseIdentities = new Map<string, GenerationIdentity>();
  const responseTranscript = new Map<string, string>();
  const responseSegments = new Map<string, ResponseSegmentAnnotator>();
  const pendingVoiceBargeInResponses = new Set<string>();
  const pendingBoardOps = new Map<number, { ops: BoardOp[]; semanticGroupId?: string; groupLabel?: string; replacesGroup?: string }>();
  let activeResponseId: string | null = null;
  let speechInProgress = false;
  let endpointingEagerness: 'medium' | 'high' = 'medium';
  let lessonState = createLessonState(session.goal);
  let lastLearnerEventId: number | null = null;
  let upstreamWork = Promise.resolve();
  let clientWork = Promise.resolve();
  /** The learner is composing a drawing; nothing may auto-create a response. */
  let draftOpen = false;
  /** Board submissions already answered — duplicate Done must be a no-op. */
  const respondedSubmissionIds = new Set<string>();
  /** Every response.create is keyed; a key never creates twice. */
  const usedResponseKeys = new Set<string>();
  let voiceTurnCounter = 0;
  /** A task the model proposed but has not yet finished speaking. */
  let pendingDeliveredTask: DeliveredTask | null = null;
  const preflightTimeoutMs = options.preflightTimeoutMs ?? 1_200;
  const visibilityTimeoutMs = options.visibilityTimeoutMs ?? 15_000;
  let preflightCounter = 0;
  const pendingPreflights = new Map<string, (result: { accepted: boolean; reasons: string[] }) => void>();
  /**
   * Logical tutor-turn visual budget. At most one semantic plan may be
   * prepared per tutor turn; the budget resets only when a genuine learner
   * turn (voice, text, or board submission) starts the next teaching turn.
   */
  let visualPlanState: 'none' | 'preparing' | 'rendering' | 'visible' | 'failed' = 'none';
  let planStagedThisTurn = false;
  /** A failed plan may retry once with a simpler plan; never more. */
  let planAttemptsThisTurn = 0;
  /** Tutor objects created in the current logical turn may not be erased. */
  let objectsCreatedThisTurn = new Set<string>();
  /** Resolvers waiting for the browser to confirm a checkpoint on screen. */
  const pendingVisibility = new Map<number, (shown: boolean) => void>();
  /** Count of announced comparison sections beside the anchor. */
  let comparisonSectionCounter = 0;

  function sendClient(
    payload: Record<string, unknown>,
    identity = clientIdentity,
    optional: Partial<Pick<RuntimeEventEnvelope, 'audioSampleOffsets' | 'visualCueId' | 'semanticObjectId' | 'idempotencyKey'>> = {},
  ): void {
    if (!identity) {
      pendingClientPayloads.push(payload);
      return;
    }
    if (client.readyState !== client.OPEN) return;
    const { type, ...body } = payload;
    client.send(JSON.stringify(createRuntimeEvent(
      identity,
      clientSequence++,
      String(type ?? 'unknown'),
      body,
      {
        ...(typeof body.response_id === 'string' ? { providerResponseId: body.response_id } : {}),
        ...(typeof body.item_id === 'string' ? { providerItemId: body.item_id } : {}),
        ...optional,
      },
    )));
  }

  function flushPendingClientPayloads(): void {
    if (!clientIdentity) return;
    for (const payload of pendingClientPayloads.splice(0)) sendClient(payload as Record<string, unknown>);
  }

  function identityForResponse(responseId: unknown): GenerationIdentity | null {
    return typeof responseId === 'string' ? responseIdentities.get(responseId) ?? clientIdentity : clientIdentity;
  }

  function trustedClientResponseId(envelope: RuntimeEventEnvelope): string | undefined {
    const responseId = envelope.providerResponseId;
    if (!responseId) return undefined;
    const identity = responseIdentities.get(responseId);
    if (!identity) return undefined;
    return identity.sessionId === envelope.sessionId &&
      identity.connectionEpoch === envelope.connectionEpoch &&
      identity.turnId === envelope.turnId &&
      identity.generationId === envelope.generationId
      ? responseId
      : undefined;
  }

  function sendUpstream(payload: unknown): void {
    if (upstream.readyState === NodeWebSocket.OPEN) upstream.send(JSON.stringify(payload));
  }

  /**
   * The single owner of `response.create`. Semantic VAD only chunks and
   * transcribes speech (`create_response: false`); every model response is
   * created here, keyed and idempotent, and never while the learner is
   * composing a drawing draft.
   */
  function requestModelResponse(source: 'user' | 'board' | 'voice' | 'start', key: string): boolean {
    if (usedResponseKeys.has(key)) return false;
    if (source !== 'user' && draftOpen) return false;
    usedResponseKeys.add(key);
    if (usedResponseKeys.size > 512) usedResponseKeys.delete(usedResponseKeys.values().next().value as string);
    childHoldsFloor = false;
    toolContinues = 0;
    lastCreateSource = source;
    // A genuine learner turn starts the next teaching turn: the one-plan
    // visual budget and the erase guard reset here and nowhere else.
    planStagedThisTurn = false;
    planAttemptsThisTurn = 0;
    if (visualPlanState !== 'rendering') visualPlanState = 'none';
    objectsCreatedThisTurn = new Set();
    sendUpstream({ type: 'response.create' });
    return true;
  }

  /** Resolves when the browser has confirmed every staged checkpoint is
   * actually on screen (`ops_shown`), or fails closed on rejection/timeout. */
  function waitForCheckpointVisibility(eventIds: number[]): Promise<boolean> {
    if (eventIds.length === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let remaining = eventIds.length;
      let settled = false;
      const timer = setTimeout(() => finish(false), visibilityTimeoutMs);
      const finish = (shown: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const eventId of eventIds) pendingVisibility.delete(eventId);
        resolve(shown);
      };
      for (const eventId of eventIds) {
        pendingVisibility.set(eventId, (shown) => {
          if (!shown) { finish(false); return; }
          remaining -= 1;
          if (remaining <= 0) finish(true);
        });
      }
    });
  }

  /**
   * Asks the browser to compile-check a complete candidate plan offscreen.
   * Fails closed: no connected client or a timeout means "not shown" — the
   * model may continue without a visual or retry a simpler plan, but missing
   * evidence is never turned into acceptance.
   */
  function preflightWithClient(input: { ops: BoardOp[]; semanticGroupId: string; groupLabel?: string; replacesGroup?: string }): Promise<{ accepted: boolean; reasons: string[] }> {
    if (!clientIdentity || client.readyState !== client.OPEN) return Promise.resolve({ accepted: false, reasons: ['no browser is connected to validate the plan'] });
    const preflightId = `preflight-${++preflightCounter}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingPreflights.delete(preflightId);
        resolve({ accepted: false, reasons: ['the browser did not confirm the plan in time'] });
      }, preflightTimeoutMs);
      pendingPreflights.set(preflightId, (result) => {
        clearTimeout(timer);
        pendingPreflights.delete(preflightId);
        resolve(result);
      });
      sendClient({
        type: 'visual_preflight',
        preflight_id: preflightId,
        ops: input.ops,
        semanticObjectId: input.semanticGroupId,
        ...(input.groupLabel ? { groupLabel: input.groupLabel } : {}),
        ...(input.replacesGroup ? { replacesGroup: input.replacesGroup } : {}),
      });
    });
  }

  function anchorGroupId(): string | null {
    return lessonState.blueprint?.anchor?.semanticGroupId ?? null;
  }

  /**
   * The visibility barrier for board-led moves: validate → preflight (fail
   * closed) → stage exactly one plan → wait until the browser confirms it is
   * actually on screen (`ops_shown`) → only then return the successful tool
   * result (with the now-authoritative visible board) so continuation speech
   * can refer to what the learner can really see.
   */
  function stageAndConfirmPlan(callId: string, responseId: string, input: {
    ops: BoardOp[];
    checkpoints: SemanticCheckpoint[];
    action: string;
    plan?: SemanticScenePlan;
    announcement?: string;
    skipPreflight?: boolean;
  }): void {
    const groupId = input.checkpoints[0]?.semanticObjectId ?? '';
    const groupLabel = input.checkpoints[0]?.groupLabel;
    const structural = ['establish', 'compare'].includes(input.action);
    if (structural) {
      planStagedThisTurn = true;
      planAttemptsThisTurn += 1;
      visualPlanState = 'preparing';
    }
    // Captured synchronously: staging may finish after this response seals,
    // in which case cues are delivered directly at its final audio boundary.
    const planSegment = responseSegment(responseId);
    void (async () => {
      if (!input.skipPreflight && input.ops.length > 0 && groupId) {
        const preflight = await preflightWithClient({ ops: input.ops, semanticGroupId: groupId, groupLabel });
        if (!preflight.accepted) {
          if (structural) visualPlanState = 'failed';
          boardContext.observeBoardRejection(preflight.reasons.join('; ').slice(0, 300) || 'Complete-plan preflight failed.');
          refreshBoardInstructions();
          finishTool(callId, responseId, {
            ok: false,
            accepted: false,
            reason: `The complete visual failed deterministic layout preflight: ${preflight.reasons.join('; ').slice(0, 240)}. Nothing was drawn. Continue without the visual or retry once with a simpler plan.`,
            board: boardContext.toolSnapshot(),
          });
          return;
        }
      }
      if (structural) visualPlanState = 'rendering';
      const eventIds: number[] = [];
      for (const checkpoint of input.checkpoints) {
        const eventId = await repo.addEvent(sessionId, 'semantic_scene', {
          ...(input.plan ? { plan: input.plan } : {}),
          ops: checkpoint.ops,
          checkpointId: checkpoint.id,
          reveal: checkpoint.reveal,
          semanticObjectId: checkpoint.semanticObjectId,
          groupLabel: checkpoint.groupLabel,
        }, false);
        eventIds.push(eventId);
        pendingBoardOps.set(eventId, {
          ops: checkpoint.ops,
          semanticGroupId: checkpoint.semanticObjectId,
          groupLabel: checkpoint.groupLabel,
        });
        const cuePayload = {
          type: 'board_ops',
          ops: checkpoint.ops,
          response_id: responseId,
          event_id: eventId,
          groupLabel: checkpoint.groupLabel,
          checkpoint: checkpoint.reveal,
        };
        const cueOptional = {
          visualCueId: checkpoint.id,
          semanticObjectId: checkpoint.semanticObjectId,
        };
        if (!planSegment.isSealed()) planSegment.addSemanticCue(cuePayload, cueOptional);
        else if (!cancelledResponses.has(responseId)) {
          const total = planSegment.totalSamples();
          sendClient(cuePayload, identityForResponse(responseId), { ...cueOptional, audioSampleOffsets: { start: total, end: total } });
        }
      }
      for (const op of input.ops) if (op.op === 'add') objectsCreatedThisTurn.add(op.id);
      const visible = await waitForCheckpointVisibility(eventIds);
      if (!visible) {
        if (structural) visualPlanState = 'failed';
        for (const eventId of eventIds) pendingBoardOps.delete(eventId);
        finishTool(callId, responseId, {
          ok: false,
          accepted: false,
          reason: 'The visual was not confirmed on the learner’s screen. It is not visible; do not refer to it. Continue without it or retry once with a simpler plan.',
          board: boardContext.toolSnapshot(),
        });
        return;
      }
      if (structural) visualPlanState = 'visible';
      // The board context was advanced by the acknowledgements, so this
      // snapshot is the authoritative, actually-visible board.
      finishTool(callId, responseId, {
        ok: true,
        accepted: true,
        visible: true,
        applied: input.ops.length,
        checkpoints: input.checkpoints.length,
        action: input.action,
        visibleObjectIds: input.ops.filter((op) => op.op === 'add').map((op) => op.id),
        ...(groupId ? { semanticGroupId: groupId } : {}),
        ...(input.announcement ? { announcement: input.announcement } : {}),
        board: boardContext.toolSnapshot(),
      });
    })().catch((error) => {
      if (structural) visualPlanState = 'failed';
      log(`session ${sessionId}: semantic plan staging error ${String(error).slice(0, 200)}`);
      finishTool(callId, responseId, { ok: false, accepted: false, error: String(error).slice(0, 260) });
    });
  }

  /** The server, not the model, decides which section a plan builds. */
  function assignSectionToPlan(rawArgs: Record<string, unknown>, groupId: string): Record<string, unknown> {
    const source = rawArgs as { groups?: Array<Record<string, unknown>> };
    const groups = (source.groups ?? []).map((group, index) => index === 0 ? { ...group, id: groupId } : group);
    return { ...rawArgs, groups };
  }

  function setEndpointingEagerness(eagerness: 'medium' | 'high'): void {
    if (endpointingEagerness === eagerness) return;
    endpointingEagerness = eagerness;
    sendUpstream({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: { input: { turn_detection: semanticTurnDetection(eagerness) } },
      },
    });
  }

  function currentInstructions(): string {
    return `${baseInstructions}\n\n${boardContext.prompt()}`;
  }

  function refreshBoardInstructions(): void {
    sendUpstream({ type: 'session.update', session: { type: 'realtime', instructions: currentInstructions() } });
  }

  function responseSegment(responseId: string): ResponseSegmentAnnotator {
    const existing = responseSegments.get(responseId);
    if (existing) return existing;
    const created = new ResponseSegmentAnnotator();
    responseSegments.set(responseId, created);
    return created;
  }

  function flushResponseSegment(responseId: string, completed: boolean): void {
    const segment = responseSegments.get(responseId);
    responseSegments.delete(responseId);
    if (!segment || !completed || cancelledResponses.has(responseId)) return;
    for (const cue of segment.seal()) {
      sendClient({ ...cue.payload, response_id: responseId }, identityForResponse(responseId), cue.optional);
    }
  }

  function teardown(reason: string): void {
    if (closed) return;
    closed = true;
    log(`session ${sessionId}: closed (${reason})`);
    try {
      upstream.close();
    } catch {
      /* already closed */
    }
    try {
      client.close();
    } catch {
      /* already closed */
    }
  }

  upstream.onopen = () => {
    sendUpstream({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        reasoning: { effort: 'low' },
        instructions: currentInstructions(),
        tools: REALTIME_TOOLS,
        tool_choice: 'auto',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: semanticTurnDetection('medium'),
          },
          output: { voice: 'marin', format: { type: 'audio/pcm', rate: 24000 } },
        },
      },
    });
  };

  upstream.onmessage = (raw) => {
    let event: UpstreamEvent;
    try {
      event = JSON.parse(String(raw.data));
    } catch {
      return;
    }
    upstreamWork = upstreamWork
      .then(() => handleUpstream(event))
      .catch((error) => {
        log(`session ${sessionId}: upstream processing error ${String(error).slice(0, 240)}`);
        sendClient({ type: 'error', message: 'Noura hit a snag — it will recover in a moment.' });
      });
  };

  upstream.onerror = () => {
    sendClient({ type: 'error', message: 'Lost the connection to the tutor voice service.' });
  };

  upstream.onclose = () => {
    sendClient({ type: 'upstream_closed' });
    teardown('upstream closed');
  };

  async function replayBoard(): Promise<void> {
    // Only marks the child actually saw; ops cancelled mid-speech were
    // never released and must not reappear after a refresh. Stored ops are
    // re-validated so yesterday's data always meets today's rules.
    const events = await repo.listEvents(sessionId, 2000);
    const batches = events
      .filter((e) => ['board_ops', 'semantic_scene'].includes(e.type) && e.released)
      .map((e) => {
        const payload = e.payload as { ops?: unknown[]; semanticObjectId?: unknown; groupLabel?: unknown; replacesGroup?: unknown; plan?: { groups?: Array<{ id?: unknown; label?: unknown }> } };
        const ops = validateOps(payload.ops).ops;
        const semanticObjectId = typeof payload.semanticObjectId === 'string'
          ? payload.semanticObjectId
          : typeof payload.plan?.groups?.[0]?.id === 'string' ? payload.plan.groups[0].id : undefined;
        const groupLabel = typeof payload.groupLabel === 'string'
          ? payload.groupLabel
          : typeof payload.plan?.groups?.[0]?.label === 'string' ? payload.plan.groups[0].label : undefined;
        return {
          ops,
          ...(semanticObjectId ? { semanticObjectId } : {}),
          ...(groupLabel ? { groupLabel } : {}),
          ...(typeof payload.replacesGroup === 'string' && payload.replacesGroup ? { replacesGroup: payload.replacesGroup } : {}),
        };
      })
      .filter((batch) => batch.ops.length > 0);
    if (batches.length > 0) sendClient({ type: 'board_replay', batches });
    const learnerBatches = events
      .filter((event) => event.type === 'learner_board' && event.released)
      .map((event) => {
        const payload = event.payload as { ops?: unknown; semanticObjectId?: unknown };
        const ops = learnerBoardOps(payload.ops);
        return { ops, ...(typeof payload.semanticObjectId === 'string' ? { semanticObjectId: payload.semanticObjectId } : {}) };
      })
      .filter((batch) => batch.ops.length > 0);
    if (learnerBatches.length > 0) sendClient({ type: 'learner_board_replay', batches: learnerBatches });
    restoreBlueprint(events);
    await restoreDeliveredTask(events);
  }

  /** A refresh resumes the same blueprint at the same stage; the lesson plan
   * is durable and never regenerated by reconnecting. */
  function restoreBlueprint(events: Awaited<ReturnType<DomainRepository['listEvents']>>): void {
    if (lessonState.blueprint) return;
    let blueprint: LessonBlueprint | null = null;
    let progress: { currentStageIndex: number; detourStack: LessonBlueprint['detourStack'] } | null = null;
    for (const event of events) {
      if (event.type === 'lesson_blueprint') {
        const parsed = LessonBlueprintSchema.safeParse((event.payload as { blueprint?: unknown }).blueprint);
        if (parsed.success) { blueprint = parsed.data; progress = null; }
      } else if (event.type === 'blueprint_progress' && blueprint) {
        const payload = event.payload as { currentStageIndex?: unknown; detourStack?: unknown };
        if (typeof payload.currentStageIndex === 'number') {
          progress = {
            currentStageIndex: Math.max(0, Math.min(blueprint.stages.length - 1, payload.currentStageIndex)),
            detourStack: Array.isArray(payload.detourStack)
              ? (payload.detourStack as LessonBlueprint['detourStack']).slice(-4)
              : [],
          };
        }
      }
    }
    if (!blueprint) return;
    try {
      lessonState = reduceLesson(lessonState, { type: 'BLUEPRINT_CREATED', blueprint });
      if (progress) {
        lessonState = {
          ...lessonState,
          blueprint: { ...blueprint, currentStageIndex: progress.currentStageIndex, detourStack: progress.detourStack },
        };
      }
    } catch { /* restoring an old blueprint never breaks the live lesson */ }
  }

  /** After a refresh, an unanswered task must survive: restore the contract
   * and show the banner again rather than losing the learner's turn. */
  async function restoreDeliveredTask(events: Awaited<ReturnType<DomainRepository['listEvents']>>): Promise<void> {
    let openTask: DeliveredTask | null = null;
    for (const event of events) {
      if (event.type === 'learner_task') {
        const parsed = DeliveredTaskSchema.safeParse((event.payload as { task?: unknown }).task);
        if (parsed.success) openTask = parsed.data;
      } else if (['learner_said', 'learner_board'].includes(event.type)) openTask = null;
    }
    if (!openTask) return;
    try {
      lessonState = reduceLesson(lessonState, {
        type: 'QUESTION_DELIVERED', taskId: openTask.taskId, text: openTask.prompt, responseMode: openTask.responseMode,
      });
    } catch { /* restoring an old task never breaks the live lesson */ }
    sendClient({ type: 'learner_task', task: openTask, restored: true });
  }

  /** After a refresh the upstream model starts cold; hand it the story so far. */
  async function conversationContext(): Promise<string | null> {
    const events = await repo.listEvents(sessionId, 2000);
    const lines: string[] = [];
    for (const e of events) {
      const p = e.payload as { text?: string };
      if (e.type === 'tutor_said' && p.text) lines.push(`Tutor: ${p.text}`);
      if (e.type === 'learner_said' && p.text) lines.push(`Learner: ${p.text}`);
    }
    if (lines.length === 0) return null;
    return [
      'This lesson was interrupted by a page reload and is now resuming.',
      'What was said so far (oldest first):',
      ...lines.slice(-40),
      'The board still shows what was drawn. Resume naturally from where things left off — do not start over or repeat the greeting.',
    ].join('\n');
  }

  async function handleUpstream(event: UpstreamEvent): Promise<void> {
    switch (event.type) {
      case 'session.updated': {
        if (!upstreamReady) {
          upstreamReady = true;
          await replayBoard();
          sendClient({ type: 'ready' });
        }
        break;
      }

      case 'response.created': {
        // Responses are only created by the deterministic coordinator
        // (requestModelResponse / finishTool), which already owns the floor.
        // A response starting therefore never *changes* floor ownership here.
        // High eagerness is a one-turn barge-in accelerator. Ordinary turns
        // retain medium semantic endpointing so a child can pause and think.
        setEndpointingEagerness('medium');
        const response = event.response as { id?: string } | undefined;
        if (response?.id && clientIdentity) {
          activeResponseId = response.id;
          responseIdentities.set(response.id, { ...clientIdentity });
          responseSegments.set(response.id, new ResponseSegmentAnnotator());
        }
        sendClient({ type: 'response_started', response_id: response?.id }, identityForResponse(response?.id));
        break;
      }

      case 'response.output_audio.delta': {
        const responseId = String(event.response_id ?? '');
        if (!responseId || cancelledResponses.has(responseId) || typeof event.delta !== 'string') break;
        const offsets = responseSegment(responseId).addAudioSamples(pcmSampleCount(event.delta));
        sendClient({
          type: 'audio',
          delta: event.delta,
          response_id: event.response_id,
          item_id: event.item_id,
        }, identityForResponse(responseId), { audioSampleOffsets: offsets });
        break;
      }

      case 'response.output_audio.done': {
        const responseId = String(event.response_id ?? '');
        if (cancelledResponses.has(responseId)) break;
        const total = responseSegment(responseId).totalSamples();
        sendClient({ type: 'audio_done', response_id: responseId }, identityForResponse(responseId), { audioSampleOffsets: { start: 0, end: total } });
        break;
      }

      case 'response.output_audio_transcript.delta': {
        const responseId = String(event.response_id ?? '');
        if (!responseId || cancelledResponses.has(responseId) || typeof event.delta !== 'string') break;
        responseSegment(responseId).addTranscriptDelta(event.delta, typeof event.item_id === 'string' ? event.item_id : undefined);
        break;
      }

      case 'response.output_audio_transcript.done': {
        const text = String(event.transcript ?? '');
        const responseId = String(event.response_id ?? '');
        if (cancelledResponses.has(responseId)) break;
        if (text.trim()) await repo.addEvent(sessionId, 'tutor_said', { text });
        if (typeof event.response_id === 'string') responseTranscript.set(event.response_id, text);
        responseSegment(responseId).setFinalTranscript(text);
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const text = String(event.transcript ?? '').trim();
        if (text) {
          lastLearnerEventId = await repo.addEvent(sessionId, 'learner_said', { text });
          sendClient({ type: 'user_transcript', text });
          try { lessonState = reduceLesson(lessonState, { type: 'LEARNER_RESPONSE_RECEIVED' }); }
          catch { /* unsolicited learner turns are still valid input; the next move re-orients */ }
        }
        break;
      }

      case 'input_audio_buffer.speech_started':
        toolContinues = 0;
        childHoldsFloor = true;
        speechInProgress = true;
        sendClient({ type: 'speech_started' });
        break;

      case 'input_audio_buffer.speech_stopped':
        speechInProgress = false;
        sendClient({ type: 'speech_stopped', draft_open: draftOpen });
        // VAD no longer creates responses (`create_response: false`). A voice
        // turn completes here only when no drawing draft is open; while the
        // learner composes, their words accumulate as context for the one
        // response created by their explicit Done.
        if (!draftOpen) {
          childHoldsFloor = false;
          requestModelResponse('voice', `voice-turn-${++voiceTurnCounter}`);
        }
        break;

      case 'response.function_call_arguments.done': {
        await handleToolCall(
          String(event.name ?? ''),
          String(event.arguments ?? '{}'),
          String(event.call_id ?? ''),
          String(event.response_id ?? ''),
        );
        break;
      }

      case 'response.done': {
        const response = event.response as
          | { id?: string; status?: string; output?: { type: string }[]; usage?: unknown }
          | undefined;
        const status = response?.status ?? 'unknown';
        if (status === 'cancelled' && response?.id) cancelledResponses.add(response.id);
        const responseIdentity = identityForResponse(response?.id);
        if (response?.id && responseIdentity) {
          const context = metricContextFromIdentity(responseIdentity, response.id);
          await recordProviderUsage(repo, sessionId, response.usage, context);
          const outputSamples = responseSegments.get(response.id)?.totalSamples();
          if (outputSamples !== undefined && outputSamples > 0) {
            await recordMetric(repo, sessionId, {
              schemaVersion: TELEMETRY_SCHEMA_VERSION,
              name: 'tutor_audio_output_duration',
              unit: 'ms',
              value: Math.round(outputSamples / OUTPUT_AUDIO_SAMPLES_PER_MS),
            }, context);
          }
          if (pendingVoiceBargeInResponses.has(response.id)) {
            const outcome = status === 'cancelled'
              ? 'provider_cancelled'
              : status === 'completed'
                ? 'provider_completed'
                : 'provider_failed';
            await recordMetric(repo, sessionId, {
              schemaVersion: TELEMETRY_SCHEMA_VERSION,
              name: 'barge_in_cancel_outcome',
              unit: 'count',
              value: 1,
              dimensions: { outcome },
            }, context);
            pendingVoiceBargeInResponses.delete(response.id);
          }
        }
        const hasFunctionCall = response?.output?.some((item) => item.type === 'function_call') ?? false;
        const delivered = response?.id ? (responseTranscript.get(response.id) ?? '') : '';
        // Explicit handoff: a task proposed via propose_teaching_move is
        // delivered once the model finishes speaking it — question mark or
        // imperative alike. The heard-audio cue below shows the task banner
        // exactly when the child has heard the whole response.
        if (status === 'completed' && response?.id && !cancelledResponses.has(response.id) &&
            pendingDeliveredTask && (delivered.trim() || !hasFunctionCall)) {
          const task = pendingDeliveredTask;
          pendingDeliveredTask = null;
          responseSegment(response.id).addSemanticCue({ type: 'learner_task', task, response_id: response.id }, {
            ...(task.semanticGroupId ? { semanticObjectId: task.semanticGroupId } : {}),
          });
          await repo.addEvent(sessionId, 'learner_task', { task });
          try {
            lessonState = reduceLesson(lessonState, {
              type: 'QUESTION_DELIVERED', taskId: task.taskId, text: task.prompt, responseMode: task.responseMode,
            });
          } catch { /* the next deterministic decision will recover */ }
        } else if (status === 'completed' && response?.id && !hasFunctionCall && !cancelledResponses.has(response.id)) {
          if (/[?？]\s*$/.test(delivered.trim())) {
            // A spoken question without a structured move still yields the
            // floor as a voice-mode task.
            const task: DeliveredTask = DeliveredTaskSchema.parse({
              taskId: `question-${response.id}`,
              prompt: delivered.trim().slice(0, 500),
              responseMode: 'voice',
              submitPolicy: 'vad',
            });
            responseSegment(response.id).addSemanticCue({ type: 'learner_task', task, response_id: response.id });
            await repo.addEvent(sessionId, 'learner_task', { task });
            try {
              lessonState = reduceLesson(lessonState, {
                type: 'QUESTION_DELIVERED', taskId: task.taskId, text: task.prompt,
              });
            } catch { /* the next deterministic decision will recover */ }
          } else if (responseHandoff(lessonState, delivered) === 'bounded_continuation' && !childHoldsFloor) {
            // Only a promised-but-undelivered question move continues.
            // Explanations are allowed to end without an injected question.
            lessonState = { ...lessonState, continuationAttempts: lessonState.continuationAttempts + 1 };
            sendUpstream({
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'system',
                content: [{
                  type: 'input_text',
                  text: 'You proposed asking a question but have not asked it yet. Ask that one short, concrete question or small task now, then wait.',
                }],
              },
            });
            lastCreateSource = 'tool';
            sendUpstream({ type: 'response.create' });
          }
        }
        if (response?.id) flushResponseSegment(response.id, status === 'completed');
        sendClient({ type: 'response_done', response_id: response?.id, status }, responseIdentity);
        if (response?.id === activeResponseId) activeResponseId = null;
        if (retryCreateOnDone) {
          // The child asked something while a response was still running;
          // their question must not be dropped.
          retryCreateOnDone = false;
          sendUpstream({ type: 'response.create' });
        }
        break;
      }

      case 'error': {
        const error = event.error as { message?: string; code?: string } | undefined;
        // Expected races, harmless: cancelling a turn that just finished, or
        // continuing after a tool call when VAD already started a response.
        const alreadyActive =
          error?.code === 'conversation_already_has_active_response' ||
          /active response in progress/i.test(error?.message ?? '');
        if (alreadyActive && ['user', 'board', 'voice'].includes(lastCreateSource)) retryCreateOnDone = true;
        const benign = error?.code === 'response_cancel_not_active' || alreadyActive;
        log(`session ${sessionId}: upstream error ${JSON.stringify(event.error).slice(0, 300)}`);
        if (!benign) {
          sendClient({ type: 'error', message: 'Noura hit a snag — it will recover in a moment.' });
        }
        break;
      }

      default:
        break;
    }
  }

  async function handleToolCall(name: string, rawArgs: string, callId: string, responseId: string): Promise<void> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      finishTool(callId, responseId, { ok: false, error: 'arguments were not valid JSON' });
      return;
    }

    switch (name) {
      case 'create_lesson_blueprint': {
        if (lessonState.blueprint) {
          const stage = currentStage(lessonState);
          finishTool(callId, responseId, {
            ok: false,
            error: 'A lesson blueprint already exists; execute its current stage instead of regenerating it.',
            blueprintId: lessonState.blueprint.blueprintId,
            ...(stage ? { currentStage: { id: stage.id, kind: stage.kind, objective: stage.objective } } : {}),
          });
          break;
        }
        const mode = args.mode === 'conversation_led' ? 'conversation_led' : 'board_led';
        const candidate = {
          blueprintId: `blueprint-${globalThis.crypto.randomUUID()}`,
          goal: (typeof args.goal === 'string' && args.goal.trim() ? args.goal.trim() : lessonGoal).slice(0, 300),
          mode,
          successCriteria: Array.isArray(args.successCriteria)
            ? args.successCriteria.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.slice(0, 240)).slice(0, 4)
            : [],
          anchor: mode === 'board_led'
            ? {
                // The server assigns the anchor section id; the model never
                // invents a new group per micro-objective.
                semanticGroupId: 'lesson-anchor',
                template: String(args.anchorTemplate ?? 'relationship_map').slice(0, 80),
                instructionalQuestion: String(args.anchorQuestion ?? lessonGoal).slice(0, 300),
                invariantObjectIds: [],
              }
            : null,
          stages: args.stages,
          currentStageIndex: 0,
          detourStack: [],
        };
        const parsedBlueprint = LessonBlueprintSchema.safeParse(candidate);
        if (!parsedBlueprint.success) {
          finishTool(callId, responseId, {
            ok: false,
            error: `Blueprint failed validation: ${parsedBlueprint.error.issues.slice(0, 3).map((issue) => issue.message).join('; ')}`.slice(0, 300),
          });
          break;
        }
        try {
          lessonState = reduceLesson(lessonState, { type: 'BLUEPRINT_CREATED', blueprint: parsedBlueprint.data });
          await repo.addEvent(sessionId, 'lesson_blueprint', { blueprint: parsedBlueprint.data });
          const stage = currentStage(lessonState);
          finishTool(callId, responseId, {
            ok: true,
            blueprintId: parsedBlueprint.data.blueprintId,
            mode: parsedBlueprint.data.mode,
            ...(parsedBlueprint.data.anchor ? { anchorGroupId: parsedBlueprint.data.anchor.semanticGroupId } : {}),
            stages: parsedBlueprint.data.stages.map((entry) => ({ id: entry.id, kind: entry.kind })),
            ...(stage ? { currentStage: { id: stage.id, kind: stage.kind, objective: stage.objective, boardPurpose: stage.boardPurpose } } : {}),
            board: boardContext.toolSnapshot(),
          });
        } catch (error) {
          finishTool(callId, responseId, { ok: false, error: String(error).slice(0, 220) });
        }
        break;
      }

      case 'inspect_board': {
        const focus = typeof args.focus === 'string' ? args.focus.slice(0, 160) : undefined;
        finishTool(callId, responseId, {
          ok: true,
          focus,
          board: boardContext.toolSnapshot(focus),
        });
        break;
      }

      case 'semantic_visual_plan': {
        try {
          const requestedAction = (args as { intent?: { action?: unknown } }).intent?.action;
          const normalizedAction = normalizeVisualAction(VisualActionSchema.catch('establish').parse(requestedAction ?? 'establish'));
          // Object permanence: visible tutor work never disappears. Replace
          // is not a live action in any form.
          if (normalizedAction === 'replace') {
            finishTool(callId, responseId, {
              ok: false,
              accepted: false,
              reason: 'Visible board work never disappears. Replacement is not available: extend or emphasize the anchor, or add an announced comparison beside it.',
              board: boardContext.toolSnapshot(),
            });
            break;
          }
          if (normalizedAction === 'none') {
            finishTool(callId, responseId, {
              ok: true,
              accepted: true,
              action: 'none',
              noBoard: true,
              board: boardContext.toolSnapshot(),
            });
            break;
          }
          // One visual plan per logical tutor turn. The budget resets only
          // when a genuine learner turn begins the next teaching turn; a
          // failed attempt may retry exactly once with a simpler plan.
          const planActiveThisTurn = planStagedThisTurn && visualPlanState !== 'failed';
          if ((planActiveThisTurn || planAttemptsThisTurn >= 2) && ['establish', 'compare'].includes(normalizedAction)) {
            finishTool(callId, responseId, {
              ok: false,
              accepted: false,
              reason: 'One visual plan per teaching turn. Teach with what is on the board now, then wait for the learner.',
              visualPlanState,
              anchorGroupId: anchorGroupId(),
              board: boardContext.toolSnapshot(),
            });
            break;
          }
          const blueprint = lessonState.blueprint;
          if (!blueprint && ['establish', 'compare'].includes(normalizedAction)) {
            finishTool(callId, responseId, {
              ok: false,
              accepted: false,
              reason: 'Create the lesson blueprint first; board changes execute blueprint stages.',
              board: boardContext.toolSnapshot(),
            });
            break;
          }
          if (normalizedAction === 'extend') {
            // Extensions are small, incremental, and belong in board_ops so
            // they attach to existing visible objects rather than a template.
            finishTool(callId, responseId, {
              ok: true,
              accepted: false,
              action: 'extend',
              reason: 'Extend the anchor with small board_ops increments that reference visible IDs; no new section is created.',
              anchorGroupId: anchorGroupId(),
              board: boardContext.toolSnapshot(),
            });
            break;
          }
          if (normalizedAction === 'emphasize') {
            const requestedIds = (args as { intent?: { targetObjectIds?: unknown } }).intent?.targetObjectIds;
            const targets = Array.isArray(requestedIds)
              ? requestedIds.filter((id): id is string => typeof id === 'string' && boardContext.hasObject(id)).slice(0, 12)
              : [];
            if (targets.length === 0) {
              finishTool(callId, responseId, {
                ok: false,
                accepted: false,
                reason: 'Emphasize needs visible target object ids. Inspect the board and name the objects to highlight.',
                board: boardContext.toolSnapshot(),
              });
              break;
            }
            const group = boardContext.groupOfObject(targets[0]) ?? anchorGroupId() ?? undefined;
            stageAndConfirmPlan(callId, responseId, {
              ops: targets.map((id) => ({ op: 'highlight', id } as BoardOp)),
              checkpoints: [{
                id: `emphasize-${responseId}-${targets.join('-')}`.slice(0, 120),
                semanticObjectId: group ?? 'board',
                groupLabel: boardContext.groupLabelOf(group) ?? 'Board',
                reveal: 'emphasis',
                ops: targets.map((id) => ({ op: 'highlight', id } as BoardOp)),
              }],
              action: 'emphasize',
              skipPreflight: true,
            });
            break;
          }
          // establish | compare: the server, not the model, assigns the
          // section. The anchor is established once; comparisons are added
          // beside it in an announced side section that never auto-switches
          // the learner's view.
          const anchor = anchorGroupId() ?? 'lesson-anchor';
          let assignedGroupId = anchor;
          if (normalizedAction === 'establish') {
            if (boardContext.hasGroup(anchor)) {
              finishTool(callId, responseId, {
                ok: false,
                accepted: false,
                reason: `The anchor section ${anchor} is already on the board. Extend or emphasize it; do not rebuild it.`,
                anchorGroupId: anchor,
                board: boardContext.toolSnapshot(),
              });
              break;
            }
          } else {
            assignedGroupId = `${anchor}-alt${++comparisonSectionCounter}`;
          }
          const planInput = assignSectionToPlan(args, assignedGroupId);
          const { plan, ops, checkpoints } = adaptSemanticScene(planInput);
          const densityLimit = plan.intent.density === 'minimal' ? 14 : 30;
          if (ops.length > densityLimit) {
            finishTool(callId, responseId, {
              ok: false,
              accepted: false,
              reason: `The ${plan.intent.density} visual exceeds its ${densityLimit}-object density budget. Simplify or split the teaching move.`,
              questionAnswered: plan.intent.questionAnswered,
              board: boardContext.toolSnapshot(),
            });
            break;
          }
          const equivalent = boardContext.equivalentTutorScene(ops);
          if (equivalent.equivalent) {
            finishTool(callId, responseId, {
              ok: true,
              accepted: false,
              reason: 'An equivalent visual is already visible. Reuse its IDs and adapt it in place.',
              equivalentObjects: equivalent.duplicates,
              board: boardContext.toolSnapshot(),
            });
            break;
          }
          stageAndConfirmPlan(callId, responseId, {
            ops,
            checkpoints,
            action: normalizedAction,
            plan,
            ...(normalizedAction === 'compare' ? { announcement: `A comparison was added beside the anchor as section ${assignedGroupId}. Tell the learner it is there; their view does not switch automatically.` } : {}),
          });
        } catch (error) {
          finishTool(callId, responseId, {
            ok: false,
            accepted: false,
            error: String(error).slice(0, 260),
          });
        }
        break;
      }

      case 'propose_teaching_move': {
        const parsed = TeachingMoveSchema.safeParse(args);
        if (!parsed.success) {
          finishTool(callId, responseId, { ok: false, error: 'teaching move failed schema validation' });
          break;
        }
        // Board-led diagnostic questions must be answerable by inspecting or
        // manipulating named visible objects — never by speech alone.
        const stageBefore = currentStage(lessonState);
        if (lessonState.blueprint?.mode === 'board_led' && stageBefore &&
            ['guided_check', 'independent_check'].includes(stageBefore.kind) && parsed.data.questionOrTask) {
          const visibleTargets = (parsed.data.targetObjectIds ?? []).filter((id) => boardContext.hasObject(id));
          if (visibleTargets.length === 0) {
            finishTool(callId, responseId, {
              ok: false,
              error: `A ${stageBefore.kind} question in a board-led lesson must name visible board objects it asks about (targetObjectIds). Inspect the board and reference real ids.`,
              board: boardContext.toolSnapshot(),
            });
            break;
          }
        }
        try {
          lessonState = reduceLesson(lessonState, { type: 'MOVE_PROPOSED', move: parsed.data });
          const task = taskFromMove(parsed.data, responseId);
          if (task) pendingDeliveredTask = task;
          const state = {
            activeConcept: lessonState.microObjective,
            strategy: lessonState.strategy,
            nextStep: lessonState.owedAction,
            phase: lessonState.phase,
            activeSemanticObjectId: lessonState.activeSemanticObjectId,
            characterAttentionTarget: lessonState.characterAttentionTarget,
          };
          await repo.addEvent(sessionId, 'lesson_state', state);
          responseSegment(responseId).addSemanticCue({ type: 'lesson_state', state }, {
            ...(lessonState.activeSemanticObjectId ? { semanticObjectId: lessonState.activeSemanticObjectId } : {}),
          });
          const stage = currentStage(lessonState);
          finishTool(callId, responseId, {
            ok: true,
            legalPhase: lessonState.phase,
            owedAction: lessonState.owedAction,
            ...(lessonState.blueprint ? {
              blueprintId: lessonState.blueprint.blueprintId,
              anchorGroupId: lessonState.blueprint.anchor?.semanticGroupId ?? null,
              detourDepth: lessonState.blueprint.detourStack.length,
            } : {}),
            ...(stage ? { currentStage: { id: stage.id, kind: stage.kind, objective: stage.objective, boardPurpose: stage.boardPurpose, allowedBoardMutation: stage.allowedBoardMutation } } : {}),
            board: boardContext.toolSnapshot(),
          });
        } catch (error) {
          finishTool(callId, responseId, { ok: false, error: String(error).slice(0, 220) });
        }
        break;
      }

      case 'board_ops': {
        const validated = validateOps(args.ops);
        // Raw destructive clears are not available to the model: visible
        // tutor work never disappears during the ordinary lesson flow.
        const clears = validated.ops.filter((op) => op.op === 'clear');
        if (clears.length > 0) {
          validated.ops = validated.ops.filter((op) => op.op !== 'clear');
          validated.rejected.push({ reason: 'clear is not available; visible work persists — extend or emphasize instead', raw: { op: 'clear' } });
        }
        // Objects created in this logical turn cannot be erased in the same
        // turn; the learner must get to see what was just taught.
        const sameTurnErases = validated.ops.filter((op) => op.op === 'erase' && objectsCreatedThisTurn.has(op.id));
        if (sameTurnErases.length > 0) {
          validated.ops = validated.ops.filter((op) => !(op.op === 'erase' && objectsCreatedThisTurn.has(op.id)));
          validated.rejected.push({ reason: `erase rejected for objects created this turn (${sameTurnErases.map((op) => op.op === 'erase' ? op.id : '').join(', ')}); visible work persists through the next learner opportunity`, raw: { op: 'erase' } });
        }
        // Raw increments join the active section or the lesson anchor; they
        // never open a fresh freeform section once an anchor exists.
        const semanticGroupId = lessonState.activeSemanticObjectId ?? anchorGroupId() ?? `freeform-${identityForResponse(responseId)?.turnId ?? 'board'}`;
        const novel = boardContext.novelTutorOps(validated.ops, semanticGroupId);
        const { ops } = novel;
        if (ops.length > 0) {
          for (const op of ops) if (op.op === 'add') objectsCreatedThisTurn.add(op.id);
          const eventId = await repo.addEvent(sessionId, 'board_ops', {
            ops,
            semanticObjectId: semanticGroupId,
            groupLabel: lessonState.microObjective || 'Working board',
          }, false);
          pendingBoardOps.set(eventId, { ops, semanticGroupId, groupLabel: lessonState.microObjective || 'Working board' });
          responseSegment(responseId).addSemanticCue({
            type: 'board_ops',
            ops,
            response_id: responseId,
            event_id: eventId,
            groupLabel: lessonState.microObjective || 'Working board',
          }, { semanticObjectId: semanticGroupId });
        }
        finishTool(callId, responseId, {
          ok: validated.rejected.length === 0,
          applied: ops.length,
          ...(validated.rejected.length > 0
            ? { rejected: validated.rejected.map((r) => r.reason).slice(0, 5) }
            : {}),
          ...(novel.duplicates.length > 0 ? { skippedEquivalentRedraws: novel.duplicates } : {}),
          board: boardContext.toolSnapshot(),
        });
        break;
      }

      case 'record_evidence': {
        const verdicts: Verdict[] = ['progressing', 'struggling', 'misconception'];
        const confidences: Confidence[] = ['low', 'medium', 'high'];
        const classification = ResponseTaxonomySchema.safeParse(args.classification).success
          ? (args.classification as ResponseTaxonomy)
          : taxonomyFromLegacyVerdict(args.verdict);
        const projectedVerdict: Verdict = classification === 'confident_misconception'
          ? 'misconception'
          : ['incorrect', 'confusion', 'missing_prerequisite', 'no_meaningful_response'].includes(classification)
            ? 'struggling'
            : 'progressing';
        const entry = {
          concept: String(args.concept ?? '').slice(0, 120),
          observation: String(args.observation ?? '').slice(0, 500),
          verdict: verdicts.includes(projectedVerdict) ? projectedVerdict : 'progressing',
          confidence: confidences.includes(args.confidence as Confidence)
            ? (args.confidence as Confidence)
            : 'low',
          excerpt: args.excerpt ? String(args.excerpt).slice(0, 300) : undefined,
          classification,
          confidenceBasis: String(args.confidence_basis ?? 'Model classification grounded in the latest learner response.').slice(0, 400),
          sourceEventIds: lastLearnerEventId === null ? [] : [lastLearnerEventId],
          taskId: String(args.task_id ?? lessonState.deliveredQuestionTaskId ?? 'unspecified-opportunity').slice(0, 160),
          independenceLevel: classification === 'self_corrected' ? 'reduced' as const : 'independent' as const,
          turnId: identityForResponse(responseId)?.turnId,
          generationId: identityForResponse(responseId)?.generationId,
          opportunityKind: ['recall', 'explanation', 'application', 'retrieval'].includes(String(args.opportunity_kind))
            ? args.opportunity_kind as 'recall' | 'explanation' | 'application' | 'retrieval'
            : 'recall' as const,
          retrievalOf: typeof args.retrieval_of === 'string' ? args.retrieval_of.slice(0, 160) : undefined,
          contradicts: Array.isArray(args.contradicts) ? args.contradicts.filter((value): value is string => typeof value === 'string').map((value) => value.slice(0, 160)).slice(0, 8) : [],
          supersedes: Array.isArray(args.supersedes) ? args.supersedes.filter((value): value is string => typeof value === 'string').map((value) => value.slice(0, 160)).slice(0, 8) : [],
        };
        if (entry.concept && entry.observation && entry.sourceEventIds.length > 0) {
          try {
            const stored = await repo.addEvidence(sessionId, entry);
            await repo.addEvent(sessionId, 'evidence', { evidenceId: stored.evidenceId, concept: stored.concept, verdict: stored.verdict });
            sendClient({ type: 'evidence', entry: stored }, identityForResponse(responseId));
            const progressBefore = lessonState.blueprint ? `${lessonState.blueprint.currentStageIndex}:${lessonState.blueprint.detourStack.length}` : null;
            lessonState = reduceLesson(lessonState, { type: 'ASSESSED', classification, evidenceId: stored.evidenceId });
            const blueprint = lessonState.blueprint;
            if (blueprint && progressBefore !== `${blueprint.currentStageIndex}:${blueprint.detourStack.length}`) {
              // Stage progress and detours are durable: a refresh resumes the
              // lesson at the same point of the same blueprint.
              await repo.addEvent(sessionId, 'blueprint_progress', {
                blueprintId: blueprint.blueprintId,
                currentStageIndex: blueprint.currentStageIndex,
                detourStack: blueprint.detourStack,
              });
            }
            const stage = currentStage(lessonState);
            finishTool(callId, responseId, {
              ok: true,
              evidenceId: stored.evidenceId,
              ...(stage ? { currentStage: { id: stage.id, kind: stage.kind, objective: stage.objective } } : {}),
              ...(lessonState.blueprint ? { detourDepth: lessonState.blueprint.detourStack.length } : {}),
            });
          } catch (error) {
            finishTool(callId, responseId, { ok: false, error: String(error).slice(0, 220) });
          }
        } else {
          finishTool(callId, responseId, { ok: false, error: 'concept, observation, and a source learner event are required' });
        }
        break;
      }

      case 'update_lesson_state': {
        const state = {
          activeConcept: String(args.active_concept ?? '').slice(0, 160),
          strategy: args.strategy ? String(args.strategy).slice(0, 160) : undefined,
          nextStep: args.next_step ? String(args.next_step).slice(0, 240) : undefined,
        };
        await repo.addEvent(sessionId, 'lesson_state', state);
        responseSegment(responseId).addSemanticCue({ type: 'lesson_state', state });
        finishTool(callId, responseId, { ok: true });
        break;
      }

      default:
        finishTool(callId, responseId, { ok: false, error: `unknown tool ${name}` });
    }
  }

  /**
   * Reports a tool result and lets the model keep talking — unless the
   * child has already interrupted this response, in which case the child
   * holds the floor and the model must wait for them.
   */
  function finishTool(callId: string, responseId: string, output: unknown): void {
    sendUpstream({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
    });
    if (cancelledResponses.has(responseId) || childHoldsFloor) return;
    if (toolContinues >= MAX_TOOL_CONTINUES) return;
    toolContinues += 1;
    lastCreateSource = 'tool';
    sendUpstream({ type: 'response.create' });
  }

  client.on('message', (raw) => {
    clientWork = clientWork.then(async () => {
      let decoded: unknown;
      try { decoded = JSON.parse(String(raw)); }
      catch { return; }
      const parsed = RuntimeEventEnvelopeSchema.safeParse(decoded);
      if (!parsed.success) return;
      const envelope = parsed.data;
      if (envelope.sessionId !== sessionId || seenClientEvents.has(envelope.eventId)) return;
      if (clientIdentity && envelope.connectionEpoch < clientIdentity.connectionEpoch) return;
      const identityChanged = !clientIdentity ||
        envelope.connectionEpoch !== clientIdentity.connectionEpoch ||
        envelope.turnId !== clientIdentity.turnId ||
        envelope.generationId !== clientIdentity.generationId;
      if (identityChanged) {
        clientIdentity = {
          sessionId: envelope.sessionId,
          connectionEpoch: envelope.connectionEpoch,
          turnId: envelope.turnId,
          generationId: envelope.generationId,
        };
        clientSequence = 0;
        lastClientSequence = -1;
        flushPendingClientPayloads();
      }
      if (envelope.sequence <= lastClientSequence) return;
      lastClientSequence = envelope.sequence;
      seenClientEvents.add(envelope.eventId);
      if (seenClientEvents.size > 1000) seenClientEvents.delete(seenClientEvents.values().next().value as string);
      await handleClient(
        { type: envelope.type, ...(envelope.payload as Record<string, unknown>) },
        envelope,
      );
    }).catch((error) => {
      log(`session ${sessionId}: client processing error ${String(error).slice(0, 240)}`);
      sendClient({ type: 'error', message: 'Noura could not save that turn. Please try again.' });
    });
  });

  client.on('close', () => teardown('client closed'));
  client.on('error', () => teardown('client error'));

  async function handleClient(
    message: ClientMessage,
    envelope: RuntimeEventEnvelope,
  ): Promise<void> {
    switch (message.type) {
      case 'input_audio': {
        if (typeof message.audio === 'string' && message.audio.length < 400_000) {
          sendUpstream({ type: 'input_audio_buffer.append', audio: message.audio });
        }
        break;
      }

      case 'start': {
        if (started) break;
        started = true;
        toolContinues = 0;
        const hadPriorStart = await hasReleasedSessionStart(repo, sessionId);
        const resume = await conversationContext();
        if (resume) {
          sendUpstream({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: resume }],
            },
          });
        }
        await repo.addEvent(sessionId, 'session_started', {
          resumed: Boolean(resume),
          connectionEpoch: envelope.connectionEpoch,
        });
        if (hadPriorStart) {
          await recordMetric(repo, sessionId, {
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            name: 'session_reconnect',
            unit: 'count',
            value: 1,
          }, metricContextFromIdentity(envelope));
        }
        requestModelResponse('start', 'session-start');
        break;
      }

      case 'user_text': {
        const text = String(message.text ?? '').trim().slice(0, 2000);
        if (!text) break;
        const idempotencyKey = String(message.idempotencyKey ?? '').slice(0, 200);
        if (idempotencyKey.length < 8 || seenIdempotencyKeys.has(idempotencyKey)) break;
        seenIdempotencyKeys.add(idempotencyKey);
        if (seenIdempotencyKeys.size > 500) seenIdempotencyKeys.delete(seenIdempotencyKeys.values().next().value as string);
        toolContinues = 0;
        childHoldsFloor = false;
        lastLearnerEventId = await repo.addEvent(sessionId, 'learner_said', { text, via: 'text' });
        sendClient({ type: 'user_transcript', text });
        try { lessonState = reduceLesson(lessonState, { type: 'LEARNER_RESPONSE_RECEIVED' }); }
        catch { /* unsolicited typed turns are still valid input */ }
        sendUpstream({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
        });
        requestModelResponse('user', `user-text-${idempotencyKey}`);
        break;
      }

      case 'interrupt': {
        // The client already stopped local audio; make the model stop too,
        // and keep tool chains from restarting it while the child speaks.
        const interruptedResponseId = activeResponseId;
        const interruptedIdentity = interruptedResponseId
          ? identityForResponse(interruptedResponseId)
          : null;
        const recordVoiceGate = message.reason === 'voice' &&
          interruptedResponseId !== null &&
          interruptedIdentity !== null &&
          !pendingVoiceBargeInResponses.has(interruptedResponseId);
        if (recordVoiceGate) pendingVoiceBargeInResponses.add(interruptedResponseId);
        childHoldsFloor = true;
        if (activeResponseId) cancelledResponses.add(activeResponseId);
        lessonState = reduceLesson(lessonState, { type: 'INTERRUPTED' });
        if (message.reason === 'voice') setEndpointingEagerness('high');
        sendUpstream({ type: 'response.cancel' });
        if (recordVoiceGate) {
          await recordMetric(repo, sessionId, {
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            name: 'barge_in_gate_outcome',
            unit: 'count',
            value: 1,
            dimensions: { outcome: 'confirmed' },
          }, metricContextFromIdentity(interruptedIdentity, interruptedResponseId));
        }
        break;
      }

      case 'truncate': {
        if (typeof message.item_id === 'string' && typeof message.audio_end_ms === 'number') {
          sendUpstream({
            type: 'conversation.item.truncate',
            item_id: message.item_id,
            content_index: 0,
            audio_end_ms: Math.max(0, Math.floor(message.audio_end_ms)),
          });
          await repo.addEvent(sessionId, 'interrupted', { audio_end_ms: message.audio_end_ms });
        }
        break;
      }

      case 'draft_state': {
        // The learner opened or closed a drawing draft. While a draft is
        // open nothing may auto-create a response; pauses between strokes
        // belong to the learner.
        const draftId = String(message.draftId ?? '').slice(0, 160);
        const open = message.open === true;
        if (!draftId) break;
        if (draftOpen !== open) {
          draftOpen = open;
          await repo.addEvent(sessionId, 'learner_draft', { draftId, open });
        }
        break;
      }

      case 'board_submission': {
        // The learner pressed Done (or explicitly finished): one frozen,
        // idempotent submission, one persisted learner event, one response.
        const parsedSubmission = BoardSubmissionSchema.safeParse(message);
        if (!parsedSubmission.success) {
          sendClient({ type: 'board_submission_error', submissionId: String(message.submissionId ?? ''), reason: 'The submission was malformed. Your drawing is still on the board — press Done to try again.' });
          break;
        }
        const submission = parsedSubmission.data;
        if (respondedSubmissionIds.has(submission.submissionId)) {
          sendClient({ type: 'board_submission_ack', submissionId: submission.submissionId, duplicate: true });
          break;
        }
        const description = submission.description.trim().slice(0, 4000);
        const ops = learnerBoardOps(submission.ops);
        const imageDataUrl = safeBoardImage(submission.imageDataUrl);
        const analysis = submission.analysis ?? null;
        if (!description && ops.length === 0) {
          sendClient({ type: 'board_submission_ack', submissionId: submission.submissionId, empty: true });
          break;
        }
        respondedSubmissionIds.add(submission.submissionId);
        draftOpen = false;
        const eventId = await repo.addEvent(sessionId, 'learner_board', {
          description,
          ops,
          submissionId: submission.submissionId,
          draftId: submission.draftId,
          hasVisualContext: Boolean(imageDataUrl),
          baseBoardRevision: submission.baseBoardRevision,
          submittedBoardRevision: submission.submittedBoardRevision,
          ...(submission.taskId ? { taskId: submission.taskId } : {}),
          ...(submission.semanticGroupId ? { semanticObjectId: submission.semanticGroupId } : {}),
          ...(submission.semanticGroupLabel ? { groupLabel: submission.semanticGroupLabel } : {}),
          ...(analysis ? { analysis } : {}),
        });
        // Evidence recorded for this answer cites the board event itself.
        lastLearnerEventId = eventId;
        boardContext.apply(ops, 'learner', submission.semanticGroupId, submission.semanticGroupLabel);
        if (analysis) boardContext.observeLearnerAnalysis(analysis);
        refreshBoardInstructions();
        try { lessonState = reduceLesson(lessonState, { type: 'LEARNER_RESPONSE_RECEIVED' }); }
        catch { /* a spontaneous drawing outside a task is still valid input */ }
        const content: Array<Record<string, unknown>> = [{
          type: 'input_text',
          text: [
            '[The learner finished a drawing on the shared board and pressed Done. This is their complete submitted answer, not a partial stroke.]',
            submission.taskId ? `It answers task ${submission.taskId}.` : '',
            description,
            analysis ? `Deterministic vector analysis (spatial hints, not meaning): ${analysis.summary}` : '',
            imageDataUrl
              ? 'Use the attached full-board/detail image to interpret the drawing. If its meaning is ambiguous, ask the learner rather than guessing.'
              : 'No image is attached; rely on the vector analysis and board state. If the meaning is ambiguous, ask the learner rather than guessing.',
          ].filter(Boolean).join(' '),
        }];
        if (imageDataUrl) content.push({ type: 'input_image', image_url: imageDataUrl, detail: 'high' });
        sendUpstream({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content,
          },
        });
        sendClient({ type: 'board_submission_ack', submissionId: submission.submissionId });
        // Mixed voice+drawing: if the learner is mid-utterance, speech stop
        // completes the turn with this drawing already in context — still
        // exactly one response.
        if (!speechInProgress) requestModelResponse('board', submission.submissionId);
        break;
      }

      case 'visual_preflight_result': {
        const preflightId = String(message.preflight_id ?? '');
        const resolver = pendingPreflights.get(preflightId);
        if (resolver) resolver({
          accepted: message.accepted === true,
          reasons: Array.isArray(message.reasons) ? message.reasons.filter((reason): reason is string => typeof reason === 'string').map((reason) => reason.slice(0, 200)).slice(0, 8) : [],
        });
        break;
      }

      case 'ops_shown': {
        // The child has actually seen this batch; it is now part of the board.
        if (typeof message.event_id === 'number') {
          await repo.markEventReleased(sessionId, message.event_id);
          const pending = pendingBoardOps.get(message.event_id);
          if (pending) {
            if (pending.replacesGroup) boardContext.applyReplacement(pending.ops, pending.replacesGroup, pending.groupLabel);
            else boardContext.apply(pending.ops, 'tutor', pending.semanticGroupId, pending.groupLabel);
            pendingBoardOps.delete(message.event_id);
          } else {
            // Covers acknowledgement after an unusual connection handoff.
            boardContext = await loadReleasedBoardContext(repo, sessionId);
          }
          refreshBoardInstructions();
          // The visibility barrier: a staged plan's tool result waits here.
          pendingVisibility.get(message.event_id)?.(true);
        }
        break;
      }

      case 'ops_rejected': {
        const eventId = typeof message.event_id === 'number' ? message.event_id : null;
        if (eventId !== null) {
          pendingBoardOps.delete(eventId);
          pendingVisibility.get(eventId)?.(false);
        }
        const reason = String(message.reason ?? 'The board checkpoint failed client layout validation.').slice(0, 300);
        await repo.addEvent(sessionId, 'board_rejected', { eventId, reason });
        boardContext.observeBoardRejection(reason);
        refreshBoardInstructions();
        sendUpstream({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'system',
            content: [{
              type: 'input_text',
              text: `[Board checkpoint rejected by deterministic layout validation.] ${reason} Inspect the visible board, simplify the visual, and reuse existing objects. Do not refer to the rejected marks as visible.`,
            }],
          },
        });
        break;
      }

      case 'metric': {
        const metric = MetricInputSchema.safeParse(envelope.payload);
        if (!metric.success || !isAllowedClientMetric(metric.data)) break;
        await recordMetric(
          repo,
          sessionId,
          metric.data,
          metricContextFromIdentity(envelope, trustedClientResponseId(envelope)),
        );
        break;
      }

      default:
        break;
    }
  }
}

function taxonomyFromLegacyVerdict(value: unknown): ResponseTaxonomy {
  if (value === 'misconception') return 'confident_misconception';
  if (value === 'struggling') return 'incorrect';
  return 'uncertain_or_ambiguous';
}

function pcmSampleCount(base64: string): number {
  try { return Math.floor(Buffer.from(base64, 'base64').byteLength / 2); }
  catch { return 0; }
}

function learnerBoardOps(raw: unknown): BoardOp[] {
  if (!Array.isArray(raw)) return [];
  const ops: BoardOp[] = [];
  for (const entry of raw.slice(0, 40)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as { op?: unknown; id?: unknown; color?: unknown; spec?: unknown };
    const id = typeof candidate.id === 'string' && /^sketch-[\w-]{1,80}$/.test(candidate.id)
      ? candidate.id
      : null;
    if (!id) continue;
    if (candidate.op === 'erase') {
      ops.push({ op: 'erase', id });
      continue;
    }
    if (candidate.op !== 'add' || typeof candidate.spec !== 'object' || candidate.spec === null) continue;
    const spec = validateSpec(candidate.spec as never);
    if (spec?.kind !== 'path') continue;
    const color = normalizeColor(candidate.color);
    ops.push({ op: 'add', id, spec, ...(color ? { color } : {}) });
  }
  return ops;
}

function safeBoardImage(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 320_000) return null;
  return /^data:image\/(?:png|jpeg);base64,[a-z0-9+/=]+$/i.test(value) ? value : null;
}

function semanticTurnDetection(eagerness: 'medium' | 'high') {
  return {
    type: 'semantic_vad',
    eagerness,
    // The server-side coordinator is the only owner of response.create.
    // VAD still chunks and transcribes speech, but a drawing draft, a mixed
    // voice+drawing answer, and an explicit Done all decide response timing
    // deterministically rather than the provider.
    create_response: false,
    // Client-side sustained-speech confirmation owns cancellation; provider
    // VAD alone must not stop Noura on incidental noise.
    interrupt_response: false,
  } as const;
}

/** Builds the explicit learner-task contract from a structured teaching move. */
function taskFromMove(move: TeachingMove, responseId: string): DeliveredTask | null {
  if (!move.questionOrTask?.trim()) return null;
  const responseMode = move.responseMode ?? 'voice';
  const parsed = DeliveredTaskSchema.safeParse({
    taskId: (move.taskId?.trim() || `task-${responseId}`).slice(0, 160),
    prompt: move.questionOrTask.trim().slice(0, 500),
    responseMode,
    submitPolicy: submitPolicyForMode(responseMode),
    ...(move.semanticObjectId ? { semanticGroupId: move.semanticObjectId } : {}),
  });
  return parsed.success ? parsed.data : null;
}


