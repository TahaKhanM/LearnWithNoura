import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeEvent, type GenerationIdentity, type RuntimeEventEnvelope } from '../../shared/runtimeProtocol';
import { openTestDb } from '../store/db';
import { Repo } from '../store/repo';
import { connectRealtimeProxy } from './proxy';

class FakeUpstream {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  static latest: FakeUpstream;
  constructor() { FakeUpstream.latest = this; }
  send(raw: string) { this.sent.push(raw); }
  close() { this.readyState = 3; }
  emit(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

class FakeClient extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: RuntimeEventEnvelope<Record<string, unknown>>[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw) as RuntimeEventEnvelope<Record<string, unknown>>); }
  close() { this.readyState = 3; }
}

const identity: GenerationIdentity = { sessionId: 'placeholder', connectionEpoch: 1, turnId: 'turn-1', generationId: 'generation-1' };

afterEach(() => vi.unstubAllGlobals());

describe('realtime proxy response annotation', () => {
  it('maps raw transcript-before-audio events across the complete PCM segment', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));

    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'response.created', response: { id: 'response-1' } });
    upstream.emit({ type: 'response.output_audio_transcript.delta', response_id: 'response-1', item_id: 'item-1', delta: 'First phrase. ' });
    upstream.emit({ type: 'response.output_audio_transcript.delta', response_id: 'response-1', item_id: 'item-1', delta: 'Future phrase?' });
    upstream.emit({ type: 'response.output_audio.delta', response_id: 'response-1', item_id: 'item-1', delta: Buffer.alloc(480 * 2).toString('base64') });
    await flushProxy();
    expect(client.sent.filter((event) => event.type === 'transcript_delta')).toEqual([]);
    upstream.emit({ type: 'response.output_audio.delta', response_id: 'response-1', item_id: 'item-1', delta: Buffer.alloc(23_520 * 2).toString('base64') });
    upstream.emit({ type: 'response.output_audio.done', response_id: 'response-1' });
    upstream.emit({ type: 'response.output_audio_transcript.done', response_id: 'response-1', transcript: 'First phrase. Future phrase?' });
    upstream.emit({ type: 'response.done', response: { id: 'response-1', status: 'completed', output: [] } });
    await flushProxy();

    const deltas = client.sent.filter((event) => event.type === 'transcript_delta');
    expect(deltas).toHaveLength(2);
    expect(deltas[0].audioSampleOffsets?.end).toBeGreaterThan(480);
    expect(deltas[1].audioSampleOffsets?.end).toBe(24_000);
    const final = client.sent.find((event) => event.type === 'transcript_done');
    expect(final?.audioSampleOffsets).toEqual({ start: 0, end: 24_000 });
  });

  it('drops sealed cues for an interrupted/cancelled response identity', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id });
    client.emit('message', JSON.stringify(createRuntimeEvent({ ...identity, sessionId: session.id }, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'response.created', response: { id: 'cancelled' } });
    upstream.emit({ type: 'response.output_audio_transcript.delta', response_id: 'cancelled', delta: 'Never heard.' });
    upstream.emit({ type: 'response.output_audio.delta', response_id: 'cancelled', item_id: 'item', delta: Buffer.alloc(2_400 * 2).toString('base64') });
    upstream.emit({ type: 'response.done', response: { id: 'cancelled', status: 'cancelled', output: [] } });
    await flushProxy();
    expect(client.sent.filter((event) => ['transcript_delta', 'transcript_done', 'board_ops', 'lesson_state'].includes(event.type))).toEqual([]);
  });

  it('holds character/lesson semantic cues to the segment boundary whether tools arrive before or after audio', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id });
    client.emit('message', JSON.stringify(createRuntimeEvent({ ...identity, sessionId: session.id }, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    const move = JSON.stringify({
      rationale: 'fixture', microObjective: 'fraction comparison', strategy: 'shared scale', childFacingText: 'Compare the marks.',
      questionOrTask: 'Which is farther right?', taskId: 'task', proposedAction: 'question', semanticObjectId: 'fraction-scale',
    });
    let currentResponse = 'tool-first';
    const audio = () => upstream.emit({ type: 'response.output_audio.delta', response_id: currentResponse, item_id: 'item', delta: Buffer.alloc(2_400 * 2).toString('base64') });
    upstream.emit({ type: 'response.created', response: { id: currentResponse } });
    upstream.emit({ type: 'response.function_call_arguments.done', response_id: currentResponse, call_id: 'call-1', name: 'propose_teaching_move', arguments: move });
    await flushProxy();
    expect(client.sent.filter((event) => event.type === 'lesson_state')).toEqual([]);
    audio();
    upstream.emit({ type: 'response.done', response: { id: currentResponse, status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();

    currentResponse = 'audio-first';
    upstream.emit({ type: 'response.created', response: { id: currentResponse } });
    audio();
    upstream.emit({ type: 'response.function_call_arguments.done', response_id: currentResponse, call_id: 'call-2', name: 'propose_teaching_move', arguments: move });
    upstream.emit({ type: 'response.done', response: { id: currentResponse, status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();

    const states = client.sent.filter((event) => event.type === 'lesson_state');
    expect(states).toHaveLength(2);
    expect(states.map((event) => event.audioSampleOffsets)).toEqual([
      { start: 2_400, end: 2_400 },
      { start: 2_400, end: 2_400 },
    ]);
  });
});

function flushProxy(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
