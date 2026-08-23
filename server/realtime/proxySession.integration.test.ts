/// <reference lib="dom" />

import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeEvent, type RuntimeEventEnvelope } from '../../shared/runtimeProtocol';
import { RealtimeSession } from '../../src/lesson/realtimeSession';
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
  audioOut: {
    speaking: boolean;
    append(responseId: string): void;
    currentEnergy(): number;
    playedSamples(responseId: string): number;
    stop(): never[];
    close(): Promise<void>;
  };
  handleServer(raw: unknown): void;
  releasePending(): void;
  connectionEpoch: number;
  cancelGeneration(reason: string): void;
  activateScope(advanceGeneration: boolean): void;
}

type RawStep = 'audio-small' | 'audio-rest' | 'text-a' | 'text-b' | 'board-tool' | 'state-tool' | 'transcript-done' | 'audio-done';

const orderings: Array<{ name: string; steps: RawStep[] }> = [
  {
    name: 'normal interleaving',
    steps: ['audio-small', 'text-a', 'audio-rest', 'text-b', 'board-tool', 'state-tool', 'transcript-done', 'audio-done'],
  },
  {
    name: 'transcript before audio with tools before PCM',
    steps: ['text-a', 'text-b', 'board-tool', 'state-tool', 'transcript-done', 'audio-small', 'audio-rest', 'audio-done'],
  },
  {
    name: 'audio before transcript with tools after PCM',
    steps: ['audio-small', 'audio-rest', 'audio-done', 'text-a', 'text-b', 'board-tool', 'state-tool', 'transcript-done'],
  },
  {
    name: 'multiple pending repeated phrases across a no-audio thinking gap',
    steps: ['text-a', 'text-b', 'board-tool', 'audio-small', 'state-tool', 'audio-rest', 'transcript-done', 'audio-done'],
  },
  {
    name: 'transcript done before audio done',
    steps: ['audio-small', 'text-a', 'audio-rest', 'text-b', 'state-tool', 'board-tool', 'transcript-done', 'audio-done'],
  },
  {
    name: 'audio done before transcript done',
    steps: ['audio-small', 'text-a', 'audio-rest', 'text-b', 'state-tool', 'board-tool', 'audio-done', 'transcript-done'],
  },
];

afterEach(() => vi.unstubAllGlobals());

describe('raw Realtime proxy to heard-sample session integration', () => {
  it.each(orderings)('$name releases every cue only at its derived heard-sample boundary', async ({ steps }) => {
    const harness = await createHarness();
    emitResponse(harness.upstream, 'response-matrix', steps);
    await flushProxy();
    harness.deliverProxyEnvelopes();

    const cueEnvelopes = harness.client.sent.filter((event) =>
      ['transcript_delta', 'transcript_done', 'board_ops', 'lesson_state'].includes(event.type));
    const deltas = cueEnvelopes.filter((event) => event.type === 'transcript_delta');
    expect(deltas).toHaveLength(2);
    const firstBoundary = deltas[0].audioSampleOffsets?.end ?? 0;
    expect(firstBoundary).toBeGreaterThan(480);
    expect(deltas[1].audioSampleOffsets?.end).toBe(24_000);
    for (const event of cueEnvelopes.filter((candidate) => candidate.type !== 'transcript_delta')) {
      expect(event.audioSampleOffsets?.end).toBe(24_000);
    }

    harness.setPlayed('response-matrix', 480);
    harness.release();
    expect(harness.session.getSnapshot().captions).toEqual([]);
    expect(harness.session.getSnapshot().lessonState).toEqual({});
    expect(harness.boardReleases).toEqual([]);

    harness.setPlayed('response-matrix', firstBoundary - 1);
    harness.release();
    expect(harness.session.getSnapshot().captions).toEqual([]);

    harness.setPlayed('response-matrix', firstBoundary);
    harness.release();
    expect(harness.session.getSnapshot().captions.map((caption) => caption.text)).toEqual(['Repeated phrase.']);

    harness.setPlayed('response-matrix', 23_999);
    harness.release();
    expect(harness.boardReleases).toEqual([]);
    expect(harness.session.getSnapshot().lessonState).toEqual({});
    expect(harness.session.getSnapshot().captions.map((caption) => caption.text)).toEqual(['Repeated phrase.']);

    harness.setPlayed('response-matrix', 24_000);
    harness.release();
    await vi.waitFor(() => expect(harness.boardReleases).toHaveLength(1));
    expect(harness.session.getSnapshot().lessonState).toMatchObject({
      activeConcept: 'fraction comparison',
      characterAttentionTarget: 'learner',
    });
    expect(harness.session.getSnapshot().captions.map((caption) => caption.text)).toEqual([
      'Repeated phrase.',
      'Repeated phrase later?',
    ]);
    harness.session.end();
  });

  it('drops raw cancelled responses and completed old-identity cues after interruption', async () => {
    const cancelled = await createHarness();
    emitResponse(cancelled.upstream, 'cancelled-response', ['text-a', 'audio-small', 'audio-rest', 'board-tool', 'state-tool'], 'cancelled');
    await flushProxy();
    cancelled.deliverProxyEnvelopes();
    cancelled.setPlayed('cancelled-response', 24_000);
    cancelled.release();
    expect(cancelled.client.sent.filter((event) => ['transcript_delta', 'transcript_done', 'board_ops', 'lesson_state'].includes(event.type))).toEqual([]);
    expect(cancelled.session.getSnapshot().captions).toEqual([]);
    expect(cancelled.boardReleases).toEqual([]);
    cancelled.session.end();

    const interrupted = await createHarness();
    interrupted.upstream.emit({ type: 'response.created', response: { id: 'old-response' } });
    for (const step of ['text-a', 'text-b', 'audio-small', 'audio-rest', 'board-tool', 'state-tool'] as RawStep[]) {
      emitStep(interrupted.upstream, 'old-response', step);
    }
    await flushProxy();
    interrupted.deliverProxyEnvelopes();
    const oldIdentity = interrupted.session.getIdentity();
    interrupted.upstream.emit({ type: 'input_audio_buffer.speech_started' });
    await flushProxy();
    interrupted.deliverProxyEnvelopes();
    expect(interrupted.session.getIdentity()).not.toEqual(oldIdentity);

    for (const step of ['transcript-done', 'audio-done'] as RawStep[]) emitStep(interrupted.upstream, 'old-response', step);
    interrupted.upstream.emit({ type: 'response.done', response: { id: 'old-response', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();
    interrupted.deliverProxyEnvelopes();
    interrupted.setPlayed('old-response', 24_000);
    interrupted.release();
    expect(interrupted.session.getSnapshot().captions).toEqual([]);
    expect(interrupted.session.getSnapshot().lessonState).toEqual({});
    expect(interrupted.boardReleases).toEqual([]);
    interrupted.session.end();
  });

  it('rejects pending and replayed stale envelopes after reconnect identity replacement and navigation', async () => {
    const harness = await createHarness();
    emitResponse(harness.upstream, 'before-reconnect', orderings[0].steps);
    await flushProxy();
    harness.deliverProxyEnvelopes();
    const staleEnvelopes = harness.client.sent.slice();

    harness.replaceForReconnect();
    await flushProxy();
    harness.setPlayed('before-reconnect', 24_000);
    harness.release();
    for (const envelope of staleEnvelopes) harness.deliverDirect(envelope);
    harness.release();
    expect(harness.session.getSnapshot().captions).toEqual([]);
    expect(harness.session.getSnapshot().lessonState).toEqual({});
    expect(harness.boardReleases).toEqual([]);

    emitResponse(harness.upstream, 'before-navigation', orderings[2].steps);
    await flushProxy();
    harness.deliverProxyEnvelopes();
    harness.session.end();
    harness.setPlayed('before-navigation', 24_000);
    harness.release();
    expect(harness.session.getSnapshot().phase).toBe('ended');
    expect(harness.session.getSnapshot().captions).toEqual([]);
    expect(harness.boardReleases).toEqual([]);
  });
});

async function createHarness() {
  vi.stubGlobal('WebSocket', FakeUpstream);
  const repo = new Repo(openTestDb());
  const child = repo.createChild('Maya', 10);
  const storedSession = repo.createSession(child.id, 'fractions');
  const client = new FakeClient();
  const session = new RealtimeSession(storedSession.id);
  const internals = session as unknown as SessionInternals;
  const played = new Map<string, number>();
  const boardReleases: string[] = [];
  let delivered = 0;
  internals.audioOut = {
    speaking: true,
    append: () => {},
    currentEnergy: () => 0,
    playedSamples: (responseId) => played.get(responseId) ?? 0,
    stop: () => [],
    close: async () => {},
  };
  session.onBoardOps = async (_ops, _animate, _identity, cue) => {
    boardReleases.push(cue?.semanticObjectId ?? 'board');
    return true;
  };
  await connectRealtimeProxy(client as never, {
    apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: storedSession.id,
  });
  client.emit('message', JSON.stringify(createRuntimeEvent(session.getIdentity(), 0, 'hello', {})));

  return {
    client,
    session,
    upstream: FakeUpstream.latest,
    boardReleases,
    setPlayed(responseId: string, samples: number) { played.set(responseId, samples); },
    release() { internals.releasePending(); },
    deliverDirect(envelope: RuntimeEventEnvelope<Record<string, unknown>>) { internals.handleServer(envelope); },
    deliverProxyEnvelopes() {
      for (const envelope of client.sent.slice(delivered)) internals.handleServer(envelope);
      delivered = client.sent.length;
    },
    replaceForReconnect() {
      internals.cancelGeneration('transport closed');
      internals.connectionEpoch += 1;
      internals.activateScope(false);
      client.emit('message', JSON.stringify(createRuntimeEvent(session.getIdentity(), 0, 'hello', {})));
    },
  };
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
  if (step === 'audio-small') upstream.emit({
    type: 'response.output_audio.delta', response_id: responseId, item_id: itemId,
    delta: Buffer.alloc(480 * 2).toString('base64'),
  });
  if (step === 'audio-rest') upstream.emit({
    type: 'response.output_audio.delta', response_id: responseId, item_id: itemId,
    delta: Buffer.alloc(23_520 * 2).toString('base64'),
  });
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
  if (step === 'audio-done') upstream.emit({ type: 'response.output_audio.done', response_id: responseId });
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
