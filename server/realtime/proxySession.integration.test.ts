/// <reference lib="dom" />

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEventEnvelope } from '../../shared/runtimeProtocol';
import { RealtimeSession } from '../../src/lesson/realtimeSession';
import { FakeVoiceTransport } from '../../src/lesson/fakeVoiceTransport';
import { openTestDb } from '../store/db';
import { Repo } from '../store/repo';
import { connectRealtimeProxy } from './proxy';

class FakeUpstream {
  static OPEN = 1;
  static latest: FakeUpstream;
  readyState = FakeUpstream.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor() { FakeUpstream.latest = this; }
  send(raw: string) { this.sent.push(raw); }
  close() { this.readyState = 3; }
  emit(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

class FakeClient extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  sent: RuntimeEventEnvelope<Record<string, unknown>>[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw) as RuntimeEventEnvelope<Record<string, unknown>>); }
  close() { this.readyState = 3; }
}

interface SessionInternals {
  ws: { readyState: number; send(raw: string): void; close?(): void } | null;
  handleServer(raw: unknown): void;
  handleMicEnergy(rms: number): void;
  releasePending(): void;
  connectionEpoch: number;
  cancelGeneration(reason: string): void;
  activateScope(advanceGeneration: boolean): void;
  connectVoice(): Promise<void>;
  send(type: string, payload: Record<string, unknown>): void;
}

type RawStep = 'text-a' | 'text-b' | 'board-tool' | 'state-tool' | 'transcript-done';

const orderings: Array<{ name: string; steps: RawStep[] }> = [
  {
    name: 'normal interleaving',
    steps: ['text-a', 'text-b', 'board-tool', 'state-tool', 'transcript-done'],
  },
  {
    name: 'tools before any transcript',
    steps: ['board-tool', 'state-tool', 'text-a', 'text-b', 'transcript-done'],
  },
  {
    name: 'tools after the whole transcript',
    steps: ['text-a', 'text-b', 'transcript-done', 'board-tool', 'state-tool'],
  },
  {
    name: 'tools interleaved mid-transcript',
    steps: ['text-a', 'board-tool', 'text-b', 'state-tool', 'transcript-done'],
  },
];

afterEach(() => vi.unstubAllGlobals());

describe('raw Realtime sideband to playback-bound session integration', () => {
  it.each(orderings)('$name streams captions live and binds visuals/state/task to the playback boundary', async ({ steps }) => {
    const harness = await createHarness();
    harness.voice.emitBoundary('started', 'response-matrix');
    emitResponse(harness.upstream, 'response-matrix', steps);
    await harness.pump();

    // Every playback-bound cue is tagged with the provider response so the
    // client can bind it to the audible call; nothing carries sample offsets.
    const cueEnvelopes = harness.client.sent.filter((event) =>
      ['transcript_delta', 'transcript_done', 'board_ops', 'lesson_state'].includes(event.type));
    expect(cueEnvelopes.length).toBeGreaterThanOrEqual(4);
    for (const envelope of cueEnvelopes) {
      expect(envelope.providerResponseId).toBe('response-matrix');
      expect('audioSampleOffsets' in envelope).toBe(false);
    }

    // Captions and ordinary board marks are live on arrival; lesson state
    // waits for the child to finish hearing the response.
    expect(harness.session.getSnapshot().captions.map((caption) => caption.text)).toEqual(['Repeated phrase.']);
    expect(harness.session.getSnapshot().lessonState).toEqual({});
    expect(harness.boardReleases).toEqual(['freeform-turn-0']);

    harness.voice.emitBoundary('stopped', 'response-matrix', 1_500);
    await vi.waitFor(() => expect(harness.session.getSnapshot().lessonState).toMatchObject({
      activeConcept: 'fraction comparison',
    }));
    expect(harness.session.getSnapshot().lessonState).toMatchObject({
      activeConcept: 'fraction comparison',
      characterAttentionTarget: 'learner',
    });
    expect(harness.session.getSnapshot().captions.map((caption) => caption.text)).toEqual([
      'Repeated phrase.',
      'Repeated phrase later?',
    ]);

    // The client relayed the heard duration for the server's audio telemetry.
    await harness.pump();
    const boundaries = harness.clientToServerMessages().filter((event) => event.type === 'playback_boundary');
    expect(boundaries.map((event) => event.payload)).toEqual([
      { response_id: 'response-matrix', boundary: 'stopped', playedMs: 1_500 },
    ]);
    harness.session.end();
  });

  it('drops late events for a cancelled response and everything from an interrupted identity', async () => {
    const cancelled = await createHarness();
    cancelled.upstream.emit({ type: 'response.created', response: { id: 'cancelled-response' } });
    cancelled.upstream.emit({ type: 'response.done', response: { id: 'cancelled-response', status: 'cancelled', output: [] } });
    for (const step of ['text-a', 'text-b', 'transcript-done'] as RawStep[]) {
      emitStep(cancelled.upstream, 'cancelled-response', step);
    }
    await cancelled.pump();
    expect(cancelled.client.sent.filter((event) =>
      ['transcript_delta', 'transcript_done'].includes(event.type))).toEqual([]);
    expect(cancelled.session.getSnapshot().captions).toEqual([]);
    cancelled.session.end();

    const interrupted = await createHarness();
    interrupted.voice.emitBoundary('started', 'old-response');
    interrupted.voice.advancePlayback(900);
    interrupted.upstream.emit({ type: 'response.created', response: { id: 'old-response' } });
    emitStep(interrupted.upstream, 'old-response', 'text-a');
    await interrupted.pump();
    expect(interrupted.session.getSnapshot().captions.map((caption) => caption.text)).toEqual(['Repeated phrase.']);
    const oldIdentity = interrupted.session.getIdentity();

    // Dual-confirmed barge-in: provider speech start plus sustained local energy.
    interrupted.upstream.emit({ type: 'input_audio_buffer.speech_started' });
    await interrupted.pump();
    for (let frame = 0; frame < 7; frame += 1) internalsFor(interrupted.session).handleMicEnergy(0.09);
    expect(interrupted.session.getIdentity()).not.toEqual(oldIdentity);
    expect(interrupted.voice.playbackClears).toBe(1);

    // Whatever straggles in for the interrupted response reaches nobody:
    // the server has cancelled it and the client identity has moved on.
    for (const step of ['text-b', 'board-tool', 'state-tool', 'transcript-done'] as RawStep[]) {
      emitStep(interrupted.upstream, 'old-response', step);
    }
    interrupted.upstream.emit({ type: 'response.done', response: { id: 'old-response', status: 'cancelled', output: [] } });
    await interrupted.pump();
    interrupted.voice.emitBoundary('stopped', 'old-response', 900);
    expect(interrupted.session.getSnapshot().captions.map((caption) => caption.text)).toEqual(['Repeated phrase.']);
    expect(interrupted.session.getSnapshot().lessonState).toEqual({});
    expect(interrupted.boardReleases).toEqual([]);
    interrupted.session.end();
  });

  it('rejects stale envelopes after reconnect identity replacement and stays inert after end', async () => {
    const harness = await createHarness();
    harness.voice.emitBoundary('started', 'before-reconnect');
    emitResponse(harness.upstream, 'before-reconnect', orderings[0].steps);
    await flushProxy();
    const staleEnvelopes = harness.client.sent.slice();
    harness.markDelivered();

    const releasedBeforeReconnect = harness.boardReleases.length;
    harness.replaceForReconnect();
    await flushProxy();
    for (const envelope of staleEnvelopes) harness.deliverDirect(envelope);
    harness.voice.emitBoundary('stopped', 'before-reconnect', 1_000);
    expect(harness.session.getSnapshot().captions).toEqual([]);
    expect(harness.session.getSnapshot().lessonState).toEqual({});
    expect(harness.boardReleases).toHaveLength(releasedBeforeReconnect);

    // The reconnected identity keeps working over the same voice call.
    harness.voice.emitBoundary('started', 'after-reconnect');
    emitResponse(harness.upstream, 'after-reconnect', orderings[0].steps);
    await harness.pump();
    expect(harness.session.getSnapshot().captions.map((caption) => caption.text)).toEqual(['Repeated phrase.']);
    expect(harness.boardReleases.length).toBeGreaterThan(releasedBeforeReconnect);

    harness.session.end();
    harness.voice.emitBoundary('stopped', 'after-reconnect', 500);
    expect(harness.session.getSnapshot().phase).toBe('ended');
  });
});

async function createHarness() {
  vi.stubGlobal('WebSocket', FakeUpstream);
  const repo = new Repo(openTestDb());
  const child = repo.createChild('Maya', 10);
  const storedSession = repo.createSession(child.id, 'fractions');
  window.sessionStorage.setItem(`noura.lessonCapability.${storedSession.id}`, 'offline-capability');
  const client = new FakeClient();
  let voice!: FakeVoiceTransport;
  const session = new RealtimeSession(storedSession.id, (input) => {
    voice = new FakeVoiceTransport(input.handlers);
    return voice;
  });
  const internals = session as unknown as SessionInternals;
  void internals.connectVoice();
  const boardReleases: string[] = [];
  let delivered = 0;
  session.onBoardOps = async (_ops, _animate, _identity, cue) => {
    boardReleases.push(cue?.semanticObjectId ?? 'board');
    return true;
  };
  await connectRealtimeProxy(client as never, {
    apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: storedSession.id,
    createUpstream: () => new FakeUpstream() as never,
  });
  // The session's outbound envelope path loops straight into the proxy, so
  // ops_shown acknowledgements and playback boundaries reach the server.
  const sentToServer: Array<{ type: string; payload: Record<string, unknown> }> = [];
  internals.ws = {
    readyState: 1,
    send: (raw) => {
      sentToServer.push(JSON.parse(raw) as { type: string; payload: Record<string, unknown> });
      void client.emit('message', raw);
    },
    close: () => {},
  };
  internals.send('hello', {});

  function deliverProxyEnvelopes(): void {
    for (const envelope of client.sent.slice(delivered)) internals.handleServer(envelope);
    delivered = client.sent.length;
  }

  return {
    client,
    session,
    voice,
    upstream: FakeUpstream.latest,
    boardReleases,
    deliverDirect(envelope: RuntimeEventEnvelope<Record<string, unknown>>) { internals.handleServer(envelope); },
    markDelivered() { delivered = client.sent.length; },
    /** Runs the client↔server loop until both sides go quiet. */
    async pump(): Promise<void> {
      for (let round = 0; round < 6; round += 1) {
        await flushProxy();
        deliverProxyEnvelopes();
      }
    },
    /** Envelopes the browser sent to the server (parsed off the loop). */
    clientToServerMessages(): Array<{ type: string; payload: Record<string, unknown> }> {
      return sentToServer;
    },
    replaceForReconnect() {
      internals.cancelGeneration('transport closed');
      internals.connectionEpoch += 1;
      internals.activateScope(false);
      internals.send('hello', {});
    },
  };
}

function internalsFor(session: RealtimeSession): SessionInternals {
  return session as unknown as SessionInternals;
}

function flushProxy(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function emitResponse(upstream: FakeUpstream, responseId: string, steps: RawStep[], status = 'completed') {
  upstream.emit({ type: 'response.created', response: { id: responseId } });
  for (const step of steps) emitStep(upstream, responseId, step);
  upstream.emit({ type: 'response.done', response: { id: responseId, status, output: [{ type: 'function_call' }] } });
}

function emitStep(upstream: FakeUpstream, responseId: string, step: RawStep) {
  const itemId = `item-${responseId}`;
  if (step === 'text-a') upstream.emit({
    type: 'response.output_audio_transcript.delta', response_id: responseId, item_id: itemId, delta: 'Repeated phrase. ',
  });
  if (step === 'text-b') upstream.emit({
    type: 'response.output_audio_transcript.delta', response_id: responseId, item_id: itemId, delta: 'Repeated phrase later?',
  });
  if (step === 'transcript-done') upstream.emit({
    type: 'response.output_audio_transcript.done', response_id: responseId,
    transcript: 'Repeated phrase. Repeated phrase later?',
  });
  if (step === 'board-tool') upstream.emit({
    type: 'response.function_call_arguments.done', response_id: responseId, call_id: `board-${responseId}`,
    name: 'board_ops', arguments: JSON.stringify({
      ops: [{ op: 'add', id: `label-${responseId}`, spec: { kind: 'text', at: [100, 100], text: 'Repeated phrase marker' } }],
    }),
  });
  if (step === 'state-tool') upstream.emit({
    type: 'response.function_call_arguments.done', response_id: responseId, call_id: `state-${responseId}`,
    name: 'propose_teaching_move', arguments: JSON.stringify({
      rationale: 'offline integration fixture', microObjective: 'fraction comparison', strategy: 'shared scale',
      childFacingText: 'Compare the marks.', questionOrTask: 'Which is farther right?', taskId: 'matrix-task',
      proposedAction: 'question', semanticObjectId: 'fraction-scale',
    }),
  });
}
