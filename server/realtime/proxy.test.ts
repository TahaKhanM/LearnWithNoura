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
  it('leaves response cancellation to the client sustained-speech gate', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    FakeUpstream.latest.onopen?.();
    const update = JSON.parse(FakeUpstream.latest.sent[0]) as { session: { reasoning?: { effort?: string }; tools?: Array<{ name?: string }>; audio: { input: { turn_detection: { eagerness: string; interrupt_response: boolean } } } } };
    expect(update.session.audio.input.turn_detection.eagerness).toBe('medium');
    expect(update.session.audio.input.turn_detection.interrupt_response).toBe(false);
    expect(update.session.reasoning?.effort).toBe('low');
    expect(update.session.tools?.some((tool) => tool.name === 'inspect_board')).toBe(true);
  });

  it('grounds the agent in released board state and suppresses exact raw redraws', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'angles');
    repo.addEvent(session.id, 'board_ops', {
      ops: [{ op: 'add', id: 'existing-line', spec: { kind: 'line', from: [10, 10], to: [90, 90] } }],
    });
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const upstream = FakeUpstream.latest;
    upstream.onopen?.();
    const initial = JSON.parse(upstream.sent[0]) as { session: { instructions: string } };
    expect(initial.session.instructions).toContain('existing-line');
    expect(initial.session.instructions).toContain('Do not restart or redraw equivalent objects');

    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    upstream.emit({ type: 'response.created', response: { id: 'response-redraw' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'response-redraw', call_id: 'duplicate-call', name: 'board_ops',
      arguments: JSON.stringify({ ops: [{ op: 'add', id: 'duplicate-line', spec: { kind: 'line', from: [10, 10], to: [90, 90] } }] }),
    });
    await flushProxy();
    const toolOutput = upstream.sent.map((raw) => JSON.parse(raw) as { type: string; item?: { type?: string; output?: string } })
      .find((event) => event.type === 'conversation.item.create' && event.item?.type === 'function_call_output');
    const parsed = JSON.parse(toolOutput?.item?.output ?? '{}') as { applied?: number; skippedEquivalentRedraws?: unknown[]; board?: { visibleObjectIds?: string[] } };
    expect(parsed.applied).toBe(0);
    expect(parsed.skippedEquivalentRedraws).toHaveLength(1);
    expect(parsed.board?.visibleObjectIds).toContain('existing-line');
  });

  it('returns board sections from inspect_board and enforces semantic density budgets', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'geometry');
    repo.addEvent(session.id, 'board_ops', { semanticObjectId: 'existing-proof', ops: [{ op: 'add', id: 'existing-line', spec: { kind: 'line', from: [10, 10], to: [90, 90] } }] });
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const active = { ...identity, sessionId: session.id };
    const upstream = FakeUpstream.latest;
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    upstream.emit({ type: 'response.created', response: { id: 'inspect-response' } });
    upstream.emit({ type: 'response.function_call_arguments.done', response_id: 'inspect-response', call_id: 'inspect-call', name: 'inspect_board', arguments: '{}' });
    await flushProxy();
    const inspectOutput = upstream.sent.map((raw) => JSON.parse(raw) as { type: string; item?: { call_id?: string; output?: string } })
      .find((event) => event.type === 'conversation.item.create' && event.item?.call_id === 'inspect-call');
    expect(JSON.parse(inspectOutput?.item?.output ?? '{}')).toMatchObject({ board: { visibleGroups: [{ id: 'existing-proof', objectCount: 1 }] } });

    upstream.emit({ type: 'response.created', response: { id: 'dense-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'dense-response', call_id: 'dense-call', name: 'semantic_visual_plan',
      arguments: JSON.stringify({
        schemaVersion: '2.0.0', planId: 'dense-proof',
        intent: { objective: 'Pythagorean proof', domain: 'geometry', relevance: 'essential', questionAnswered: 'Why does the theorem work?', rationale: 'The rearrangement is spatial.', action: 'create', density: 'minimal' },
        groups: [{ id: 'dense-proof', label: 'Pythagorean proof', revealOrder: ['outline', 'label', 'connector'], template: 'pythagorean_area_proof', parameters: {} }],
      }),
    });
    await flushProxy();
    const denseOutput = upstream.sent.map((raw) => JSON.parse(raw) as { type: string; item?: { call_id?: string; output?: string } })
      .find((event) => event.type === 'conversation.item.create' && event.item?.call_id === 'dense-call');
    expect(JSON.parse(denseOutput?.item?.output ?? '{}')).toMatchObject({ ok: false, accepted: false, reason: expect.stringContaining('density budget') });
  });

  it('reuses the visible section and routes a learner-question adaptation into it', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    repo.addEvent(session.id, 'board_ops', { semanticObjectId: 'fraction-model', groupLabel: 'Fraction model', ops: [{ op: 'add', id: 'fraction-line', spec: { kind: 'line', from: [100, 300], to: [900, 300] } }] });
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const active = { ...identity, sessionId: session.id };
    const upstream = FakeUpstream.latest;
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    upstream.emit({ type: 'response.created', response: { id: 'adapt-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'adapt-response', call_id: 'move-call', name: 'propose_teaching_move',
      arguments: JSON.stringify({ rationale: 'Answer on the existing line', microObjective: 'locate three quarters', strategy: 'reuse scale', visualStrategy: 'highlight existing point', childFacingText: 'Look at the same line.', questionOrTask: 'Where would three quarters go?', taskId: 'fraction-adapt', proposedAction: 'visual', semanticObjectId: 'fraction-model' }),
    });
    await flushProxy();
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'adapt-response', call_id: 'reuse-call', name: 'semantic_visual_plan',
      arguments: JSON.stringify({
        schemaVersion: '2.0.0', planId: 'reuse-fraction-model',
        intent: { objective: 'Answer on the existing line', domain: 'quantitative', relevance: 'essential', questionAnswered: 'Where is three quarters?', rationale: 'The visible line already supplies the scale.', action: 'reuse', targetGroupId: 'fraction-model', density: 'minimal' },
        groups: [],
      }),
    });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'adapt-response', call_id: 'highlight-call', name: 'board_ops',
      arguments: JSON.stringify({ ops: [{ op: 'highlight', id: 'fraction-line' }] }),
    });
    await flushProxy();

    const reuseOutput = upstream.sent.map((raw) => JSON.parse(raw) as { type: string; item?: { call_id?: string; output?: string } })
      .find((event) => event.type === 'conversation.item.create' && event.item?.call_id === 'reuse-call');
    expect(JSON.parse(reuseOutput?.item?.output ?? '{}')).toMatchObject({ accepted: true, action: 'reuse' });
    expect(repo.listEventsForInternalAudit(session.id).find((event) => event.type === 'board_ops' && !event.released)?.payload).toMatchObject({ semanticObjectId: 'fraction-model', ops: [{ op: 'highlight', id: 'fraction-line' }] });
  });

  it('uses high semantic endpointing for one confirmed voice interruption, then restores medium', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const active = { ...identity, sessionId: session.id };
    const upstream = FakeUpstream.latest;
    upstream.onopen?.();
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    upstream.emit({ type: 'response.created', response: { id: 'before-interruption' } });
    await flushProxy();

    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'interrupt', { reason: 'voice' })));
    await flushProxy();
    let updates = upstream.sent.map((raw) => JSON.parse(raw) as { type: string; session?: { audio?: { input?: { turn_detection?: { eagerness?: string } } } } })
      .filter((event) => event.type === 'session.update');
    expect(updates.map((event) => event.session?.audio?.input?.turn_detection?.eagerness)).toEqual(['medium', 'high']);

    upstream.emit({ type: 'response.created', response: { id: 'after-interruption' } });
    await flushProxy();
    updates = upstream.sent.map((raw) => JSON.parse(raw) as { type: string; session?: { audio?: { input?: { turn_detection?: { eagerness?: string } } } } })
      .filter((event) => event.type === 'session.update');
    expect(updates.map((event) => event.session?.audio?.input?.turn_detection?.eagerness)).toEqual(['medium', 'high', 'medium']);
  });

  it('forwards a learner board image to Realtime and persists only sanitized replay ops', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'board_event', {
      description: 'one learner stroke',
      ops: [{ op: 'add', id: 'sketch-test', color: '#2C5BE0', spec: { kind: 'path', points: [[10, 10], [30, 30], [60, 20]] } }],
      imageDataUrl: 'data:image/jpeg;base64,AAAA',
      requestResponse: true,
      semanticObjectId: 'fraction-scale',
      analysis: {
        version: '1.0.0', semanticGroupId: 'fraction-scale', erasedIds: [], summary: 'underline sketch-test near fraction-scale-main',
        strokes: [{ id: 'sketch-test', gesture: 'underline', bounds: { x: 10, y: 10, w: 50, h: 20 }, centroid: [30, 20], length: 60, straightness: 0.9, closure: 1, corners: 0, nearestObjectIds: ['fraction-scale-main'], touchedObjectIds: [] }],
      },
    })));
    await flushProxy();

    const upstream = FakeUpstream.latest.sent.map((raw) => JSON.parse(raw) as { type: string; session?: { instructions?: string }; item?: { content?: Array<{ type: string }> } });
    const context = upstream.find((event) => event.type === 'conversation.item.create');
    expect(context?.item?.content?.map((part) => part.type)).toEqual(['input_text', 'input_image']);
    expect(upstream.some((event) => event.type === 'response.create')).toBe(true);
    expect(upstream.find((event) => event.type === 'session.update')?.session?.instructions).toContain('sketch-test [section fraction-scale] [learner]');
    expect(upstream.find((event) => event.type === 'session.update')?.session?.instructions).toContain('underline sketch-test');
    const stored = repo.listEvents(session.id);
    expect(stored).toEqual([
      expect.objectContaining({
        type: 'learner_board',
        payload: expect.objectContaining({ hasVisualContext: true, semanticObjectId: 'fraction-scale', analysis: expect.objectContaining({ summary: expect.stringContaining('underline') }), ops: [expect.objectContaining({ op: 'add', id: 'sketch-test' })] }),
      }),
    ]);
    expect(JSON.stringify(stored)).not.toContain('data:image');
    FakeUpstream.latest.emit({ type: 'session.updated' });
    await flushProxy();
    expect(client.sent.find((event) => event.type === 'learner_board_replay')?.payload).toMatchObject({
      batches: [{ semanticObjectId: 'fraction-scale', ops: [expect.objectContaining({ op: 'add', id: 'sketch-test' })] }],
    });
  });

  it('adds board context without a duplicate response while a spoken turn is active', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    FakeUpstream.latest.emit({ type: 'input_audio_buffer.speech_started' });
    await flushProxy();
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'board_event', {
      description: 'drawing while explaining',
      ops: [{ op: 'add', id: 'sketch-talk', spec: { kind: 'path', points: [[10, 10], [20, 20]] } }],
      requestResponse: true,
    })));
    await flushProxy();

    const sent = FakeUpstream.latest.sent.map((raw) => JSON.parse(raw) as { type: string });
    expect(sent.some((event) => event.type === 'conversation.item.create')).toBe(true);
    expect(sent.some((event) => event.type === 'response.create')).toBe(false);
  });

  it('feeds client board-quality rejection back into the model context', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'ops_rejected', { event_id: 99, response_id: 'rejected-response', reason: 'Too many labels.' })));
    await flushProxy();
    const upstream = FakeUpstream.latest.sent.map((raw) => JSON.parse(raw) as { type: string; item?: { content?: Array<{ text?: string }> } });
    expect(upstream.find((event) => event.type === 'conversation.item.create')?.item?.content?.[0]?.text).toContain('Too many labels');
    expect(FakeUpstream.latest.sent.map((raw) => JSON.parse(raw) as { type: string; session?: { instructions?: string } }).find((event) => event.type === 'session.update')?.session?.instructions).toContain('Too many labels');
    expect(repo.listEvents(session.id)).toEqual([expect.objectContaining({ type: 'board_rejected' })]);
  });

  it('maps raw transcript-before-audio events across the complete PCM segment', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
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
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
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
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
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
