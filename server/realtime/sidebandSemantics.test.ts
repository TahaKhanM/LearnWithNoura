import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createRuntimeEvent, type GenerationIdentity, type RuntimeEventEnvelope } from '../../shared/runtimeProtocol';
import { openTestDb } from '../store/db';
import { Repo } from '../store/repo';
import { connectRealtimeProxy } from './proxy';

/**
 * Phase 1 sideband semantics: audio lives on the browser ↔ provider WebRTC
 * media plane, so the envelope carries no PCM in either direction. Captions
 * relay as transcript deltas on arrival; visuals and tasks are tagged with
 * their response and bound to playback boundaries by the client.
 */

class FakeUpstream {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  static latest: FakeUpstream;
  constructor() { FakeUpstream.latest = this; }
  send(raw: string) { this.sent.push(raw); }
  close() { this.readyState = 3; }
  emit(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
  sentOfType(type: string): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>).filter((event) => event.type === type);
  }
}

class FakeClient extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: RuntimeEventEnvelope<Record<string, unknown>>[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw) as RuntimeEventEnvelope<Record<string, unknown>>); }
  close() { this.readyState = 3; }
}

const identity: GenerationIdentity = { sessionId: 'placeholder', connectionEpoch: 1, turnId: 'turn-1', generationId: 'generation-1' };

async function connect(goal = 'fractions') {
  vi.stubGlobal('WebSocket', FakeUpstream);
  const repo = new Repo(openTestDb());
  const child = repo.createChild('Maya', 10);
  const session = repo.createSession(child.id, goal);
  const client = new FakeClient();
  await connectRealtimeProxy(client as never, {
    apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id,
    createUpstream: () => new FakeUpstream() as never,
  });
  const active = { ...identity, sessionId: session.id };
  client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
  return { repo, session, client, upstream: FakeUpstream.latest, active };
}

async function flushProxy(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('sideband event semantics', () => {
  it('relays transcript deltas to the client on arrival, without sample offsets', async () => {
    const { client, upstream } = await connect();
    upstream.emit({ type: 'response.created', response: { id: 'reply-1' } });
    upstream.emit({ type: 'response.output_audio_transcript.delta', response_id: 'reply-1', item_id: 'item-1', delta: 'One half ' });
    upstream.emit({ type: 'response.output_audio_transcript.delta', response_id: 'reply-1', item_id: 'item-1', delta: 'is bigger.' });
    await flushProxy();
    const deltas = client.sent.filter((event) => event.type === 'transcript_delta');
    expect(deltas.map((event) => (event.payload as { delta: string }).delta)).toEqual(['One half ', 'is bigger.']);
    expect(deltas.every((event) => event.providerResponseId === 'reply-1')).toBe(true);
    expect(deltas.every((event) => !('audioSampleOffsets' in event))).toBe(true);

    upstream.emit({ type: 'response.output_audio_transcript.done', response_id: 'reply-1', transcript: 'One half is bigger.' });
    await flushProxy();
    const done = client.sent.find((event) => event.type === 'transcript_done');
    expect(done?.payload).toMatchObject({ response_id: 'reply-1', text: 'One half is bigger.' });
  });

  it('carries no audio in either direction', async () => {
    const { client, upstream, active } = await connect();
    upstream.emit({ type: 'response.created', response: { id: 'reply-audio' } });
    upstream.emit({ type: 'response.output_audio.delta', response_id: 'reply-audio', item_id: 'item-a', delta: 'AAAA' });
    upstream.emit({ type: 'response.output_audio.done', response_id: 'reply-audio' });
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'input_audio', { audio: 'AAAA' })));
    await flushProxy();
    expect(client.sent.filter((event) => ['audio', 'audio_done'].includes(event.type))).toEqual([]);
    expect(upstream.sentOfType('input_audio_buffer.append')).toEqual([]);
  });

  it('interrupt cancels the response and truncates the heard item at the client-reported playback position', async () => {
    const { repo, session, client, upstream, active } = await connect();
    upstream.emit({ type: 'response.created', response: { id: 'reply-cut' } });
    upstream.emit({ type: 'response.output_audio_transcript.delta', response_id: 'reply-cut', item_id: 'item-cut', delta: 'Long explanation…' });
    await flushProxy();
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'interrupt', { reason: 'voice', heardMs: 1234.7 })));
    await flushProxy();
    expect(upstream.sentOfType('response.cancel')).toHaveLength(1);
    expect(upstream.sentOfType('conversation.item.truncate')).toEqual([
      expect.objectContaining({ item_id: 'item-cut', content_index: 0, audio_end_ms: 1234 }),
    ]);
    expect(repo.listEvents(session.id).some((event) =>
      event.type === 'interrupted' && (event.payload as { audio_end_ms?: number }).audio_end_ms === 1234)).toBe(true);
  });

  it('raises endpointing eagerness when a delivered task expects a voice answer and relaxes it for drawing', async () => {
    const { upstream } = await connect();
    // Draw task: eagerness stays medium (no eagerness change is sent).
    upstream.emit({ type: 'response.created', response: { id: 'draw-task-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'draw-task-response', call_id: 'move-draw', name: 'propose_teaching_move',
      arguments: JSON.stringify({
        rationale: 'The learner should mark the diagram.', microObjective: 'recognize acute angles',
        strategy: 'have the learner mark the diagram', childFacingText: 'Circle the acute angle.',
        questionOrTask: 'Circle the acute angle.', taskId: 'circle-acute', responseMode: 'draw', proposedAction: 'question',
      }),
    });
    await flushProxy();
    upstream.emit({ type: 'response.output_audio_transcript.done', response_id: 'draw-task-response', transcript: 'Circle the acute angle.' });
    upstream.emit({ type: 'response.done', response: { id: 'draw-task-response', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();
    const eagernessUpdates = () => upstream.sent
      .map((raw) => JSON.parse(raw) as { type: string; session?: { audio?: { input?: { turn_detection?: { eagerness?: string } } } } })
      .map((event) => event.session?.audio?.input?.turn_detection?.eagerness)
      .filter((value): value is string => typeof value === 'string');
    expect(eagernessUpdates().filter((value) => value === 'high')).toHaveLength(0);

    // Voice task: the child is expected to answer briefly — endpoint eagerly.
    upstream.emit({ type: 'response.created', response: { id: 'voice-task-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'voice-task-response', call_id: 'move-voice', name: 'propose_teaching_move',
      arguments: JSON.stringify({
        rationale: 'A quick verbal check keeps momentum.', microObjective: 'compare fractions',
        strategy: 'ask which is larger', childFacingText: 'Which is larger?',
        questionOrTask: 'Which is larger?', taskId: 'which-larger', responseMode: 'voice', proposedAction: 'question',
      }),
    });
    await flushProxy();
    upstream.emit({ type: 'response.output_audio_transcript.done', response_id: 'voice-task-response', transcript: 'Which is larger?' });
    upstream.emit({ type: 'response.done', response: { id: 'voice-task-response', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();
    expect(eagernessUpdates().at(-1)).toBe('high');
  });

  it('records tutor audio duration once from the trusted client playback boundary', async () => {
    const { repo, session, client, upstream, active } = await connect();
    upstream.emit({ type: 'response.created', response: { id: 'played-response' } });
    await flushProxy();
    const boundary = (sequence: number, payload: Record<string, unknown>) =>
      client.emit('message', JSON.stringify(createRuntimeEvent(active, sequence, 'playback_boundary', payload, {
        providerResponseId: String(payload.response_id ?? ''),
      })));
    boundary(1, { response_id: 'played-response', boundary: 'started' });
    boundary(2, { response_id: 'played-response', boundary: 'stopped', playedMs: 4321.9 });
    // Duplicates and unknown responses are ignored.
    boundary(3, { response_id: 'played-response', boundary: 'stopped', playedMs: 9999 });
    boundary(4, { response_id: 'unknown-response', boundary: 'stopped', playedMs: 1 });
    await flushProxy();
    const durations = repo.listEvents(session.id)
      .map((event) => event.payload as { name?: string; value?: number; providerResponseId?: string })
      .filter((payload) => payload.name === 'tutor_audio_output_duration');
    expect(durations).toHaveLength(1);
    expect(durations[0].value).toBe(4322);
  });

  it('sends board cues immediately, tagged for playback binding, and releases them only on ops_shown', async () => {
    const { repo, session, client, upstream, active } = await connect();
    upstream.emit({ type: 'response.created', response: { id: 'visual-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'visual-response', call_id: 'ops-call', name: 'board_ops',
      arguments: JSON.stringify({ ops: [{ op: 'add', id: 'shown-line', spec: { kind: 'line', from: [100, 100], to: [300, 300] } }] }),
    });
    await flushProxy();
    // The cue reached the client before the response finished, carrying the
    // response correlation the client needs to bind to playback boundaries.
    const cue = client.sent.find((event) => event.type === 'board_ops');
    expect(cue).toBeDefined();
    expect(cue?.providerResponseId).toBe('visual-response');
    expect(cue ? 'audioSampleOffsets' in cue : true).toBe(false);
    const eventId = (cue?.payload as { event_id?: number } | undefined)?.event_id;
    expect(typeof eventId).toBe('number');
    // Released-only replay: the checkpoint joins the durable board only once
    // the browser confirms the marks are actually on screen.
    const releasedOps = () => repo.listEvents(session.id)
      .filter((event) => event.type === 'board_ops' && event.released).length;
    expect(releasedOps()).toBe(0);
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'ops_presented', { event_id: eventId })));
    await flushProxy();
    const output = upstream.sentOfType('conversation.item.create')
      .find((event) => (event.item as { call_id?: string } | undefined)?.call_id === 'ops-call');
    expect(JSON.parse(String((output?.item as { output?: string } | undefined)?.output ?? '{}'))).toMatchObject({
      ok: true,
      status: 'visible',
      board: { visibleObjectIds: ['shown-line'] },
    });
    // First paint makes the tool result truthful but does not release the
    // durable event until the draw-on transaction completes.
    expect(releasedOps()).toBe(0);
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 2, 'ops_shown', { event_id: eventId })));
    await flushProxy();
    expect(releasedOps()).toBe(1);
  });
});
