import { WebSocket as NodeWebSocket, type WebSocket as ClientSocket } from 'ws';
import {
  createRuntimeEvent,
  RuntimeEventEnvelopeSchema,
  type RuntimeEventEnvelope,
} from '../../shared/runtimeProtocol.js';
import { buildInstructions } from './instructions.js';
import { createLessonState, reduceLesson } from '../lesson/orchestrator.js';
import type { LessonStage } from '../../shared/pedagogy.js';
import { DETOUR_PLAN_TIMEOUT_MS } from './detourPlanning.js';
import { BoardContextTracker, loadReleasedBoardContext } from './boardContext.js';
import type { DomainRepository } from '../store/domain.js';
import { SessionTelemetryWriter } from '../session/telemetryWriter.js';
import {
  YieldingTelemetryRepository,
  type SessionTelemetryRepository,
} from '../session/telemetryRepository.js';
import type { BoardDirector } from '../board/director.js';
import type { StreamingBoardDirector } from '../board/streamingDirector.js';
import type { ClientCueOptional, CoordinatorContext, CoordinatorState } from './coordinatorContext.js';
import type { GenerationIdentity } from '../../shared/runtimeProtocol.js';
import { latestVoiceCallId, type SidebandRegistry } from './callBootstrap.js';
import { handleClientEvent } from './clientEvents.js';
import { abandonStoryboardRun, noteStoryboardClientIdentityChanged } from './storyboardRunner.js';
import { handleUpstreamEvent, type UpstreamEvent } from './upstreamEvents.js';
import { initialSessionUpdate, realtimeCallUrl, REALTIME_URL } from './sessionConfig.js';

/**
 * Bridges one browser lesson to one OpenAI Realtime session.
 *
 * The browser never sees the API key; the server sees every event, so the
 * child experience and the parent dashboard are fed by the same stream.
 * Tool calls are executed here: board operations are validated before a
 * single mark reaches the board, and evidence is persisted as it happens.
 *
 * The coordination logic lives in focused modules that share one
 * `CoordinatorContext`: turn/floor ownership (`turnFloor.ts`), tool handling
 * (`toolHandling.ts`), board plan staging (`boardStaging.ts`), session
 * bootstrap/restore (`sessionConfig.ts`, `sessionRestore.ts`), telemetry glue
 * (`telemetryGlue.ts`), and the two event dispatchers (`upstreamEvents.ts`,
 * `clientEvents.ts`). This module owns the transport sockets, ordered work
 * queues, and lifecycle/teardown.
 */

export interface ProxyOptions {
  apiKey: string;
  model: string;
  repo: DomainRepository;
  telemetryRepo?: SessionTelemetryRepository;
  sessionId: string;
  log?: (line: string) => void;
  createUpstream?: (url: string, apiKey: string) => NodeWebSocket;
  /** Adopts the sideband a call bootstrap opened moments earlier. */
  sidebandRegistry?: SidebandRegistry;
  /** How long to wait for the browser to compile-check a full visual plan. */
  preflightTimeoutMs?: number;
  /** How long to wait for the browser to confirm a staged plan is visible. */
  visibilityTimeoutMs?: number;
  /** Compiler entry point for bounded mid-lesson detour mini-plans. */
  planDetour?: (input: { objective: string; reason: string; returnStageObjective: string }) => Promise<LessonStage[]>;
  /** How long detour planning may run before the simple detour stands. */
  detourPlanTimeoutMs?: number;
  /** Board Director for slow-tier scene requests; absent means new-scene
   * requests fail closed with a clean rejection. */
  directVisual?: BoardDirector;
  /** Streaming Director pipeline; absent keeps the classic rollback path. */
  streamVisual?: StreamingBoardDirector;
  /** How long one storyboard step may await visibility confirmation. */
  stepRevealTimeoutMs?: number;
  onLifecycle?: (lifecycle: ProxyLifecycle) => void;
}

export interface ProxyLifecycle {
  completion: Promise<void>;
  close(): Promise<void>;
  forceTerminal(): Promise<void>;
}

function createCoordinatorState(goal: string): CoordinatorState {
  return {
    upstreamReady: false,
    toolContinues: 0,
    cancelledResponses: new Set(),
    started: false,
    childHoldsFloor: false,
    lastCreateSource: 'start',
    retryCreateOnDone: false,
    toolContinueAfterResponseId: null,
    clientIdentity: null,
    clientSequence: 0,
    lastClientSequence: -1,
    seenClientEvents: new Set(),
    seenIdempotencyKeys: new Set(),
    pendingClientPayloads: [],
    responseIdentities: new Map(),
    responseTranscript: new Map(),
    responseItems: new Map(),
    pendingVoiceBargeInResponses: new Set(),
    terminalTelemetryResponses: new Set(),
    reportedPlaybackResponses: new Set(),
    pendingBoardOps: new Map(),
    activeResponseId: null,
    speechInProgress: false,
    endpointingEagerness: 'medium',
    lessonState: createLessonState(goal),
    lastLearnerEventId: null,
    draftOpen: false,
    respondedSubmissionIds: new Set(),
    usedResponseKeys: new Set(),
    voiceTurnCounter: 0,
    pendingDeliveredTask: null,
    preflightCounter: 0,
    pendingPreflights: new Map(),
    visualRenderCounter: 0,
    pendingVisualRenders: new Map(),
    visualPlanState: 'none',
    visualRequestEpoch: 0,
    activeVisualRequestAbortController: null,
    abandonedVisualRequests: new Set(),
    planStagedThisTurn: false,
    planAttemptsThisTurn: 0,
    objectsCreatedThisTurn: new Set(),
    pendingVisibility: new Map(),
    pendingPresentation: new Map(),
    presentedBoardOps: new Set(),
    comparisonSectionCounter: 0,
    boardContext: new BoardContextTracker(),
    pendingResponseCreates: 0,
    lastCompletedResponseId: null,
    beatResponses: new Set(),
    storyboardRun: null,
  };
}

export async function connectRealtimeProxy(client: ClientSocket, options: ProxyOptions): Promise<void> {
  const { apiKey, model, repo, sessionId } = options;
  const log = options.log ?? (() => {});
  const session = await repo.getSession(sessionId);
  const child = session ? await repo.getChild(session.childId) : null;

  // Upgrade-time auth in app.ts already rejects unknown sessions; these
  // rejections surface as a rejected connection promise that the caller
  // maps to a 1011 close, preserving the pre-refactor observable contract.
  if (!session || !child) {
    throw new Error(`Unknown session ${sessionId}.`);
  }
  if (session.status !== 'active') {
    throw new Error(`Session ${sessionId} has ended and is read-only.`);
  }

  // A lesson never starts on an uncompiled goal. Sessions created before
  // the compiler existed have no record and replay their stored blueprint.
  const compiledRecord = await repo.getCompiledLesson(sessionId);
  if (compiledRecord && compiledRecord.status !== 'ready') {
    throw new Error(`Session ${sessionId} lesson is not compiled yet (${compiledRecord.status}).`);
  }
  const compiledLesson = compiledRecord?.lesson ?? null;

  const telemetryRepo = options.telemetryRepo ?? new YieldingTelemetryRepository(repo);
  const telemetryWriter = new SessionTelemetryWriter(telemetryRepo, sessionId);
  const state = createCoordinatorState(session.goal);
  if (compiledLesson) {
    state.lessonState = reduceLesson(state.lessonState, { type: 'BLUEPRINT_CREATED', blueprint: compiledLesson.blueprint });
  }
  state.boardContext = await loadReleasedBoardContext(repo, sessionId);
  const baseInstructions = buildInstructions({
    childName: child.name,
    childAge: child.age,
    goal: session.goal,
  });

  // The audio plane is a browser ↔ provider WebRTC call created by the
  // bootstrap endpoint; this connection is the control sideband attached to
  // that same call. A bootstrap moments ago left its configured socket in
  // the registry; otherwise (reconnect, another process) reattach by the
  // persisted call id. The injectable createUpstream keeps a model-scoped
  // URL available so the offline provider harness needs no call fixture.
  const callId = await latestVoiceCallId(repo, sessionId);
  const adopted = callId && options.sidebandRegistry
    ? options.sidebandRegistry.adopt(sessionId, callId)
    : null;
  const upstreamUrl = callId
    ? realtimeCallUrl(callId)
    : `${REALTIME_URL}?model=${encodeURIComponent(model)}`;
  if (!adopted && !options.createUpstream && !callId) {
    throw new Error(`Session ${sessionId} has no bootstrapped voice call to attach.`);
  }
  const upstream = adopted?.socket ?? options.createUpstream?.(upstreamUrl, apiKey) ?? new NodeWebSocket(upstreamUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  let teardownPromise: Promise<void> | null = null;
  let forceTerminalPromise: Promise<void> | null = null;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: unknown) => void;
  const lifecycleCompletion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void lifecycleCompletion.catch(() => {
    // App lifecycle tracking observes this promise; this guard also covers
    // direct test callers that intentionally do not install a tracker.
  });
  const sideEffectTasks = new Set<Promise<void>>();
  const backgroundTelemetry = new Set<Promise<void>>();
  let upstreamWork = Promise.resolve();
  let clientWork = Promise.resolve();
  let upstreamWorkPending = 0;
  let clientWorkPending = 0;
  let acceptingFrames = true;

  const ctx: CoordinatorContext = {
    repo,
    sessionId,
    lessonGoal: session.goal,
    compiledLesson,
    baseInstructions,
    log,
    telemetryWriter,
    telemetryRepo,
    preflightTimeoutMs: options.preflightTimeoutMs ?? 1_200,
    visibilityTimeoutMs: options.visibilityTimeoutMs ?? 15_000,
    planDetour: options.planDetour ?? null,
    detourPlanTimeoutMs: options.detourPlanTimeoutMs ?? DETOUR_PLAN_TIMEOUT_MS,
    directVisual: options.directVisual ?? null,
    streamVisual: options.streamVisual ?? null,
    stepRevealTimeoutMs: options.stepRevealTimeoutMs ?? 45_000,
    state,
    sendClient(
      payload: Record<string, unknown>,
      identity: GenerationIdentity | null = state.clientIdentity,
      optional: ClientCueOptional = {},
    ): void {
      if (!identity) {
        state.pendingClientPayloads.push(payload);
        return;
      }
      if (client.readyState !== client.OPEN) return;
      const { type, ...body } = payload;
      client.send(JSON.stringify(createRuntimeEvent(
        identity,
        state.clientSequence++,
        String(type ?? 'unknown'),
        body,
        {
          ...(typeof body.response_id === 'string' ? { providerResponseId: body.response_id } : {}),
          ...(typeof body.item_id === 'string' ? { providerItemId: body.item_id } : {}),
          ...optional,
        },
      )));
    },
    sendUpstream(payload: unknown): void {
      if (upstream.readyState === NodeWebSocket.OPEN) upstream.send(JSON.stringify(payload));
    },
    clientConnected(): boolean {
      return client.readyState === client.OPEN;
    },
    trackSideEffect(task: Promise<void>): void {
      sideEffectTasks.add(task);
      void task.finally(() => sideEffectTasks.delete(task)).catch(() => {});
    },
    trackTelemetry(task: Promise<void>): void {
      backgroundTelemetry.add(task);
      void task.finally(() => backgroundTelemetry.delete(task)).catch(() => {});
    },
  };

  function flushPendingClientPayloads(): void {
    if (!state.clientIdentity) return;
    for (const payload of state.pendingClientPayloads.splice(0)) ctx.sendClient(payload as Record<string, unknown>);
  }

  function sealAdmission(): void {
    acceptingFrames = false;
    upstream.onmessage = null;
    client.off('message', handleClientMessage);
  }

  function beginTeardown(reason: string): Promise<void> {
    if (teardownPromise) return teardownPromise;
    state.activeVisualRequestAbortController?.abort(`realtime proxy teardown: ${reason}`);
    state.activeVisualRequestAbortController = null;
    if (state.storyboardRun?.streamOpen) {
      abandonStoryboardRun(ctx, { injectNote: false, persistBridge: true });
    }
    sealAdmission();
    const sealedClientWork = clientWork;
    const sealedUpstreamWork = upstreamWork;
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
    teardownPromise = Promise.allSettled([
      sealedClientWork,
      sealedUpstreamWork,
    ]).then(async () => {
      while (sideEffectTasks.size > 0) {
        await Promise.allSettled([...sideEffectTasks]);
      }
      while (backgroundTelemetry.size > 0) {
        await Promise.allSettled([...backgroundTelemetry]);
      }
      await telemetryWriter.close();
      resolveCompletion();
    }).catch((error: unknown) => {
      rejectCompletion(error);
      throw error;
    });
    return teardownPromise;
  }

  function forceTerminal(): Promise<void> {
    if (forceTerminalPromise) return forceTerminalPromise;
    state.activeVisualRequestAbortController?.abort('realtime proxy forced terminal');
    state.activeVisualRequestAbortController = null;
    sealAdmission();
    telemetryWriter.forceTerminal();
    backgroundTelemetry.clear();
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
    if (
      clientWorkPending > 0 ||
      upstreamWorkPending > 0 ||
      sideEffectTasks.size > 0
    ) {
      forceTerminalPromise = Promise.reject(
        new Error('Proxy side-effect producer chains remain unsettled.'),
      );
      void forceTerminalPromise.catch(() => {});
      return forceTerminalPromise;
    }
    resolveCompletion();
    forceTerminalPromise = Promise.resolve();
    return forceTerminalPromise;
  }

  function teardown(reason: string): void {
    void beginTeardown(reason).catch((error: unknown) => {
      log(`session ${sessionId}: telemetry close error ${String(error).slice(0, 160)}`);
    });
  }

  options.onLifecycle?.({
    completion: lifecycleCompletion,
    close: () => beginTeardown('server shutdown'),
    forceTerminal,
  });

  // An adopted sideband was already configured by the bootstrap; a fresh
  // (re)attachment applies the full session configuration idempotently.
  if (!adopted) {
    upstream.onopen = () => {
      ctx.sendUpstream(initialSessionUpdate(ctx));
    };
  }

  function handleUpstreamMessage(raw: { data: unknown }): void {
    if (!acceptingFrames) return;
    let event: UpstreamEvent;
    try {
      event = JSON.parse(String(raw.data));
    } catch {
      return;
    }
    upstreamWorkPending += 1;
    upstreamWork = upstreamWork
      .then(() => handleUpstreamEvent(ctx, event))
      .catch((error) => {
        log(`session ${sessionId}: upstream processing error ${String(error).slice(0, 240)}`);
        ctx.sendClient({ type: 'error', message: 'Noura hit a snag — it will recover in a moment.' });
      })
      .finally(() => {
        upstreamWorkPending -= 1;
      });
  }

  upstream.onmessage = handleUpstreamMessage;
  // Provider events that arrived between bootstrap and this connection were
  // buffered by the registry; replay them in order before any live frame.
  if (adopted) {
    for (const raw of adopted.buffered) handleUpstreamMessage({ data: raw });
  }

  upstream.onerror = () => {
    ctx.sendClient({ type: 'error', message: 'Lost the connection to the tutor voice service.' });
  };

  upstream.onclose = () => {
    ctx.sendClient({ type: 'upstream_closed' });
    teardown('upstream closed');
  };

  function handleClientMessage(raw: unknown): void {
    if (!acceptingFrames) return;
    clientWorkPending += 1;
    clientWork = clientWork.then(async () => {
      let decoded: unknown;
      try { decoded = JSON.parse(String(raw)); }
      catch { return; }
      const parsed = RuntimeEventEnvelopeSchema.safeParse(decoded);
      if (!parsed.success) return;
      const envelope = parsed.data;
      if (envelope.sessionId !== sessionId || state.seenClientEvents.has(envelope.eventId)) return;
      if (state.clientIdentity && envelope.connectionEpoch < state.clientIdentity.connectionEpoch) return;
      const identityChanged = !state.clientIdentity ||
        envelope.connectionEpoch !== state.clientIdentity.connectionEpoch ||
        envelope.turnId !== state.clientIdentity.turnId ||
        envelope.generationId !== state.clientIdentity.generationId;
      if (identityChanged) {
        const connectionChanged = !state.clientIdentity ||
          envelope.connectionEpoch !== state.clientIdentity.connectionEpoch;
        const openStreamingIntake = connectionChanged && state.storyboardRun?.streamOpen === true;
        if (connectionChanged) {
          state.activeVisualRequestAbortController?.abort('client reconnected during visual stream');
          state.activeVisualRequestAbortController = null;
        }
        // Unpresented cues from the replaced client generation can no longer
        // cross first paint under that identity. Release their tool waits as
        // failed now; reconnect replay contains released truth only.
        for (const resolvePresentation of state.pendingPresentation.values()) {
          resolvePresentation(false);
        }
        state.pendingPresentation.clear();
        state.clientIdentity = {
          sessionId: envelope.sessionId,
          connectionEpoch: envelope.connectionEpoch,
          turnId: envelope.turnId,
          generationId: envelope.generationId,
        };
        state.clientSequence = 0;
        state.lastClientSequence = -1;
        flushPendingClientPayloads();
        if (openStreamingIntake && state.storyboardRun?.streamOpen) {
          // The full directed_scene does not exist yet, so only already
          // released board events are durable across this reconnect.
          abandonStoryboardRun(ctx, { injectNote: true, requestResponse: false });
        } else {
          noteStoryboardClientIdentityChanged(ctx);
        }
      }
      if (envelope.sequence <= state.lastClientSequence) return;
      state.lastClientSequence = envelope.sequence;
      state.seenClientEvents.add(envelope.eventId);
      if (state.seenClientEvents.size > 1000) state.seenClientEvents.delete(state.seenClientEvents.values().next().value as string);
      await handleClientEvent(
        ctx,
        { type: envelope.type, ...(envelope.payload as Record<string, unknown>) },
        envelope as RuntimeEventEnvelope,
      );
    }).catch((error) => {
      log(`session ${sessionId}: client processing error ${String(error).slice(0, 240)}`);
      ctx.sendClient({ type: 'error', message: 'Noura could not save that turn. Please try again.' });
    }).finally(() => {
      clientWorkPending -= 1;
    });
  }

  client.on('message', handleClientMessage);

  client.on('close', () => teardown('client closed'));
  client.on('error', () => teardown('client error'));
}
