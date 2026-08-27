import { WebSocket as NodeWebSocket } from 'ws';
import type { DomainRepository } from '../store/domain.js';
import { buildInstructions, lessonExecutionContext } from './instructions.js';
import { loadReleasedBoardContext } from './boardContext.js';
import { realtimeCallUrl, sessionUpdatePayload } from './sessionConfig.js';

/**
 * WebRTC call bootstrap: the browser posts its SDP offer here; the server —
 * never the browser — holds the API key, creates the provider call, persists
 * the call id in the session event log, attaches and configures the control
 * sideband, and only then returns the SDP answer. Audio never touches this
 * server: it flows browser ↔ provider on the peer connection.
 */

const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const SIDEBAND_OPEN_TIMEOUT_MS = 8_000;
const STASH_TTL_MS = 60_000;
const MAX_BUFFERED_FRAMES = 512;

export interface RealtimeCallResult {
  callId: string;
  answerSdp: string;
}

export async function createRealtimeCall(input: {
  apiKey: string;
  model: string;
  offerSdp: string;
  fetchImpl?: typeof fetch;
}): Promise<RealtimeCallResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${REALTIME_CALLS_URL}?model=${encodeURIComponent(input.model)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/sdp',
    },
    body: input.offerSdp,
  });
  if (!response.ok) {
    throw new Error(`Realtime call creation failed with status ${response.status}.`);
  }
  const location = response.headers.get('Location') ?? '';
  const callId = location.split('/').filter(Boolean).at(-1) ?? '';
  if (!callId || !location.includes('/realtime/calls/')) {
    throw new Error('Realtime call response carried no call id in its Location header.');
  }
  return { callId, answerSdp: await response.text() };
}

/** The most recent bootstrapped provider call for a session, if any. */
export async function latestVoiceCallId(repo: DomainRepository, sessionId: string): Promise<string | null> {
  const events = await repo.listEvents(sessionId, 2000);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== 'voice_call') continue;
    const callId = (event.payload as { callId?: unknown }).callId;
    if (typeof callId === 'string' && callId) return callId;
  }
  return null;
}

export interface AdoptedSideband {
  socket: NodeWebSocket;
  /** Raw frames the sideband received before a coordinator adopted it. */
  buffered: string[];
}

interface StashedSideband {
  callId: string;
  socket: NodeWebSocket;
  buffered: string[];
  timer: NodeJS.Timeout;
}

/**
 * Holds the configured sideband between the bootstrap POST and the envelope
 * WebSocket connection so no provider event is lost in the gap. If the
 * envelope lands on a different process (or too late), the coordinator
 * reattaches to the call by its persisted id instead.
 */
export class SidebandRegistry {
  private stashes = new Map<string, StashedSideband>();

  stash(sessionId: string, callId: string, socket: NodeWebSocket): void {
    this.evict(sessionId);
    const entry: StashedSideband = {
      callId,
      socket,
      buffered: [],
      timer: setTimeout(() => this.evict(sessionId), STASH_TTL_MS),
    };
    entry.timer.unref?.();
    socket.onmessage = (event) => {
      if (entry.buffered.length < MAX_BUFFERED_FRAMES) entry.buffered.push(String(event.data));
    };
    socket.onclose = () => this.evict(sessionId, false);
    this.stashes.set(sessionId, entry);
  }

  adopt(sessionId: string, callId: string): AdoptedSideband | null {
    const entry = this.stashes.get(sessionId);
    if (!entry || entry.callId !== callId) return null;
    this.stashes.delete(sessionId);
    clearTimeout(entry.timer);
    entry.socket.onmessage = null;
    entry.socket.onclose = null;
    return { socket: entry.socket, buffered: entry.buffered };
  }

  private evict(sessionId: string, close = true): void {
    const entry = this.stashes.get(sessionId);
    if (!entry) return;
    this.stashes.delete(sessionId);
    clearTimeout(entry.timer);
    if (close) {
      try { entry.socket.close(); } catch { /* already closed */ }
    }
  }
}

export interface BootstrapDeps {
  repo: DomainRepository;
  apiKey: string;
  model: string;
  registry: SidebandRegistry;
  fetchImpl?: typeof fetch;
  createUpstream?: (url: string, apiKey: string) => NodeWebSocket;
  log: (line: string) => void;
}

export type BootstrapResult =
  | { ok: true; answerSdp: string; callId: string }
  | { ok: false; status: number; error: string };

/**
 * Waits for the freshly attached sideband to open and applies the full
 * session configuration before any browser audio can flow. Fails closed:
 * an unconfigured call would let provider VAD defaults own the floor.
 */
function openAndConfigure(socket: NodeWebSocket, sessionUpdate: Record<string, unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), SIDEBAND_OPEN_TIMEOUT_MS);
    const configure = () => {
      try {
        socket.send(JSON.stringify(sessionUpdate));
        finish(true);
      } catch {
        finish(false);
      }
    };
    if (socket.readyState === NodeWebSocket.OPEN) {
      configure();
      return;
    }
    socket.onopen = () => {
      socket.onopen = null;
      configure();
    };
    socket.onerror = () => finish(false);
    socket.onclose = () => finish(false);
  });
}

export async function bootstrapVoiceCall(
  deps: BootstrapDeps,
  input: { sessionId: string; offerSdp: string },
): Promise<BootstrapResult> {
  const session = await deps.repo.getSession(input.sessionId);
  const child = session ? await deps.repo.getChild(session.childId) : null;
  if (!session || !child) return { ok: false, status: 404, error: 'Unknown session.' };
  if (session.status !== 'active') {
    return { ok: false, status: 409, error: 'This lesson has ended and is read-only.' };
  }
  // A voice call never starts on an uncompiled goal; legacy sessions
  // without a compilation record replay their stored blueprint instead.
  const compiled = await deps.repo.getCompiledLesson(input.sessionId);
  if (compiled && compiled.status !== 'ready') {
    return {
      ok: false,
      status: 409,
      error: compiled.status === 'pending'
        ? 'The lesson is still being prepared.'
        : 'The lesson could not be prepared. Create the lesson again.',
    };
  }

  let call: RealtimeCallResult;
  try {
    call = await createRealtimeCall({
      apiKey: deps.apiKey,
      model: deps.model,
      offerSdp: input.offerSdp,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  } catch (error) {
    deps.log(`session ${input.sessionId}: realtime call bootstrap failed ${String(error).slice(0, 200)}`);
    return { ok: false, status: 502, error: 'The voice call could not be created.' };
  }

  await deps.repo.addEvent(input.sessionId, 'voice_call', { callId: call.callId });

  const boardContext = await loadReleasedBoardContext(deps.repo, input.sessionId);
  const blueprint = compiled?.lesson?.blueprint ?? null;
  const stageContext = lessonExecutionContext(
    blueprint,
    blueprint ? blueprint.stages[Math.min(blueprint.currentStageIndex, blueprint.stages.length - 1)] : null,
    compiled?.lesson?.anchorScene ?? null,
  );
  const instructions = [
    buildInstructions({ childName: child.name, childAge: child.age, goal: session.goal }),
    stageContext,
    boardContext.prompt(),
  ].filter(Boolean).join('\n\n');
  const url = realtimeCallUrl(call.callId);
  const socket = deps.createUpstream?.(url, deps.apiKey) ?? new NodeWebSocket(url, {
    headers: { Authorization: `Bearer ${deps.apiKey}` },
  });
  const configured = await openAndConfigure(socket, sessionUpdatePayload(instructions));
  if (!configured) {
    try { socket.close(); } catch { /* already closed */ }
    deps.log(`session ${input.sessionId}: sideband attach failed for call ${call.callId}`);
    return { ok: false, status: 502, error: 'The voice control channel could not be attached.' };
  }
  deps.registry.stash(input.sessionId, call.callId, socket);
  return { ok: true, answerSdp: call.answerSdp, callId: call.callId };
}
