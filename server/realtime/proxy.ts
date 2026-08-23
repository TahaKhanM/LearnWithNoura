import type { WebSocket as ClientSocket } from 'ws';
import { validateOps } from '../../shared/boardOps';
import { buildInstructions } from './instructions';
import { REALTIME_TOOLS } from './tools';
import type { Repo, Confidence, Verdict } from '../store/repo';

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
  repo: Repo;
  sessionId: string;
  log?: (line: string) => void;
}

export function connectRealtimeProxy(client: ClientSocket, options: ProxyOptions): void {
  const { apiKey, model, repo, sessionId } = options;
  const log = options.log ?? (() => {});
  const session = repo.getSession(sessionId);
  const child = session ? repo.getChild(session.childId) : null;

  if (!session || !child) {
    sendClient({ type: 'error', message: 'Unknown session.' });
    client.close(4404, 'unknown session');
    return;
  }

  const upstream = new WebSocket(`${REALTIME_URL}?model=${encodeURIComponent(model)}`, {
    // Node's fetch-based WebSocket accepts headers here.
    headers: { Authorization: `Bearer ${apiKey}` },
  } as unknown as string[]);

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
  let lastCreateSource: 'tool' | 'user' | 'start' = 'start';
  /** A user ask hit an active response; ask again once it finishes. */
  let retryCreateOnDone = false;

  function sendClient(payload: unknown): void {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(payload));
  }

  function sendUpstream(payload: unknown): void {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(payload));
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
        instructions: buildInstructions({
          childName: child.name,
          childAge: child.age,
          goal: session.goal,
        }),
        tools: REALTIME_TOOLS,
        tool_choice: 'auto',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: {
              type: 'semantic_vad',
              eagerness: 'medium',
              create_response: true,
              interrupt_response: true,
            },
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
    handleUpstream(event);
  };

  upstream.onerror = () => {
    sendClient({ type: 'error', message: 'Lost the connection to the tutor voice service.' });
  };

  upstream.onclose = () => {
    sendClient({ type: 'upstream_closed' });
    teardown('upstream closed');
  };

  function replayBoard(): void {
    // Only marks the child actually saw; ops cancelled mid-speech were
    // never released and must not reappear after a refresh. Stored ops are
    // re-validated so yesterday's data always meets today's rules.
    const batches = repo
      .listEvents(sessionId, 2000)
      .filter((e) => e.type === 'board_ops' && e.released)
      .map((e) => validateOps((e.payload as { ops?: unknown[] })?.ops).ops)
      .filter((ops) => ops.length > 0);
    if (batches.length > 0) sendClient({ type: 'board_replay', batches });
  }

  /** After a refresh the upstream model starts cold; hand it the story so far. */
  function conversationContext(): string | null {
    const events = repo.listEvents(sessionId, 2000);
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

  function handleUpstream(event: UpstreamEvent): void {
    switch (event.type) {
      case 'session.updated': {
        if (!upstreamReady) {
          upstreamReady = true;
          replayBoard();
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
        const response = event.response as { id?: string } | undefined;
        sendClient({ type: 'response_started', response_id: response?.id });
        break;
      }

      case 'response.output_audio.delta':
        sendClient({
          type: 'audio',
          delta: event.delta,
          response_id: event.response_id,
          item_id: event.item_id,
        });
        break;

      case 'response.output_audio.done':
        sendClient({ type: 'audio_done', response_id: event.response_id });
        break;

      case 'response.output_audio_transcript.delta':
        sendClient({
          type: 'transcript_delta',
          delta: event.delta,
          response_id: event.response_id,
          item_id: event.item_id,
        });
        break;

      case 'response.output_audio_transcript.done': {
        const text = String(event.transcript ?? '');
        if (text.trim()) repo.addEvent(sessionId, 'tutor_said', { text });
        sendClient({ type: 'transcript_done', text, response_id: event.response_id });
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const text = String(event.transcript ?? '').trim();
        if (text) {
          repo.addEvent(sessionId, 'learner_said', { text });
          sendClient({ type: 'user_transcript', text });
        }
        break;
      }

      case 'input_audio_buffer.speech_started':
        toolContinues = 0;
        childHoldsFloor = true;
        sendClient({ type: 'speech_started' });
        break;

      case 'input_audio_buffer.speech_stopped':
        // VAD will now create the next response itself.
        childHoldsFloor = false;
        sendClient({ type: 'speech_stopped' });
        break;

      case 'response.function_call_arguments.done': {
        handleToolCall(
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
        sendClient({ type: 'response_done', response_id: response?.id, status });
        if (retryCreateOnDone) {
          // The child asked something while a response was still running;
          // their question must not be dropped.
          retryCreateOnDone = false;
          lastCreateSource = 'user';
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
        if (alreadyActive && lastCreateSource === 'user') retryCreateOnDone = true;
        const benign = error?.code === 'response_cancel_not_active' || alreadyActive;
        log(`session ${sessionId}: upstream error ${JSON.stringify(event.error).slice(0, 300)}`);
        if (!benign) {
          sendClient({ type: 'error', message: 'The tutor hit a snag — it will recover in a moment.' });
        }
        break;
      }

      default:
        break;
    }
  }

  function handleToolCall(name: string, rawArgs: string, callId: string, responseId: string): void {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      finishTool(callId, responseId, { ok: false, error: 'arguments were not valid JSON' });
      return;
    }

    switch (name) {
      case 'board_ops': {
        const { ops, rejected } = validateOps(args.ops);
        if (ops.length > 0) {
          const eventId = repo.addEvent(sessionId, 'board_ops', { ops }, false);
          sendClient({ type: 'board_ops', ops, response_id: responseId, event_id: eventId });
        }
        finishTool(callId, responseId, {
          ok: rejected.length === 0,
          applied: ops.length,
          ...(rejected.length > 0
            ? { rejected: rejected.map((r) => r.reason).slice(0, 5) }
            : {}),
        });
        break;
      }

      case 'record_evidence': {
        const verdicts: Verdict[] = ['mastered', 'progressing', 'struggling', 'misconception'];
        const confidences: Confidence[] = ['low', 'medium', 'high'];
        const entry = {
          concept: String(args.concept ?? '').slice(0, 120),
          observation: String(args.observation ?? '').slice(0, 500),
          verdict: verdicts.includes(args.verdict as Verdict)
            ? (args.verdict as Verdict)
            : 'progressing',
          confidence: confidences.includes(args.confidence as Confidence)
            ? (args.confidence as Confidence)
            : 'low',
          excerpt: args.excerpt ? String(args.excerpt).slice(0, 300) : undefined,
        };
        if (entry.concept && entry.observation) {
          repo.addEvidence(sessionId, entry);
          repo.addEvent(sessionId, 'evidence', entry);
          sendClient({ type: 'evidence', entry });
          finishTool(callId, responseId, { ok: true });
        } else {
          finishTool(callId, responseId, { ok: false, error: 'concept and observation are required' });
        }
        break;
      }

      case 'update_lesson_state': {
        const state = {
          activeConcept: String(args.active_concept ?? '').slice(0, 160),
          strategy: args.strategy ? String(args.strategy).slice(0, 160) : undefined,
          nextStep: args.next_step ? String(args.next_step).slice(0, 240) : undefined,
        };
        repo.addEvent(sessionId, 'lesson_state', state);
        sendClient({ type: 'lesson_state', state });
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
    let message: UpstreamEvent;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    handleClient(message);
  });

  client.on('close', () => teardown('client closed'));
  client.on('error', () => teardown('client error'));

  function handleClient(message: UpstreamEvent): void {
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
        const resume = conversationContext();
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
        repo.addEvent(sessionId, 'session_started', { resumed: Boolean(resume) });
        lastCreateSource = 'start';
        sendUpstream({ type: 'response.create' });
        break;
      }

      case 'user_text': {
        const text = String(message.text ?? '').trim().slice(0, 2000);
        if (!text) break;
        toolContinues = 0;
        childHoldsFloor = false;
        repo.addEvent(sessionId, 'learner_said', { text, via: 'text' });
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
          repo.addEvent(sessionId, 'interrupted', { audio_end_ms: message.audio_end_ms });
        }
        break;
      }

      case 'board_event': {
        const description = String(message.description ?? '').trim().slice(0, 4000);
        if (!description) break;
        repo.addEvent(sessionId, 'learner_board', { description });
        sendUpstream({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `[The learner just drew on the board — this is context, not a message] ${description}`,
              },
            ],
          },
        });
        break;
      }

      case 'ops_shown': {
        // The child has actually seen this batch; it is now part of the board.
        if (typeof message.event_id === 'number') {
          repo.markEventReleased(sessionId, message.event_id);
        }
        break;
      }

      case 'metric': {
        // Client-side latency marks, kept with the session for observability.
        repo.addEvent(sessionId, 'metric', {
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
