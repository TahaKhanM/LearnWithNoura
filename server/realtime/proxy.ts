import { WebSocket as NodeWebSocket, type WebSocket as ClientSocket } from 'ws';
import { normalizeColor, validateOps, validateSpec, type BoardOp } from '../../shared/boardOps.js';
import {
  createRuntimeEvent,
  RuntimeEventEnvelopeSchema,
  type GenerationIdentity,
  type RuntimeEventEnvelope,
} from '../../shared/runtimeProtocol.js';
import { buildInstructions } from './instructions.js';
import { REALTIME_TOOLS } from './tools.js';
import type { Confidence, Verdict } from '../store/repo.js';
import { createLessonState, reduceLesson, responseHandoff } from '../lesson/orchestrator.js';
import { ResponseTaxonomySchema, TeachingMoveSchema, type ResponseTaxonomy } from '../../shared/pedagogy.js';
import { adaptSemanticScene } from '../../shared/semanticScene.js';
import { LearnerBoardAnalysisSchema } from '../../shared/learnerBoard.js';
import { ResponseSegmentAnnotator } from './segmentAnnotator.js';
import { loadReleasedBoardContext } from './boardContext.js';
import type { DomainRepository } from '../store/domain.js';

/**
 * Bridges one browser lesson to one OpenAI Realtime session.
 *
 * The browser never sees the API key; the server sees every event, so the
 * child experience and the parent dashboard are fed by the same stream.
 * Tool calls are executed here: board operations are validated before a
 * single mark reaches the board, and evidence is persisted as it happens.
 */

const REALTIME_URL = 'wss://api.openai.com/v1/realtime';

/** Stop auto-continuing tool chains after this many rounds per turn. */
const MAX_TOOL_CONTINUES = 14;

interface UpstreamEvent {
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
  let lastCreateSource: 'tool' | 'user' | 'board' | 'start' = 'start';
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
  const pendingBoardOps = new Map<number, { ops: BoardOp[]; semanticGroupId?: string; groupLabel?: string }>();
  let activeResponseId: string | null = null;
  let speechInProgress = false;
  let endpointingEagerness: 'medium' | 'high' = 'medium';
  let lessonState = createLessonState(session.goal);
  let lastLearnerEventId: number | null = null;
  let upstreamWork = Promise.resolve();
  let clientWork = Promise.resolve();

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

  function sendUpstream(payload: unknown): void {
    if (upstream.readyState === NodeWebSocket.OPEN) upstream.send(JSON.stringify(payload));
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
        const payload = e.payload as { ops?: unknown[]; semanticObjectId?: unknown; groupLabel?: unknown; plan?: { groups?: Array<{ id?: unknown; label?: unknown }> } };
        const ops = validateOps(payload.ops).ops;
        const semanticObjectId = typeof payload.semanticObjectId === 'string'
          ? payload.semanticObjectId
          : typeof payload.plan?.groups?.[0]?.id === 'string' ? payload.plan.groups[0].id : undefined;
        const groupLabel = typeof payload.groupLabel === 'string'
          ? payload.groupLabel
          : typeof payload.plan?.groups?.[0]?.label === 'string' ? payload.plan.groups[0].label : undefined;
        return { ops, ...(semanticObjectId ? { semanticObjectId } : {}), ...(groupLabel ? { groupLabel } : {}) };
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
        // A response only starts when the child's turn is over (VAD or an
        // explicit ask), so the floor is the tutor's again. This also
        // recovers from a false-positive local interrupt that VAD never
        // confirmed.
        childHoldsFloor = false;
        speechInProgress = false;
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
        // VAD will now create the next response itself.
        speechInProgress = false;
        childHoldsFloor = false;
        sendClient({ type: 'speech_stopped' });
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
          | { id?: string; status?: string; output?: { type: string }[] }
          | undefined;
        const status = response?.status ?? 'unknown';
        if (status === 'cancelled' && response?.id) cancelledResponses.add(response.id);
        const responseIdentity = identityForResponse(response?.id);
        if (response?.id) flushResponseSegment(response.id, status === 'completed');
        sendClient({ type: 'response_done', response_id: response?.id, status }, responseIdentity);
        if (response?.id === activeResponseId) activeResponseId = null;
        if (retryCreateOnDone) {
          // The child asked something while a response was still running;
          // their question must not be dropped.
          retryCreateOnDone = false;
          lastCreateSource = 'user';
          sendUpstream({ type: 'response.create' });
        }
        const hasFunctionCall = response?.output?.some((item) => item.type === 'function_call') ?? false;
        if (status === 'completed' && response?.id && !hasFunctionCall && !cancelledResponses.has(response.id)) {
          const delivered = responseTranscript.get(response.id) ?? '';
          if (/[?？]\s*$/.test(delivered.trim())) {
            try {
              lessonState = reduceLesson(lessonState, {
                type: 'QUESTION_DELIVERED',
                taskId: `question-${response.id}`,
                text: delivered.trim(),
              });
            } catch { /* the next deterministic decision will recover */ }
          } else {
            const decision = responseHandoff(lessonState, delivered);
            if (decision === 'bounded_continuation' && !childHoldsFloor) {
              lessonState = { ...lessonState, continuationAttempts: lessonState.continuationAttempts + 1 };
              sendUpstream({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'system',
                  content: [{
                    type: 'input_text',
                    text: 'Complete the promised teaching move now. End with exactly one short, concrete question or small task, then wait.',
                  }],
                },
              });
              lastCreateSource = 'tool';
              sendUpstream({ type: 'response.create' });
            } else if (decision === 'safe_question') {
              const safeQuestion = 'Tell me one thing you notice about the idea we just explored?';
              await repo.addEvent(sessionId, 'tutor_said', { text: safeQuestion, deterministic: true });
              sendClient({ type: 'safe_question', text: safeQuestion }, responseIdentity);
              lessonState = reduceLesson(lessonState, {
                type: 'QUESTION_DELIVERED',
                taskId: `safe-question-${response.id}`,
                text: safeQuestion,
              });
            }
          }
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
        if (alreadyActive && ['user', 'board'].includes(lastCreateSource)) retryCreateOnDone = true;
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
          const { plan, ops, checkpoints } = adaptSemanticScene(args);
          if (plan.intent.action === 'reuse' || plan.intent.action === 'skip') {
            const targetAvailable = plan.intent.action !== 'reuse' || Boolean(plan.intent.targetGroupId && boardContext.hasGroup(plan.intent.targetGroupId));
            finishTool(callId, responseId, {
              ok: targetAvailable,
              accepted: targetAvailable,
              action: plan.intent.action,
              relevance: plan.intent.relevance,
              questionAnswered: plan.intent.questionAnswered,
              ...(!targetAvailable ? { reason: 'The requested board section is not visible. Inspect the board and choose an existing group or create a new visual.' } : {}),
              board: boardContext.toolSnapshot(),
            });
            break;
          }
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
          if (plan.intent.action === 'replace' && (!plan.intent.targetGroupId || !boardContext.hasGroup(plan.intent.targetGroupId))) {
            finishTool(callId, responseId, {
              ok: false,
              accepted: false,
              reason: 'The section requested for replacement is not visible. Inspect the board before replacing it.',
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
          for (const checkpoint of checkpoints) {
            const eventId = await repo.addEvent(sessionId, 'semantic_scene', {
              plan,
              ops: checkpoint.ops,
              checkpointId: checkpoint.id,
              reveal: checkpoint.reveal,
              semanticObjectId: checkpoint.semanticObjectId,
              groupLabel: checkpoint.groupLabel,
            }, false);
            pendingBoardOps.set(eventId, { ops: checkpoint.ops, semanticGroupId: checkpoint.semanticObjectId, groupLabel: checkpoint.groupLabel });
            responseSegment(responseId).addSemanticCue({
              type: 'board_ops',
              ops: checkpoint.ops,
              response_id: responseId,
              event_id: eventId,
              groupLabel: checkpoint.groupLabel,
              checkpoint: checkpoint.reveal,
            }, {
              visualCueId: checkpoint.id,
              semanticObjectId: checkpoint.semanticObjectId,
            });
          }
          finishTool(callId, responseId, {
            ok: true,
            accepted: true,
            applied: ops.length,
            checkpoints: checkpoints.length,
            noBoard: ops.length === 0,
            action: plan.intent.action,
            relevance: plan.intent.relevance,
            questionAnswered: plan.intent.questionAnswered,
            acceptedPendingObjectIds: ops.filter((op) => op.op === 'add').map((op) => op.id),
            board: boardContext.toolSnapshot(),
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
        try {
          lessonState = reduceLesson(lessonState, { type: 'MOVE_PROPOSED', move: parsed.data });
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
          finishTool(callId, responseId, {
            ok: true,
            legalPhase: lessonState.phase,
            owedAction: lessonState.owedAction,
            board: boardContext.toolSnapshot(),
          });
        } catch (error) {
          finishTool(callId, responseId, { ok: false, error: String(error).slice(0, 220) });
        }
        break;
      }

      case 'board_ops': {
        const validated = validateOps(args.ops);
        const semanticGroupId = lessonState.activeSemanticObjectId ?? `freeform-${identityForResponse(responseId)?.turnId ?? 'board'}`;
        const novel = boardContext.novelTutorOps(validated.ops, semanticGroupId);
        const { ops } = novel;
        if (ops.length > 0) {
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
            lessonState = reduceLesson(lessonState, { type: 'ASSESSED', classification, evidenceId: stored.evidenceId });
            finishTool(callId, responseId, { ok: true, evidenceId: stored.evidenceId });
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
      await handleClient({ type: envelope.type, ...(envelope.payload as Record<string, unknown>) });
    }).catch((error) => {
      log(`session ${sessionId}: client processing error ${String(error).slice(0, 240)}`);
      sendClient({ type: 'error', message: 'Noura could not save that turn. Please try again.' });
    });
  });

  client.on('close', () => teardown('client closed'));
  client.on('error', () => teardown('client error'));

  async function handleClient(message: UpstreamEvent): Promise<void> {
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
        await repo.addEvent(sessionId, 'session_started', { resumed: Boolean(resume) });
        lastCreateSource = 'start';
        sendUpstream({ type: 'response.create' });
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
        sendUpstream({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
        });
        lastCreateSource = 'user';
        sendUpstream({ type: 'response.create' });
        break;
      }

      case 'interrupt': {
        // The client already stopped local audio; make the model stop too,
        // and keep tool chains from restarting it while the child speaks.
        childHoldsFloor = true;
        if (activeResponseId) cancelledResponses.add(activeResponseId);
        lessonState = reduceLesson(lessonState, { type: 'INTERRUPTED' });
        if (message.reason === 'voice') setEndpointingEagerness('high');
        sendUpstream({ type: 'response.cancel' });
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

      case 'board_event': {
        const description = String(message.description ?? '').trim().slice(0, 4000);
        const ops = learnerBoardOps(message.ops);
        const imageDataUrl = safeBoardImage(message.imageDataUrl);
        const semanticGroupId = typeof message.semanticObjectId === 'string' ? message.semanticObjectId.slice(0, 160) : undefined;
        const semanticGroupLabel = typeof message.semanticGroupLabel === 'string' ? message.semanticGroupLabel.slice(0, 160) : undefined;
        const parsedAnalysis = LearnerBoardAnalysisSchema.safeParse(message.analysis);
        const analysis = parsedAnalysis.success ? parsedAnalysis.data : null;
        if (!description && ops.length === 0) break;
        await repo.addEvent(sessionId, 'learner_board', {
          description,
          ops,
          hasVisualContext: Boolean(imageDataUrl),
          ...(semanticGroupId ? { semanticObjectId: semanticGroupId } : {}),
          ...(semanticGroupLabel ? { groupLabel: semanticGroupLabel } : {}),
          ...(analysis ? { analysis } : {}),
        });
        boardContext.apply(ops, 'learner', semanticGroupId, semanticGroupLabel);
        if (analysis) boardContext.observeLearnerAnalysis(analysis);
        refreshBoardInstructions();
        const content: Array<Record<string, unknown>> = [{
          type: 'input_text',
          text: [
            '[The learner changed the shared board. Treat this as visual context, not a spoken message.]',
            description,
            analysis ? `Deterministic vector analysis (spatial hints, not meaning): ${analysis.summary}` : '',
            'Use the attached full-board/detail image to interpret the mark. If its meaning is ambiguous, ask the learner rather than guessing.',
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
        // A board-only turn is a real learner turn, not passive telemetry.
        // If speech is also active, semantic VAD will create the one response
        // after speech stops and the image remains context for that turn.
        if (message.requestResponse === true && !speechInProgress) {
          childHoldsFloor = false;
          toolContinues = 0;
          lastCreateSource = 'board';
          sendUpstream({ type: 'response.create' });
        }
        break;
      }

      case 'ops_shown': {
        // The child has actually seen this batch; it is now part of the board.
        if (typeof message.event_id === 'number') {
          await repo.markEventReleased(sessionId, message.event_id);
          const pending = pendingBoardOps.get(message.event_id);
          if (pending) {
            boardContext.apply(pending.ops, 'tutor', pending.semanticGroupId, pending.groupLabel);
            pendingBoardOps.delete(message.event_id);
          } else {
            // Covers acknowledgement after an unusual connection handoff.
            boardContext = await loadReleasedBoardContext(repo, sessionId);
          }
          refreshBoardInstructions();
        }
        break;
      }

      case 'ops_rejected': {
        const eventId = typeof message.event_id === 'number' ? message.event_id : null;
        if (eventId !== null) pendingBoardOps.delete(eventId);
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
        // Client-side latency marks, kept with the session for observability.
        await repo.addEvent(sessionId, 'metric', {
          name: String(message.name ?? '').slice(0, 60),
          ms: Number(message.ms) || 0,
        });
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
    create_response: true,
    // Client-side sustained-speech confirmation owns cancellation; provider
    // VAD alone must not stop Noura on incidental noise.
    interrupt_response: false,
  } as const;
}
