import { describe, expect, it } from 'vitest';
import { openTestDb } from '../store/db';
import { Repo } from '../store/repo';
import {
  bootstrapVoiceCall,
  createRealtimeCall,
  latestVoiceCallId,
  SidebandRegistry,
} from './callBootstrap';

class FakeSideband {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  url: string;
  closed = false;
  constructor(url: string) { this.url = url; }
  send(raw: string) { this.sent.push(raw); }
  close() { this.closed = true; this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

function fetchAnswer(callId = 'rtc_test_call', answer = 'v=0\nanswer'): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => new Response(answer, {
    status: 201,
    headers: {
      Location: `/v1/realtime/calls/${callId}`,
      'Content-Type': 'application/sdp',
      'X-Request-Url': String(url),
      'X-Request-Auth': String((init?.headers as Record<string, string>)?.Authorization ?? ''),
    },
  })) as typeof fetch;
}

describe('createRealtimeCall', () => {
  it('POSTs the offer SDP with the server API key and parses the call id from Location', async () => {
    let seenUrl = '';
    let seenBody = '';
    let seenContentType = '';
    let seenAuth = '';
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = String(init?.body ?? '');
      const headers = init?.headers as Record<string, string>;
      seenContentType = headers['Content-Type'];
      seenAuth = headers.Authorization;
      return new Response('v=0\nanswer-sdp', {
        status: 201,
        headers: { Location: '/v1/realtime/calls/rtc_abc123' },
      });
    }) as typeof fetch;
    const result = await createRealtimeCall({
      apiKey: 'sk-offline-fixture',
      model: 'gpt-realtime-2.1',
      offerSdp: 'v=0\noffer-sdp',
      fetchImpl,
    });
    expect(seenUrl).toBe('https://api.openai.com/v1/realtime/calls?model=gpt-realtime-2.1');
    expect(seenBody).toBe('v=0\noffer-sdp');
    expect(seenContentType).toBe('application/sdp');
    expect(seenAuth).toBe('Bearer sk-offline-fixture');
    expect(result).toEqual({ callId: 'rtc_abc123', answerSdp: 'v=0\nanswer-sdp' });
  });

  it('fails when the provider responds without a call id', async () => {
    const fetchImpl = (async () => new Response('v=0\nanswer', { status: 201 })) as typeof fetch;
    await expect(createRealtimeCall({
      apiKey: 'sk-offline-fixture', model: 'gpt-realtime-2.1', offerSdp: 'v=0', fetchImpl,
    })).rejects.toThrow(/call id/i);
  });

  it('fails on a provider error status', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    await expect(createRealtimeCall({
      apiKey: 'sk-offline-fixture', model: 'gpt-realtime-2.1', offerSdp: 'v=0', fetchImpl,
    })).rejects.toThrow(/401/);
  });
});

describe('bootstrapVoiceCall', () => {
  function makeDeps() {
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const registry = new SidebandRegistry();
    const sockets: FakeSideband[] = [];
    const deps = {
      repo,
      apiKey: 'sk-offline-fixture',
      model: 'gpt-realtime-2.1',
      registry,
      fetchImpl: fetchAnswer('rtc_boot_1'),
      createUpstream: (url: string) => {
        const socket = new FakeSideband(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket as never;
      },
      log: () => {},
    };
    return { repo, session, registry, sockets, deps };
  }

  it('creates the call, persists the call id, configures the sideband, and returns the answer', async () => {
    const { repo, session, registry, sockets, deps } = makeDeps();
    const result = await bootstrapVoiceCall(deps, { sessionId: session.id, offerSdp: 'v=0\noffer' });
    expect(result).toEqual({ ok: true, answerSdp: 'v=0\nanswer', callId: 'rtc_boot_1' });

    expect(await latestVoiceCallId(repo, session.id)).toBe('rtc_boot_1');

    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toContain('call_id=rtc_boot_1');
    const update = JSON.parse(sockets[0].sent[0]) as {
      type: string;
      session: {
        audio: {
          input: {
            turn_detection: { type: string; create_response: boolean; interrupt_response: boolean };
            noise_reduction: { type: string };
            transcription: { model: string };
          };
          output: { voice: string };
        };
        reasoning: { effort: string };
        tools: Array<{ name?: string }>;
      };
    };
    expect(update.type).toBe('session.update');
    expect(update.session.audio.input.turn_detection.create_response).toBe(false);
    expect(update.session.audio.input.turn_detection.interrupt_response).toBe(false);
    expect(update.session.audio.input.noise_reduction).toEqual({ type: 'near_field' });
    expect(update.session.audio.input.transcription.model).toBe('gpt-4o-mini-transcribe');
    expect(update.session.audio.output.voice).toBe('marin');
    expect(update.session.reasoning.effort).toBe('low');
    expect(update.session.tools.some((tool) => tool.name === 'inspect_board')).toBe(true);

    const adopted = registry.adopt(session.id, 'rtc_boot_1');
    expect(adopted?.socket).toBe(sockets[0]);
  });

  it('buffers sideband frames while stashed and hands them to the adopter', async () => {
    const { session, registry, sockets, deps } = makeDeps();
    await bootstrapVoiceCall(deps, { sessionId: session.id, offerSdp: 'v=0\noffer' });
    sockets[0].emit({ type: 'session.updated' });
    sockets[0].emit({ type: 'input_audio_buffer.speech_started' });
    const adopted = registry.adopt(session.id, 'rtc_boot_1');
    expect(adopted?.buffered.map((raw) => (JSON.parse(raw) as { type: string }).type))
      .toEqual(['session.updated', 'input_audio_buffer.speech_started']);
    // Adoption is single-shot.
    expect(registry.adopt(session.id, 'rtc_boot_1')).toBeNull();
  });

  it('does not adopt a stale stash for a different call id', async () => {
    const { session, registry, deps } = makeDeps();
    await bootstrapVoiceCall(deps, { sessionId: session.id, offerSdp: 'v=0\noffer' });
    expect(registry.adopt(session.id, 'rtc_other')).toBeNull();
  });

  it('rejects unknown and ended sessions without touching the provider', async () => {
    const { repo, session, deps } = makeDeps();
    let called = 0;
    deps.fetchImpl = (async () => { called += 1; return new Response('x', { status: 500 }); }) as typeof fetch;
    expect(await bootstrapVoiceCall(deps, { sessionId: 'missing', offerSdp: 'v=0' }))
      .toEqual({ ok: false, status: 404, error: 'Unknown session.' });
    repo.endSession(session.id, null);
    expect(await bootstrapVoiceCall(deps, { sessionId: session.id, offerSdp: 'v=0' }))
      .toEqual({ ok: false, status: 409, error: 'This lesson has ended and is read-only.' });
    expect(called).toBe(0);
  });

  it('fails closed when the sideband cannot be opened and configured', async () => {
    const { repo, session, deps, sockets } = makeDeps();
    deps.createUpstream = (url: string) => {
      const socket = new FakeSideband(url);
      sockets.push(socket);
      queueMicrotask(() => socket.close());
      return socket as never;
    };
    const result = await bootstrapVoiceCall(deps, { sessionId: session.id, offerSdp: 'v=0\noffer' });
    expect(result).toEqual({ ok: false, status: 502, error: 'The voice control channel could not be attached.' });
    // The call id stays persisted so a later envelope connection may retry
    // attaching to the same call.
    expect(await latestVoiceCallId(repo, session.id)).toBe('rtc_boot_1');
  });

  it('surfaces provider call failure as a bad-gateway error', async () => {
    const { session, deps } = makeDeps();
    deps.fetchImpl = (async () => new Response('nope', { status: 400 })) as typeof fetch;
    const result = await bootstrapVoiceCall(deps, { sessionId: session.id, offerSdp: 'v=0\noffer' });
    expect(result).toEqual({ ok: false, status: 502, error: 'The voice call could not be created.' });
  });
});
