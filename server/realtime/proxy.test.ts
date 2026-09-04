import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompiledLessonSchema, COMPILED_LESSON_SCHEMA_VERSION } from '../../shared/compiledLesson';
import type { LessonStage } from '../../shared/pedagogy';
import { createRuntimeEvent, type GenerationIdentity, type RuntimeEventEnvelope } from '../../shared/runtimeProtocol';
import type { MetricObservation } from '../../shared/sessionTelemetry';
import { openTestDb } from '../store/db';
import type { DomainRepository } from '../store/domain';
import { Repo } from '../store/repo';
import { connectRealtimeProxy, type ProxyLifecycle } from './proxy';
import {
  ProxyLifecycleRegistry,
  runQuiescentShutdown,
} from './lifecycle';

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

const blueprintArgs = {
  goal: 'Compare two fractions on one number line',
  mode: 'board_led',
  successCriteria: ['Learner places fractions on one shared scale', 'Learner explains which is larger and why'],
  anchorTemplate: 'fraction_comparison',
  anchorQuestion: 'Which fraction is larger?',
  stages: [
    { id: 'orient', kind: 'orient', objective: 'Recall what a fraction shows', boardPurpose: 'establish_anchor', allowedBoardMutation: 'establish', learnerOpportunity: 'Say what the parts of a fraction mean', evidenceExpected: 'recall of fraction meaning' },
    { id: 'model', kind: 'model', objective: 'Place both fractions on the shared scale', boardPurpose: 'reveal_relation', allowedBoardMutation: 'extend', learnerOpportunity: 'Predict which mark is farther right', evidenceExpected: 'comparison reasoning' },
    { id: 'check', kind: 'guided_check', objective: 'Compare the visible marks', boardPurpose: 'elicit_learner_work', allowedBoardMutation: 'emphasize', learnerOpportunity: 'Circle the larger fraction', evidenceExpected: 'correct identification with reason' },
  ],
};

/** Compiled lessons replaced live blueprint authorship; the proxy loads a
 * ready record at connect. Conversation-led keeps the model-authored
 * semantic-plan pipeline under test; board-led carries a pre-validated
 * anchor scene that establish resolves to. */
function seedCompiledLesson(repo: Repo, sessionId: string, mode: 'conversation_led' | 'board_led' = 'conversation_led'): void {
  repo.upsertCompiledLesson(sessionId, {
    status: 'ready',
    lesson: CompiledLessonSchema.parse({
      compiledLessonId: `compiled-${sessionId}`,
      schemaVersion: COMPILED_LESSON_SCHEMA_VERSION,
      goal: blueprintArgs.goal,
      objective: blueprintArgs.goal,
      blueprint: {
        blueprintId: `blueprint-${sessionId}`,
        goal: blueprintArgs.goal,
        mode,
        successCriteria: blueprintArgs.successCriteria,
        anchor: mode === 'board_led'
          ? { semanticGroupId: 'lesson-anchor', template: 'fraction_comparison', instructionalQuestion: 'Which fraction is larger?', invariantObjectIds: [] }
          : null,
        stages: blueprintArgs.stages,
        currentStageIndex: 0,
        detourStack: [],
      },
      anchorScene: mode === 'board_led'
        ? {
            groupId: 'lesson-anchor',
            groupLabel: 'Fraction number line',
            template: 'fraction_comparison',
            ops: [
              { op: 'add', id: 'anchor-scale', spec: { kind: 'numberline', at: [130, 300], w: 740, min: 0, max: 1 } },
              { op: 'add', id: 'anchor-label', spec: { kind: 'text', at: [130, 250], text: 'One shared scale' } },
            ],
            storyboard: [
              { id: 'reveal-outline', reveal: 'outline', narration: 'Here is one number line from zero to one.', objectIds: ['anchor-scale'] },
              { id: 'reveal-label', reveal: 'label', narration: 'Both fractions will live on this same scale.', objectIds: ['anchor-label'] },
            ],
          }
        : null,
      compiledAt: 0,
      compilerModel: 'test-double',
    }),
  });
}

function toolOutput(upstream: FakeUpstream, callId: string): Record<string, unknown> {
  const event = upstream.sent.map((raw) => JSON.parse(raw) as { type: string; item?: { call_id?: string; output?: string } })
    .find((candidate) => candidate.type === 'conversation.item.create' && candidate.item?.call_id === callId);
  return JSON.parse(event?.item?.output ?? '{}') as Record<string, unknown>;
}

afterEach(() => vi.unstubAllGlobals());

describe('realtime proxy response annotation', () => {
  it('logs an upstream socket error with session-scoped structured fields', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    const logs: string[] = [];
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
      log: (line) => logs.push(line),
    });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    await flushProxy();

    FakeUpstream.latest.onerror?.();

    expect(logs).toContainEqual(expect.stringContaining('"event":"realtime_upstream_error"'));
    expect(logs).toContainEqual(expect.stringContaining(`"sessionId":"${session.id}"`));
    expect(logs).toContainEqual(expect.stringContaining('"reason":"upstream_error"'));
    expect(client.sent).toContainEqual(expect.objectContaining({
      type: 'error',
      payload: { message: 'Lost the connection to the tutor voice service.' },
    }));
  });

  it('leaves response cancellation to the client sustained-speech gate', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    FakeUpstream.latest.onopen?.();
    const update = JSON.parse(FakeUpstream.latest.sent[0]) as { session: { reasoning?: { effort?: string }; tools?: Array<{ name?: string }>; audio: { input: { turn_detection: { eagerness: string; interrupt_response: boolean; create_response: boolean } } } } };
    expect(update.session.audio.input.turn_detection.eagerness).toBe('medium');
    expect(update.session.audio.input.turn_detection.interrupt_response).toBe(false);
    // The deterministic coordinator is the only owner of response.create;
    // provider VAD must not create responses on its own.
    expect(update.session.audio.input.turn_detection.create_response).toBe(false);
    expect(update.session.reasoning?.effort).toBe('low');
    expect(update.session.tools?.some((tool) => tool.name === 'inspect_board')).toBe(true);
    // Lesson authorship moved to the compiler; the live tutor executes.
    expect(update.session.tools?.some((tool) => tool.name === 'create_lesson_blueprint')).toBe(false);
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

  it('returns board sections from inspect_board and fails new-scene requests closed without a Director', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'geometry');
    seedCompiledLesson(repo, session.id);
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

    // The voice model supplies intent only; without a wired Director the
    // slow tier fails closed instead of inventing geometry. (Density
    // budgets on Director scenes are enforced and tested in
    // server/board/director.test.ts.)
    upstream.emit({ type: 'response.created', response: { id: 'scene-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'scene-response', call_id: 'scene-call', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'proof-request', action: 'establish',
        purpose: 'The stage needs an unfamiliar abstract relationship', idea: 'Show opportunity cost without treating both options as equivalent', density: 'minimal',
      }),
    });
    await flushProxy();
    expect(toolOutput(upstream, 'scene-call')).toMatchObject({
      ok: false,
      accepted: false,
      reason: expect.stringMatching(/scene-planning service is unavailable/i),
    });
    expect(String(toolOutput(upstream, 'scene-call').reason)).toMatch(/nothing was drawn/i);
    expect(repo.listEventsForInternalAudit(session.id).filter((event) => event.type === 'semantic_scene')).toEqual([]);
  });

  it('fails board-led new-scene requests closed without a Director', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'geometry');
    seedCompiledLesson(repo, session.id, 'board_led');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const active = { ...identity, sessionId: session.id };
    const upstream = FakeUpstream.latest;
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    upstream.emit({ type: 'response.created', response: { id: 'scene-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'scene-response', call_id: 'scene-call', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'compare-request', action: 'compare',
        purpose: 'Show a second representation', idea: 'A different triangle beside the first', density: 'minimal',
      }),
    });
    await flushProxy();
    expect(toolOutput(upstream, 'scene-call')).toMatchObject({ ok: false, accepted: false, reason: expect.stringContaining('scene-planning service is unavailable') });
  });

  it('routes a conversation-led first representation through the Board Director', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'show an entropy diagram');
    seedCompiledLesson(repo, session.id, 'conversation_led');
    const client = new FakeClient();
    const requests: Array<{ idea: string; sectionId: string }> = [];
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
      directVisual: async (request) => {
        requests.push({ idea: request.idea, sectionId: request.sectionId });
        return {
          ok: true,
          scene: {
            groupId: request.sectionId,
            groupLabel: 'Entropy model',
            template: null,
            ops: [{ op: 'add', id: 'arrangements', spec: { kind: 'box', at: [500, 300], text: 'Possible arrangements' } }],
            storyboard: [{ id: 'arrangements-step', reveal: 'outline', narration: 'This box represents the possible arrangements.', objectIds: ['arrangements'] }],
          },
        };
      },
    });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'response.created', response: { id: 'scene-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'scene-response', call_id: 'scene-call', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'entropy-request', action: 'establish',
        purpose: 'Show an unfamiliar abstract relationship', idea: 'Two arrangements shown as boxes', density: 'minimal',
      }),
    });
    await flushProxy();
    expect(toolOutput(upstream, 'scene-call')).toMatchObject({ ok: true, accepted: true, status: 'preparing' });
    expect(requests).toEqual([{ idea: 'Two arrangements shown as boxes', sectionId: 'lesson-anchor' }]);

    const preflight = client.sent.find((event) => event.type === 'visual_preflight');
    expect(preflight).toBeDefined();
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'visual_preflight_result', {
      preflight_id: (preflight?.payload as { preflight_id?: string } | undefined)?.preflight_id,
      accepted: true,
      reasons: [],
    })));
    await flushProxy();
    expect(client.sent.some((event) => event.type === 'board_ops')).toBe(true);
  });

  it('keeps the full session brief on conversation-led learner turns', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'geometry');
    seedCompiledLesson(repo, session.id, 'conversation_led');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    const creates = () => upstream.sent.map((raw) => JSON.parse(raw) as { type: string; response?: { instructions?: string } })
      .filter((event) => event.type === 'response.create');

    upstream.emit({ type: 'input_audio_buffer.speech_started' });
    upstream.emit({ type: 'input_audio_buffer.speech_stopped' });
    await flushProxy();
    const voiceCreate = creates().at(-1);
    // Per-response instructions replace the session brief. Ordinary turns
    // therefore use the full session instructions instead of a patch-sized
    // drawing steer that drops persona, stage, and safety context.
    expect(voiceCreate?.response).toBeUndefined();
    const latestSession = upstream.sent.map((raw) => JSON.parse(raw) as { type: string; session?: { instructions?: string } })
      .filter((event) => event.type === 'session.update').at(-1);
    expect(latestSession?.session?.instructions).toMatch(/request_visual/i);
    expect(latestSession?.session?.instructions).toMatch(/Current stage/i);
  });

  it('does not turn a visual teaching move into a learner task banner', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'geometry');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'response.created', response: { id: 'visual-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'visual-response', call_id: 'move-call', name: 'propose_teaching_move',
      arguments: JSON.stringify({
        rationale: 'Draw the triangle they asked for', microObjective: 'see a triangle',
        strategy: 'put the figure on the board', childFacingText: 'Okay I will draw a triangle.',
        questionOrTask: 'Okay I will draw a triangle.', proposedAction: 'visual',
      }),
    });
    await flushProxy();
    upstream.emit({ type: 'response.output_audio_transcript.done', response_id: 'visual-response', transcript: 'Okay I will draw a triangle.' });
    upstream.emit({ type: 'response.done', response: { id: 'visual-response', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();
    expect(client.sent.some((event) => event.type === 'learner_task')).toBe(false);
  });

  it('answers an extend request with guidance and routes the adaptation into the visible section', async () => {
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
      type: 'response.function_call_arguments.done', response_id: 'adapt-response', call_id: 'extend-call', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'extend-fraction-model', action: 'extend',
        purpose: 'Answer on the existing line', idea: 'Mark where three quarters sits on the visible scale',
        targetGroupId: 'fraction-model', density: 'minimal',
      }),
    });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'adapt-response', call_id: 'highlight-call', name: 'board_ops',
      arguments: JSON.stringify({ ops: [{ op: 'highlight', id: 'fraction-line' }] }),
    });
    await flushProxy();
    const highlightedEvent = repo.listEventsForInternalAudit(session.id).find((event) => event.type === 'board_ops' && !event.released);
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'ops_presented', { event_id: highlightedEvent?.id })));
    await flushProxy();

    // Extensions stay in the anchor section as small increments — the model
    // never opens a new section for an adaptation.
    expect(toolOutput(upstream, 'extend-call')).toMatchObject({ ok: true, accepted: false, action: 'extend', reason: expect.stringContaining('board_ops') });
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

  it('answers one explicit board submission idempotently, with source lineage and sanitized replay', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const submission = {
      submissionId: 'submission-test-0001',
      draftId: 'draft-1',
      taskId: 'compare-task',
      description: 'one learner stroke',
      ops: [{ op: 'add', id: 'sketch-test', color: '#2C5BE0', spec: { kind: 'path', points: [[10, 10], [30, 30], [60, 20]] } }],
      imageDataUrl: 'data:image/jpeg;base64,AAAA',
      semanticGroupId: 'fraction-scale',
      analysis: {
        version: '1.0.0', semanticGroupId: 'fraction-scale', erasedIds: [], summary: 'underline sketch-test near fraction-scale-main',
        strokes: [{ id: 'sketch-test', gesture: 'underline', bounds: { x: 10, y: 10, w: 50, h: 20 }, centroid: [30, 20], length: 60, straightness: 0.9, closure: 1, corners: 0, nearestObjectIds: ['fraction-scale-main'], touchedObjectIds: [] }],
      },
    };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'board_submission', submission)));
    await flushProxy();

    const upstream = FakeUpstream.latest.sent.map((raw) => JSON.parse(raw) as { type: string; session?: { instructions?: string }; item?: { content?: Array<{ type: string; text?: string }> } });
    const context = upstream.find((event) => event.type === 'conversation.item.create');
    expect(context?.item?.content?.map((part) => part.type)).toEqual(['input_text', 'input_image']);
    expect(context?.item?.content?.[0]?.text).toContain('pressed Done');
    expect(upstream.filter((event) => event.type === 'response.create')).toHaveLength(1);
    expect(upstream.find((event) => event.type === 'session.update')?.session?.instructions).toContain('sketch-test [region 1 of 1: fraction-scale] [learner]');
    expect(upstream.find((event) => event.type === 'session.update')?.session?.instructions).toContain('underline sketch-test');
    const stored = repo.listEvents(session.id);
    expect(stored).toEqual([
      expect.objectContaining({
        type: 'learner_board',
        payload: expect.objectContaining({ hasVisualContext: true, submissionId: 'submission-test-0001', taskId: 'compare-task', semanticObjectId: 'fraction-scale', analysis: expect.objectContaining({ summary: expect.stringContaining('underline') }), ops: [expect.objectContaining({ op: 'add', id: 'sketch-test' })] }),
      }),
    ]);
    expect(JSON.stringify(stored)).not.toContain('data:image');
    expect(client.sent.find((event) => event.type === 'board_submission_ack')?.payload).toMatchObject({ submissionId: 'submission-test-0001' });

    // Duplicate Done / retry with the same submission id never duplicates
    // the stored event or the model response.
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 2, 'board_submission', submission)));
    await flushProxy();
    expect(repo.listEvents(session.id).filter((event) => event.type === 'learner_board')).toHaveLength(1);
    expect(FakeUpstream.latest.sent.map((raw) => JSON.parse(raw) as { type: string }).filter((event) => event.type === 'response.create')).toHaveLength(1);
    expect(client.sent.filter((event) => event.type === 'board_submission_ack')).toHaveLength(2);

    // Evidence recorded for this answer cites the board event itself.
    FakeUpstream.latest.emit({ type: 'response.created', response: { id: 'assess-response' } });
    FakeUpstream.latest.emit({
      type: 'response.function_call_arguments.done', response_id: 'assess-response', call_id: 'evidence-call', name: 'record_evidence',
      arguments: JSON.stringify({
        concept: 'fraction comparison', observation: 'Underlined the larger fraction on the shared scale.', verdict: 'progressing',
        classification: 'correct', confidence: 'medium', confidence_basis: 'Clear single underline on the correct mark.',
        task_id: 'compare-task', opportunity_kind: 'application',
      }),
    });
    await flushProxy();
    const boardEventId = repo.listEvents(session.id).find((event) => event.type === 'learner_board')?.id;
    expect(repo.listEvidence(session.id)[0]?.sourceEventIds).toEqual([boardEventId]);

    FakeUpstream.latest.emit({ type: 'session.updated' });
    await flushProxy();
    expect(client.sent.find((event) => event.type === 'learner_board_replay')?.payload).toMatchObject({
      batches: [{ semanticObjectId: 'fraction-scale', ops: [expect.objectContaining({ op: 'add', id: 'sketch-test' })] }],
    });
  });

  it('never auto-completes a turn while a drawing draft is open; Done owns the one response', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'draft_state', { open: true, draftId: 'draft-guard' })));
    await flushProxy();

    // Speech pauses while composing accumulate context; they never create a
    // response and never grade the half-finished drawing.
    FakeUpstream.latest.emit({ type: 'input_audio_buffer.speech_started' });
    FakeUpstream.latest.emit({ type: 'input_audio_buffer.speech_stopped' });
    FakeUpstream.latest.emit({ type: 'input_audio_buffer.speech_started' });
    FakeUpstream.latest.emit({ type: 'input_audio_buffer.speech_stopped' });
    await flushProxy();
    let sent = FakeUpstream.latest.sent.map((raw) => JSON.parse(raw) as { type: string });
    expect(sent.filter((event) => event.type === 'response.create')).toHaveLength(0);

    // Done submits: exactly one response for the mixed voice+drawing turn.
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 2, 'board_submission', {
      submissionId: 'submission-mixed-001', draftId: 'draft-guard',
      description: 'circled the acute angle',
      ops: [{ op: 'add', id: 'sketch-mixed', spec: { kind: 'path', points: [[10, 10], [20, 20]] } }],
    })));
    await flushProxy();
    sent = FakeUpstream.latest.sent.map((raw) => JSON.parse(raw) as { type: string });
    expect(sent.filter((event) => event.type === 'response.create')).toHaveLength(1);

    // After the submission the voice turn machinery works normally again.
    FakeUpstream.latest.emit({ type: 'input_audio_buffer.speech_started' });
    FakeUpstream.latest.emit({ type: 'input_audio_buffer.speech_stopped' });
    await flushProxy();
    sent = FakeUpstream.latest.sent.map((raw) => JSON.parse(raw) as { type: string });
    expect(sent.filter((event) => event.type === 'response.create')).toHaveLength(2);
  });

  it('continues after a spoken acknowledgement once that response finishes, not during it', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'geometry');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    const creates = () => upstream.sent.map((raw) => JSON.parse(raw) as { type: string }).filter((event) => event.type === 'response.create');

    upstream.emit({ type: 'response.created', response: { id: 'okay-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'okay-response', call_id: 'ops-call', name: 'board_ops',
      arguments: JSON.stringify({ ops: [{ op: 'add', id: 'triangle', spec: { kind: 'polygon', points: [[200, 400], [500, 120], [800, 400]] } }] }),
    });
    await flushProxy();
    const eventId = repo.listEventsForInternalAudit(session.id).find((event) => event.type === 'board_ops')?.id;
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'ops_presented', { event_id: eventId })));
    await flushProxy();
    expect(toolOutput(upstream, 'ops-call')).toMatchObject({
      ok: true,
      applied: 1,
      visible: true,
      justDrawn: ['triangle'],
      board: { visibleObjectIds: expect.arrayContaining(['triangle']) },
    });
    expect(creates()).toEqual([]);

    upstream.emit({ type: 'response.done', response: { id: 'okay-response', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();
    expect(creates()).toHaveLength(1);
  });

  it('delivers fast semantic and learner-stroke annotations without a vision call', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'geometry');
    repo.addEvent(session.id, 'board_ops', {
      semanticObjectId: 'geometry',
      ops: [{ op: 'add', id: 'triangle', spec: { kind: 'polygon', points: [[200, 400], [500, 120], [800, 400]] } }],
    });
    repo.addEvent(session.id, 'learner_board', {
      semanticObjectId: 'geometry',
      ops: [{ op: 'add', id: 'sketch-learner-stroke', spec: { kind: 'path', points: [[180, 280], [240, 320], [310, 290]] } }],
    });
    const inspect = vi.fn(async () => ({ outcome: 'approved' as const, issues: [] }));
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id,
      visionAudit: { model: 'gpt-5.6-luna', reasoningEffort: 'low', inspect },
      createUpstream: () => new FakeUpstream() as never,
    });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'response.created', response: { id: 'annotation-response' } });
    const startedAt = Date.now();
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'annotation-response', call_id: 'annotation-call', name: 'board_ops',
      arguments: JSON.stringify({ ops: [
        { op: 'add', id: 'apex-circle', spec: { kind: 'annotate', style: 'circle', target: { type: 'semantic', objectId: 'triangle', anchor: 'vertex:1' } } },
        { op: 'add', id: 'stroke-tick', spec: { kind: 'annotate', style: 'tick', target: { type: 'learner_stroke', strokeId: 'sketch-learner-stroke', anchor: 'end' } } },
      ] }),
    });
    await flushProxy();
    const staged = repo.listEventsForInternalAudit(session.id).find((event) =>
      event.type === 'board_ops' && !event.released && JSON.stringify(event.payload).includes('apex-circle'));
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'ops_presented', { event_id: staged?.id })));
    await flushProxy();

    const annotationOutput = toolOutput(upstream, 'annotation-call');
    expect(annotationOutput.rejected ?? []).toEqual([]);
    expect(annotationOutput).toMatchObject({
      ok: true,
      status: 'visible',
      applied: 2,
      justDrawn: ['apex-circle', 'stroke-tick'],
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('grounds an image region, render-back audits it, and stages only the verified annotation', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'synthetic worksheet');
    repo.addEvent(session.id, 'board_ops', {
      semanticObjectId: 'image-board',
      ops: [{ op: 'add', id: 'worksheet-image', spec: { kind: 'image', assetId: 'img-a1b2c3d4', at: [100, 80], w: 800, h: 420, alt: 'Synthetic worksheet' } }],
    });
    const propose = vi.fn(async () => ({
      selector: { type: 'FragmentSelector' as const, unit: 'percent' as const, x: 0.2, y: 0.25, w: 0.3, h: 0.2 },
      confidence: 0.91,
    }));
    const inspect = vi.fn(async () => ({ outcome: 'approved' as const, issues: [] }));
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id,
      imageGroundingProposal: { propose },
      visionAudit: { model: 'gpt-5.6-luna', reasoningEffort: 'low', inspect },
      createUpstream: () => new FakeUpstream() as never,
    });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'response.created', response: { id: 'grounding-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'grounding-response', call_id: 'grounding-call', name: 'ground_image_region',
      arguments: JSON.stringify({ requestId: 'grounding-1', imageId: 'worksheet-image', hint: 'the denominator', style: 'circle' }),
    });

    await vi.waitFor(() => expect(client.sent.filter((event) => event.type === 'visual_render')).toHaveLength(1));
    const currentRender = client.sent.find((event) => event.type === 'visual_render')!;
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'visual_render_result', {
      render_id: (currentRender.payload as { render_id: string }).render_id,
      image_data_url: 'data:image/jpeg;base64,Ym9hcmQ=',
    })));
    await vi.waitFor(() => expect(client.sent.filter((event) => event.type === 'visual_preflight')).toHaveLength(1));
    const preflight = client.sent.find((event) => event.type === 'visual_preflight')!;
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 2, 'visual_preflight_result', {
      preflight_id: (preflight.payload as { preflight_id: string }).preflight_id,
      accepted: true,
      reasons: [],
    })));
    await vi.waitFor(() => expect(client.sent.filter((event) => event.type === 'visual_render')).toHaveLength(2));
    const candidateRender = client.sent.filter((event) => event.type === 'visual_render')[1];
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 3, 'visual_render_result', {
      render_id: (candidateRender.payload as { render_id: string }).render_id,
      image_data_url: 'data:image/jpeg;base64,Y2FuZGlkYXRl',
    })));
    await vi.waitFor(() => expect(client.sent.some((event) => event.type === 'board_ops')).toBe(true));
    const staged = repo.listEventsForInternalAudit(session.id).find((event) =>
      event.type === 'board_ops' && !event.released && JSON.stringify(event.payload).includes('annotation-grounding-1'));
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 4, 'ops_presented', { event_id: staged?.id })));
    await flushProxy();

    expect(toolOutput(upstream, 'grounding-call')).toMatchObject({ ok: true, accepted: true, status: 'visible' });
    expect(propose).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledOnce();
    expect(staged?.payload).toMatchObject({
      ops: [expect.objectContaining({ spec: expect.objectContaining({ kind: 'annotate', target: { type: 'image_region', imageId: 'worksheet-image', selector: expect.objectContaining({ type: 'FragmentSelector' }) } }) })],
    });
    expect(client.sent.some((event) => event.type === 'image_region_tap_request')).toBe(false);
  });

  it('requests one child tap on low-confidence image grounding and persists only the normalized selector', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'synthetic worksheet');
    repo.addEvent(session.id, 'board_ops', {
      semanticObjectId: 'image-board',
      ops: [{ op: 'add', id: 'worksheet-image', spec: { kind: 'image', assetId: 'img-a1b2c3d4', at: [100, 80], w: 800, h: 420, alt: 'Synthetic worksheet' } }],
    });
    const inspect = vi.fn();
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id,
      imageGroundingProposal: { propose: async () => ({ selector: { type: 'PointSelector', x: 0.4, y: 0.6 }, confidence: 0.5 }) },
      visionAudit: { model: 'gpt-5.6-luna', reasoningEffort: 'low', inspect },
      createUpstream: () => new FakeUpstream() as never,
    });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'response.created', response: { id: 'tap-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'tap-response', call_id: 'tap-call', name: 'ground_image_region',
      arguments: JSON.stringify({ requestId: 'tap-grounding', imageId: 'worksheet-image', hint: 'the axle', style: 'arrow' }),
    });
    await vi.waitFor(() => expect(client.sent.filter((event) => event.type === 'visual_render')).toHaveLength(1));
    const render = client.sent.find((event) => event.type === 'visual_render')!;
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'visual_render_result', {
      render_id: (render.payload as { render_id: string }).render_id,
      image_data_url: 'data:image/jpeg;base64,Ym9hcmQ=',
    })));
    await vi.waitFor(() => expect(client.sent.some((event) => event.type === 'image_region_tap_request')).toBe(true));
    expect(toolOutput(upstream, 'tap-call')).toMatchObject({ ok: true, accepted: false, status: 'tap_required', reason: 'low_confidence' });
    expect(inspect).not.toHaveBeenCalled();

    client.emit('message', JSON.stringify(createRuntimeEvent(active, 2, 'image_region_tap', {
      request_id: 'tap-grounding', image_id: 'worksheet-image',
      selector: { type: 'PointSelector', x: 0.45, y: 0.55 },
    })));
    await vi.waitFor(() => expect(client.sent.some((event) => event.type === 'board_ops')).toBe(true));
    const staged = repo.listEventsForInternalAudit(session.id).find((event) =>
      event.type === 'board_ops' && !event.released && JSON.stringify(event.payload).includes('annotation-tap-grounding'));
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 3, 'ops_presented', { event_id: staged?.id })));
    await flushProxy();

    expect(staged?.payload).toMatchObject({
      ops: [expect.objectContaining({ spec: expect.objectContaining({
        kind: 'annotate',
        target: { type: 'image_region', imageId: 'worksheet-image', selector: { type: 'PointSelector', x: 0.45, y: 0.55 } },
      }) })],
    });
    expect(client.sent.find((event) => event.type === 'image_region_grounded')?.payload).toMatchObject({
      request_id: 'tap-grounding', accepted: true,
    });
  });

  it('retries a tool continuation that hit an already-active response', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'geometry');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;

    upstream.emit({
      type: 'error',
      error: { code: 'conversation_already_has_active_response', message: 'Conversation already has an active response.' },
    });
    upstream.emit({ type: 'response.done', response: { id: 'stale-response', status: 'completed', output: [] } });
    await flushProxy();
    // lastCreateSource starts as 'start'; a rejected opening create must retry.
    expect(upstream.sent.map((raw) => JSON.parse(raw) as { type: string }).filter((event) => event.type === 'response.create'))
      .toHaveLength(1);
  });

  it('delivers an imperative drawing task as an explicit handoff without injecting another question', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'angles');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));

    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'response.created', response: { id: 'task-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'task-response', call_id: 'move-call', name: 'propose_teaching_move',
      arguments: JSON.stringify({
        rationale: 'The learner should identify the acute angle themselves.', microObjective: 'recognize acute angles',
        strategy: 'have the learner mark the diagram', childFacingText: 'Circle the acute angle.',
        questionOrTask: 'Circle the acute angle.', taskId: 'circle-acute', responseMode: 'draw', proposedAction: 'question',
      }),
    });
    await flushProxy();
    upstream.emit({ type: 'response.output_audio.delta', response_id: 'task-response', item_id: 'item-task', delta: Buffer.alloc(2_400 * 2).toString('base64') });
    upstream.emit({ type: 'response.output_audio_transcript.done', response_id: 'task-response', transcript: 'Circle the acute angle.' });
    upstream.emit({ type: 'response.done', response: { id: 'task-response', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();

    // The task contract reaches the client at the heard-audio boundary; an
    // imperative counts exactly like a question.
    const taskEvent = client.sent.find((event) => event.type === 'learner_task');
    expect(taskEvent?.payload).toMatchObject({ task: { taskId: 'circle-acute', prompt: 'Circle the acute angle.', responseMode: 'draw', submitPolicy: 'explicit' } });
    expect(repo.listEvents(session.id).some((event) => event.type === 'learner_task')).toBe(true);

    // The tool-continuation response finishes with no trailing "?" — the
    // deterministic layer waits for the learner instead of injecting a
    // generic question.
    const createsBefore = upstream.sent.map((raw) => JSON.parse(raw) as { type: string }).filter((event) => event.type === 'response.create').length;
    upstream.emit({ type: 'response.created', response: { id: 'follow-response' } });
    upstream.emit({ type: 'response.output_audio.delta', response_id: 'follow-response', item_id: 'item-follow', delta: Buffer.alloc(2_400 * 2).toString('base64') });
    upstream.emit({ type: 'response.output_audio_transcript.done', response_id: 'follow-response', transcript: 'Take your time.' });
    upstream.emit({ type: 'response.done', response: { id: 'follow-response', status: 'completed', output: [] } });
    await flushProxy();
    const createsAfter = upstream.sent.map((raw) => JSON.parse(raw) as { type: string }).filter((event) => event.type === 'response.create').length;
    expect(createsAfter).toBe(createsBefore);
    expect(client.sent.some((event) => event.type === 'safe_question')).toBe(false);
  });

  it('restores an unanswered task after a reconnect', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'angles');
    repo.addEvent(session.id, 'learner_task', {
      task: { taskId: 'circle-acute', prompt: 'Circle the acute angle.', responseMode: 'draw', submitPolicy: 'explicit', targetObjectIds: [], boardRevision: 0, allowVoiceWhileDrawing: true },
    });
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    client.emit('message', JSON.stringify(createRuntimeEvent({ ...identity, sessionId: session.id }, 0, 'hello', {})));
    FakeUpstream.latest.emit({ type: 'session.updated' });
    await flushProxy();
    expect(client.sent.find((event) => event.type === 'learner_task')?.payload).toMatchObject({
      task: { taskId: 'circle-acute', responseMode: 'draw' }, restored: true,
    });
  });

  it('rejects a destructive mixed batch atomically', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    client.emit('message', JSON.stringify(createRuntimeEvent({ ...identity, sessionId: session.id }, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'response.created', response: { id: 'clear-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'clear-response', call_id: 'clear-call', name: 'board_ops',
      arguments: JSON.stringify({ ops: [{ op: 'clear' }, { op: 'add', id: 'kept-line', spec: { kind: 'line', from: [100, 100], to: [300, 300] } }] }),
    });
    await flushProxy();
    const output = upstream.sent.map((raw) => JSON.parse(raw) as { type: string; item?: { call_id?: string; output?: string } })
      .find((event) => event.type === 'conversation.item.create' && event.item?.call_id === 'clear-call');
    const parsed = JSON.parse(output?.item?.output ?? '{}') as { ok?: boolean; applied?: number; rejected?: string[] };
    expect(parsed.applied).toBe(0);
    expect(parsed.rejected?.join(' ')).toMatch(/clear is not available/i);
    const staged = repo.listEventsForInternalAudit(session.id).find((event) => event.type === 'board_ops');
    expect(staged).toBeUndefined();
  });

  it('fails the anchor build closed when the browser rejects or never confirms the preflight', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    seedCompiledLesson(repo, session.id, 'board_led');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never, preflightTimeoutMs: 120,
    });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'response.created', response: { id: 'plan-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'plan-response', call_id: 'plan-call', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'anchor-preflight', action: 'establish',
        purpose: 'Anchor the comparison', idea: 'Both fractions on one shared number line', density: 'minimal',
      }),
    });
    await flushProxy();

    // The browser is asked to compile the complete compiled-anchor scene
    // offscreen, in the server-assigned anchor section.
    const preflight = client.sent.find((event) => event.type === 'visual_preflight');
    expect(preflight?.payload).toMatchObject({ semanticObjectId: 'lesson-anchor' });
    // The browser rejects it; the model must be told nothing was drawn.
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'visual_preflight_result', {
      preflight_id: (preflight!.payload as { preflight_id?: string }).preflight_id,
      accepted: false,
      reasons: ['collision:lesson-anchor-scale'],
    })));
    await flushProxy();
    await flushProxy();
    expect(toolOutput(upstream, 'plan-call')).toMatchObject({ ok: false, accepted: false, reason: expect.stringContaining('preflight') });
    expect(repo.listEventsForInternalAudit(session.id).filter((event) => event.type === 'semantic_scene')).toEqual([]);

    // A silent browser is missing evidence, never acceptance: the retry
    // (allowed once after a failure) times out closed and stages nothing.
    upstream.emit({ type: 'response.created', response: { id: 'plan-response-2' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'plan-response-2', call_id: 'plan-call-2', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'anchor-preflight-retry', action: 'establish',
        purpose: 'Anchor the comparison', idea: 'Both fractions on one shared number line', density: 'minimal',
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(toolOutput(upstream, 'plan-call-2')).toMatchObject({ ok: false, accepted: false, reason: expect.stringContaining('preflight') });
    expect(repo.listEventsForInternalAudit(session.id).filter((event) => event.type === 'semantic_scene')).toEqual([]);
  });

  it('takes fatal shutdown while semantic preflight staging is unresolved', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    seedCompiledLesson(repo, session.id, 'board_led');
    const client = new FakeClient();
    const registry = new ProxyLifecycleRegistry();
    let lifecycle: ProxyLifecycle | null = null;
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
      preflightTimeoutMs: 60_000,
      onLifecycle: (value) => {
        lifecycle = value;
        registry.register(value);
      },
    });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    upstream.emit({ type: 'response.created', response: { id: 'shutdown-plan-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'shutdown-plan-response',
      call_id: 'shutdown-plan-call',
      name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0',
        requestId: 'shutdown-plan',
        action: 'establish',
        purpose: 'Anchor the comparison',
        idea: 'Both fractions on one shared number line',
        density: 'minimal',
      }),
    });
    await flushProxy();
    const preflight = client.sent.find((event) => event.type === 'visual_preflight');
    expect(preflight).toBeDefined();
    const preflightId = (preflight!.payload as { preflight_id?: unknown }).preflight_id;
    expect(preflightId).toEqual(expect.stringMatching(/^preflight-/));
    expect(toolOutput(upstream, 'shutdown-plan-call')).toEqual({});
    expect(repo.listEventsForInternalAudit(session.id)
      .filter((event) => event.type === 'semantic_scene')).toEqual([]);

    const repositoryClose = vi.fn(async () => {});
    const fatal = vi.fn();
    const shutdown = runQuiescentShutdown({
      stopAccepting: () => {},
      closeClients: () => {},
      closeProxies: () => registry.shutdown(5),
      closeRepository: repositoryClose,
      log: () => {},
      fatal,
    });
    await vi.advanceTimersByTimeAsync(6);
    const result = await shutdown;
    expect(result).toBe('fatal');
    expect(repositoryClose).not.toHaveBeenCalled();
    expect(fatal).toHaveBeenCalledWith(expect.any(Error));
    expect(repo.listEventsForInternalAudit(session.id)
      .filter((event) => event.type === 'semantic_scene')).toEqual([]);

    client.emit('message', JSON.stringify(createRuntimeEvent(
      active,
      1,
      'visual_preflight_result',
      {
        preflight_id: preflightId,
        accepted: false,
        reasons: ['shutdown test cleanup'],
      },
    )));
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(lifecycle!.completion).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('gracefully drains settled semantic staging', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    seedCompiledLesson(repo, session.id, 'board_led');
    const client = new FakeClient();
    const registry = new ProxyLifecycleRegistry();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
      preflightTimeoutMs: 100,
      onLifecycle: (value) => registry.register(value),
    });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'response.created', response: { id: 'graceful-plan-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'graceful-plan-response',
      call_id: 'graceful-plan-call',
      name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0',
        requestId: 'graceful-plan',
        action: 'establish',
        purpose: 'Anchor the comparison',
        idea: 'Both fractions on one shared number line',
        density: 'minimal',
      }),
    });
    await flushProxy();
    const preflight = client.sent.find((event) => event.type === 'visual_preflight');
    client.emit('message', JSON.stringify(createRuntimeEvent(
      active,
      1,
      'visual_preflight_result',
      {
        preflight_id: (preflight!.payload as { preflight_id?: string }).preflight_id,
        accepted: false,
        reasons: ['test rejection'],
      },
    )));
    await flushProxy();
    await flushProxy();
    expect(toolOutput(upstream, 'graceful-plan-call')).toMatchObject({
      ok: false,
      accepted: false,
    });
    await expect(registry.shutdown(100)).resolves.toBe('graceful');
  });

  it('rejects every live replace request: visible tutor work never disappears', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    repo.addEvent(session.id, 'board_ops', { semanticObjectId: 'working-model', groupLabel: 'Working model', ops: [{ op: 'add', id: 'model-box', spec: { kind: 'box', at: [500, 300], text: 'Old model' } }] });
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never, preflightTimeoutMs: 20,
    });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.onopen?.();
    upstream.emit({ type: 'response.created', response: { id: 'replace-response' } });
    // Replace is no longer even representable: the intent-only request
    // schema has no such action, so the request fails validation closed.
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'replace-response', call_id: 'replace-call', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'replace-model', action: 'replace',
        purpose: 'Correct the model', idea: 'A corrected two-step model', targetGroupId: 'working-model', density: 'minimal',
      }),
    });
    await flushProxy();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(toolOutput(upstream, 'replace-call')).toMatchObject({ ok: false, accepted: false, error: expect.stringContaining('schema validation') });
    // No clear is staged and no visible object is removed.
    expect(repo.listEventsForInternalAudit(session.id).filter((event) => event.type === 'semantic_scene')).toEqual([]);
    const instructions = upstream.sent.map((raw) => JSON.parse(raw) as { type: string; session?: { instructions?: string } })
      .filter((event) => event.type === 'session.update').at(-1)?.session?.instructions ?? '';
    expect(instructions).toContain('model-box');
  });

  it('accepts one structural request per tutor turn and covers Director latency with a preparing result', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    seedCompiledLesson(repo, session.id, 'board_led');
    const client = new FakeClient();
    const directorRequests: string[] = [];
    const logs: string[] = [];
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
      log: (line) => logs.push(line),
      // A Director that never resolves: the voice model must stay unblocked
      // regardless — the tool result returns immediately as "preparing".
      directVisual: (request) => {
        directorRequests.push(request.sectionId);
        return new Promise(() => {});
      },
    });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'response.created', response: { id: 'compare-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'compare-response', call_id: 'compare-call', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'compare-plan', action: 'compare',
        purpose: 'Contrast with equal fractions', idea: 'A side case where both fractions are equal', density: 'minimal',
      }),
    });
    await flushProxy();
    // The voice model is never blocked silently: the result arrives at once
    // and tells it to keep teaching with what is visible.
    expect(toolOutput(upstream, 'compare-call')).toMatchObject({
      ok: true,
      accepted: true,
      status: 'preparing',
      semanticGroupId: 'lesson-anchor-alt1',
      guidance: expect.stringContaining('Keep teaching'),
    });
    expect(directorRequests).toEqual(['lesson-anchor-alt1']);
    // The follow-up is deferred until this response finishes — creating
    // now would be rejected as already-active and used to drop the turn.
    expect(upstream.sent.map((raw) => JSON.parse(raw) as { type: string })
      .filter((event) => event.type === 'response.create')).toEqual([]);
    upstream.emit({ type: 'response.done', response: { id: 'compare-response', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();
    expect(upstream.sent.map((raw) => JSON.parse(raw) as { type: string })
      .filter((event) => event.type === 'response.create')).toHaveLength(1);

    // A second structural request in the same tutor turn is rejected.
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'compare-response', call_id: 'second-call', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'second-plan', action: 'establish',
        purpose: 'Another idea', idea: 'A second structure', density: 'minimal',
      }),
    });
    await flushProxy();
    expect(toolOutput(upstream, 'second-call')).toMatchObject({
      ok: false,
      accepted: false,
      reason: expect.stringContaining('One visual plan per teaching turn'),
      anchorGroupId: 'lesson-anchor',
    });
    expect(logs).toContainEqual(expect.stringContaining('"event":"visual_tool_rejected"'));
    expect(logs).toContainEqual(expect.stringContaining('"reason":"one_plan_per_turn"'));

    // A learner turn resets the budget; the next comparison gets the next
    // announced side section.
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'user_text', { text: 'I think three quarters is bigger.', idempotencyKey: 'turn-reset-key-1' })));
    await flushProxy();
    upstream.emit({ type: 'response.created', response: { id: 'compare-response-2' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'compare-response-2', call_id: 'compare-call-2', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'compare-plan-2', action: 'compare',
        purpose: 'Contrast with equal fractions', idea: 'A side case where both fractions are equal', density: 'minimal',
      }),
    });
    await flushProxy();
    expect(toolOutput(upstream, 'compare-call-2')).toMatchObject({ status: 'preparing', semanticGroupId: 'lesson-anchor-alt2' });
    expect(directorRequests).toEqual(['lesson-anchor-alt1', 'lesson-anchor-alt2']);
  });

  it('logs an establish rejection when the anchor is already visible', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    seedCompiledLesson(repo, session.id, 'board_led');
    repo.addEvent(session.id, 'semantic_scene', {
      semanticObjectId: 'lesson-anchor',
      groupLabel: 'Fraction number line',
      ops: [{ op: 'add', id: 'visible-anchor', spec: { kind: 'text', at: [200, 200], text: 'Visible' } }],
    });
    const client = new FakeClient();
    const logs: string[] = [];
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
      log: (line) => logs.push(line),
    });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'response.created', response: { id: 'duplicate-anchor-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'duplicate-anchor-response',
      call_id: 'duplicate-anchor-call',
      name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'duplicate-anchor', action: 'establish',
        purpose: 'Rebuild the anchor', idea: 'the same number line', density: 'minimal',
      }),
    });
    await flushProxy();

    expect(toolOutput(upstream, 'duplicate-anchor-call')).toMatchObject({
      ok: false,
      accepted: false,
      reason: expect.stringContaining('already on the board'),
    });
    expect(logs).toContainEqual(expect.stringContaining('"event":"visual_tool_rejected"'));
    expect(logs).toContainEqual(expect.stringContaining('"reason":"anchor_already_present"'));
  });

  it('resolves establish to the precompiled anchor and hands the reveal to the storyboard runner', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    seedCompiledLesson(repo, session.id, 'board_led');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never, preflightTimeoutMs: 400, visibilityTimeoutMs: 800,
    });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.onopen?.();
    // The injected stage context announces the step-by-step build without
    // inlining the narrations: beats are prompted per reveal by the runner,
    // so the model cannot pre-narrate the scene.
    const initial = JSON.parse(upstream.sent[0]) as { session: { instructions: string } };
    expect(initial.session.instructions).toContain('Anchor scene for section lesson-anchor');
    expect(initial.session.instructions).not.toContain('Here is one number line from zero to one.');

    // The voice model requests establish with intent only; the compiled,
    // pre-validated anchor geometry is what actually builds.
    upstream.emit({ type: 'response.created', response: { id: 'compiled-anchor-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'compiled-anchor-response', call_id: 'compiled-anchor-call', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'model-request', action: 'establish',
        purpose: 'Anchor the comparison', idea: 'Both fractions on one shared number line', density: 'minimal',
      }),
    });
    await flushProxy();
    const preflight = client.sent.find((event) => event.type === 'visual_preflight');
    const preflightOps = ((preflight?.payload as { ops?: Array<{ id?: string }> } | undefined)?.ops) ?? [];
    expect(preflight?.payload).toMatchObject({ semanticObjectId: 'lesson-anchor' });
    expect(preflightOps.map((op) => op.id)).toEqual(['anchor-scale', 'anchor-label']);
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'visual_preflight_result', {
      preflight_id: (preflight!.payload as { preflight_id?: string }).preflight_id,
      accepted: true,
      reasons: [],
    })));
    await flushProxy();
    await flushProxy();

    // The tool result arrives BEFORE anything is visible and says so: the
    // runner owns the reveal, and no free continuation may narrate an
    // invisible scene (the beats are the continuation).
    const output = toolOutput(upstream, 'compiled-anchor-call') as {
      ok?: boolean; accepted?: boolean; status?: string; semanticGroupId?: string;
      storyboard?: Array<{ reveal?: string }>; guidance?: string;
    };
    expect(output.ok).toBe(true);
    expect(output.accepted).toBe(true);
    expect(output.status).toBe('building');
    expect(output.semanticGroupId).toBe('lesson-anchor');
    expect(output.storyboard?.map((step) => step.reveal)).toEqual(['outline', 'label']);
    expect(upstream.sent.map((raw) => JSON.parse(raw) as { type: string })
      .filter((event) => event.type === 'response.create')).toEqual([]);

    // Only the FIRST step is staged, tagged to the establishing response's
    // playback boundary and marked for reveal→narrate telemetry. Step two
    // must not exist yet — that is the retirement of "reveal everything at
    // segment end".
    const staged = client.sent.filter((event) => event.type === 'board_ops');
    expect(staged).toHaveLength(1);
    expect(staged[0].payload).toMatchObject({
      checkpoint: 'outline',
      response_id: 'compiled-anchor-response',
      await_narration: true,
    });
    expect((staged[0].payload as { ops?: Array<{ id?: string }> }).ops?.map((op) => op.id)).toEqual(['anchor-scale']);
  });

  it('upgrades a prerequisite gap to a compiled detour mini-plan and returns to the recorded stage', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    seedCompiledLesson(repo, session.id);
    const detourStage: LessonStage = {
      id: 'detour-prereq', kind: 'model', objective: 'Rebuild fraction meaning with one shaded strip',
      boardPurpose: 'none', allowedBoardMutation: 'none',
      learnerOpportunity: 'Shade one half of a strip and say what it shows', evidenceExpected: 'recall of fraction meaning',
      checks: [{ id: 'detour-check', questionOrTask: 'What does the shaded part show?', responseMode: 'voice' }],
    };
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
      planDetour: async () => [detourStage],
    });
    const active = { ...identity, sessionId: session.id };
    const upstream = FakeUpstream.latest;
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'user_text', { text: 'What is a fraction again?', idempotencyKey: 'detour-turn-0001' })));
    await flushProxy();

    upstream.emit({ type: 'response.created', response: { id: 'gap-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'gap-response', call_id: 'gap-evidence-call', name: 'record_evidence',
      arguments: JSON.stringify({
        concept: 'fraction meaning', observation: 'Cannot say what the denominator counts.', verdict: 'struggling',
        classification: 'missing_prerequisite', confidence: 'medium', confidence_basis: 'Direct question, no answer.',
        task_id: 'orient-check', opportunity_kind: 'recall',
      }),
    });
    await flushProxy();
    await flushProxy();
    expect(toolOutput(upstream, 'gap-evidence-call')).toMatchObject({ ok: true, detourDepth: 1 });

    // The asynchronous compiled mini-plan upgraded the simple detour entry
    // durably, and the injected stage context now teaches the detour stage.
    const progress = repo.listEventsForInternalAudit(session.id).filter((event) => event.type === 'blueprint_progress');
    const lastStack = (progress.at(-1)?.payload as { detourStack?: Array<{ plan?: { stages: Array<{ id: string }> } }> } | undefined)?.detourStack ?? [];
    expect(lastStack[0]?.plan?.stages.map((stage) => stage.id)).toEqual(['detour-prereq']);
    const instructions = upstream.sent.map((raw) => JSON.parse(raw) as { type: string; session?: { instructions?: string } })
      .filter((event) => event.type === 'session.update').at(-1)?.session?.instructions ?? '';
    expect(instructions).toContain('Rebuild fraction meaning with one shaded strip');
    expect(instructions).toContain('prerequisite detour');

    // A correct answer on the final detour stage pops it and returns to the
    // recorded main stage.
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 2, 'user_text', { text: 'It shows one of two equal parts.', idempotencyKey: 'detour-turn-0002' })));
    await flushProxy();
    upstream.emit({ type: 'response.created', response: { id: 'resolve-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'resolve-response', call_id: 'resolve-evidence-call', name: 'record_evidence',
      arguments: JSON.stringify({
        concept: 'fraction meaning', observation: 'Explained the shaded strip correctly.', verdict: 'progressing',
        classification: 'correct', confidence: 'medium', confidence_basis: 'Clear explanation in own words.',
        task_id: 'detour-check', opportunity_kind: 'explanation',
      }),
    });
    await flushProxy();
    await flushProxy();
    expect(toolOutput(upstream, 'resolve-evidence-call')).toMatchObject({
      ok: true,
      detourDepth: 0,
      currentStage: { id: 'orient' },
    });
  });

  it('falls back to the simple detour when detour planning times out', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    seedCompiledLesson(repo, session.id);
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
      planDetour: () => new Promise(() => {}),
      detourPlanTimeoutMs: 30,
    });
    const active = { ...identity, sessionId: session.id };
    const upstream = FakeUpstream.latest;
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'user_text', { text: 'I do not know.', idempotencyKey: 'timeout-turn-0001' })));
    await flushProxy();
    upstream.emit({ type: 'response.created', response: { id: 'timeout-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'timeout-response', call_id: 'timeout-evidence-call', name: 'record_evidence',
      arguments: JSON.stringify({
        concept: 'fraction meaning', observation: 'No usable definition offered.', verdict: 'struggling',
        classification: 'missing_prerequisite', confidence: 'medium', confidence_basis: 'Direct question, no answer.',
        task_id: 'orient-check', opportunity_kind: 'recall',
      }),
    });
    await flushProxy();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await flushProxy();

    // The simple detour recorded by the evidence classification stands; no
    // compiled plan ever landed.
    expect(toolOutput(upstream, 'timeout-evidence-call')).toMatchObject({ ok: true, detourDepth: 1 });
    const progress = repo.listEventsForInternalAudit(session.id).filter((event) => event.type === 'blueprint_progress');
    const stacks = progress.map((event) => (event.payload as { detourStack?: Array<{ plan?: unknown }> }).detourStack ?? []);
    expect(stacks.length).toBeGreaterThan(0);
    expect(stacks.every((stack) => stack.every((entry) => entry.plan === undefined))).toBe(true);
  });

  it('refuses to attach a session whose lesson compilation is not ready', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    repo.upsertCompiledLesson(session.id, { status: 'pending' });
    const client = new FakeClient();
    await expect(connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    })).rejects.toThrow(/not compiled/);
  });

  it('erase is rejected in the turn that created the object; earlier work persists across later moves', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;

    upstream.emit({ type: 'response.created', response: { id: 'first-move' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'first-move', call_id: 'add-call', name: 'board_ops',
      arguments: JSON.stringify({ ops: [{ op: 'add', id: 'kept-line', spec: { kind: 'line', from: [100, 100], to: [400, 100] } }] }),
    });
    await flushProxy();
    const stagedAdd = repo.listEventsForInternalAudit(session.id).find((event) => event.type === 'board_ops');
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'ops_presented', { event_id: stagedAdd?.id })));
    await flushProxy();
    // Erasing what was just taught, in the same turn, is rejected.
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'first-move', call_id: 'erase-call', name: 'board_ops',
      arguments: JSON.stringify({ ops: [{ op: 'erase', id: 'kept-line' }] }),
    });
    await flushProxy();
    expect(toolOutput(upstream, 'erase-call')).toMatchObject({ ok: false, applied: 0, rejected: [expect.stringContaining('created this turn')] });

    // The object survives the acknowledgement, later moves, and the next
    // learner response.
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 2, 'ops_shown', { event_id: stagedAdd?.id })));
    await flushProxy();
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 3, 'user_text', { text: 'What does that line mean?', idempotencyKey: 'perm-key-0001' })));
    await flushProxy();
    upstream.emit({ type: 'response.created', response: { id: 'second-move' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'second-move', call_id: 'later-call', name: 'board_ops',
      arguments: JSON.stringify({ ops: [{ op: 'add', id: 'later-label', spec: { kind: 'text', at: [120, 160], text: 'still here' } }] }),
    });
    await flushProxy();
    const laterEvent = repo.listEventsForInternalAudit(session.id).find((event) =>
      event.type === 'board_ops' && JSON.stringify(event.payload).includes('later-label'));
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 4, 'ops_presented', { event_id: laterEvent?.id })));
    await flushProxy();
    const instructions = upstream.sent.map((raw) => JSON.parse(raw) as { type: string; session?: { instructions?: string } })
      .filter((event) => event.type === 'session.update').at(-1)?.session?.instructions ?? '';
    expect(instructions).toContain('kept-line');
  });

  it('restores the blueprint stage after a reconnect and rejects stage jumps against it', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const storedBlueprint = {
      blueprintId: 'blueprint-restored',
      goal: 'Compare two fractions on one number line',
      mode: 'board_led',
      successCriteria: ['Learner compares fractions on one scale'],
      anchor: { semanticGroupId: 'lesson-anchor', template: 'fraction_comparison', instructionalQuestion: 'Which fraction is larger?', invariantObjectIds: [] },
      stages: blueprintArgs.stages,
      currentStageIndex: 0,
      detourStack: [],
    };
    repo.addEvent(session.id, 'lesson_blueprint', { blueprint: storedBlueprint });
    repo.addEvent(session.id, 'blueprint_progress', { blueprintId: 'blueprint-restored', currentStageIndex: 1, detourStack: [] });
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'session.updated' });
    await flushProxy();

    // A stage jump against the restored current stage is rejected.
    upstream.emit({ type: 'response.created', response: { id: 'jump-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'jump-response', call_id: 'jump-call', name: 'propose_teaching_move',
      arguments: JSON.stringify({
        rationale: 'Skip ahead', microObjective: 'closure early', strategy: 'jump', childFacingText: 'Let us finish.',
        proposedAction: 'explain', blueprintId: 'blueprint-restored', stageId: 'check',
      }),
    });
    await flushProxy();
    expect(toolOutput(upstream, 'jump-call')).toMatchObject({ ok: false, error: expect.stringContaining('Illegal stage jump') });

    // Executing the restored current stage succeeds and reports it.
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'jump-response', call_id: 'legal-call', name: 'propose_teaching_move',
      arguments: JSON.stringify({
        rationale: 'Continue modelling', microObjective: 'Place both fractions on the shared scale', strategy: 'model on anchor', childFacingText: 'Watch the scale.',
        proposedAction: 'explain', blueprintId: 'blueprint-restored', stageId: 'model', goalLink: 'Placing the marks advances the modelling stage.', boardPurpose: 'reveal_relation',
      }),
    });
    await flushProxy();
    expect(toolOutput(upstream, 'legal-call')).toMatchObject({ ok: true, blueprintId: 'blueprint-restored', currentStage: { id: 'model' } });
  });

  it('requires board-led check questions to name visible target objects', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    repo.addEvent(session.id, 'lesson_blueprint', {
      blueprint: {
        blueprintId: 'blueprint-check',
        goal: 'Compare two fractions on one number line',
        mode: 'board_led',
        successCriteria: ['Learner compares fractions on one scale'],
        anchor: { semanticGroupId: 'lesson-anchor', template: 'fraction_comparison', instructionalQuestion: 'Which fraction is larger?', invariantObjectIds: [] },
        stages: blueprintArgs.stages,
        currentStageIndex: 0,
        detourStack: [],
      },
    });
    repo.addEvent(session.id, 'blueprint_progress', { blueprintId: 'blueprint-check', currentStageIndex: 2, detourStack: [] });
    repo.addEvent(session.id, 'board_ops', { semanticObjectId: 'lesson-anchor', groupLabel: 'Fraction number line', ops: [{ op: 'add', id: 'lesson-anchor-scale', spec: { kind: 'numberline', at: [130, 300], w: 740, min: 0, max: 1 } }] });
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'session.updated' });
    await flushProxy();

    upstream.emit({ type: 'response.created', response: { id: 'check-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'check-response', call_id: 'vague-call', name: 'propose_teaching_move',
      arguments: JSON.stringify({
        rationale: 'Check understanding', microObjective: 'Compare the visible marks', strategy: 'diagnostic question', childFacingText: 'Which is larger?',
        questionOrTask: 'Which fraction is larger?', taskId: 'compare-check', proposedAction: 'question', blueprintId: 'blueprint-check', stageId: 'check',
      }),
    });
    await flushProxy();
    // A check question with no named visible targets is not answerable by
    // inspecting the board — rejected.
    expect(toolOutput(upstream, 'vague-call')).toMatchObject({ ok: false, error: expect.stringContaining('name visible board objects') });

    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'check-response', call_id: 'targeted-call', name: 'propose_teaching_move',
      arguments: JSON.stringify({
        rationale: 'Check understanding', microObjective: 'Compare the visible marks', strategy: 'diagnostic question', childFacingText: 'Look at the scale.',
        questionOrTask: 'Which mark on the scale is farther right?', taskId: 'compare-check', proposedAction: 'question',
        blueprintId: 'blueprint-check', stageId: 'check', targetObjectIds: ['lesson-anchor-scale'],
      }),
    });
    await flushProxy();
    expect(toolOutput(upstream, 'targeted-call')).toMatchObject({ ok: true, currentStage: { id: 'check', kind: 'guided_check' } });
  });

  it('rejects a manipulate teaching move without a compiled check in conversation-led and orient stages', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    seedCompiledLesson(repo, session.id, 'conversation_led');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'session.updated' });
    await flushProxy();

    upstream.emit({ type: 'response.created', response: { id: 'manip-response' } });
    upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'manip-response', call_id: 'manip-call', name: 'propose_teaching_move',
      arguments: JSON.stringify({
        rationale: 'Invent a manipulate task', microObjective: 'Move a mark', strategy: 'invented',
        childFacingText: 'Slide the mark.', questionOrTask: 'Slide the mark to one half.',
        taskId: 'invented-manip', responseMode: 'manipulate', proposedAction: 'question',
      }),
    });
    await flushProxy();
    expect(toolOutput(upstream, 'manip-call')).toMatchObject({
      ok: false,
      error: expect.stringContaining('compiled manipulativeCheck'),
    });
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

  it('drops late transcript events for a cancelled response', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, { apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id, createUpstream: () => new FakeUpstream() as never });
    client.emit('message', JSON.stringify(createRuntimeEvent({ ...identity, sessionId: session.id }, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'response.created', response: { id: 'cancelled' } });
    upstream.emit({ type: 'response.done', response: { id: 'cancelled', status: 'cancelled', output: [] } });
    upstream.emit({ type: 'response.output_audio_transcript.delta', response_id: 'cancelled', item_id: 'item', delta: 'Never heard.' });
    upstream.emit({ type: 'response.output_audio_transcript.done', response_id: 'cancelled', transcript: 'Never heard.' });
    await flushProxy();
    expect(client.sent.filter((event) => ['transcript_delta', 'transcript_done', 'board_ops', 'lesson_state'].includes(event.type))).toEqual([]);
    expect(repo.listEvents(session.id).some((event) => event.type === 'tutor_said')).toBe(false);
  });

  it('sends lesson-state semantic cues immediately, tagged with their response for playback binding', async () => {
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
    upstream.emit({ type: 'response.created', response: { id: 'move-response' } });
    upstream.emit({ type: 'response.function_call_arguments.done', response_id: 'move-response', call_id: 'call-1', name: 'propose_teaching_move', arguments: move });
    await flushProxy();

    const states = client.sent.filter((event) => event.type === 'lesson_state');
    expect(states).toHaveLength(1);
    expect(states[0].providerResponseId).toBe('move-response');
    expect('audioSampleOffsets' in states[0]).toBe(false);
  });
});

describe('realtime proxy telemetry', () => {
  it('persists client-carried response correlation only for the same accepted generation', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    const accepted = {
      sessionId: session.id,
      connectionEpoch: 4,
      turnId: 'turn-correlated',
      generationId: 'generation-correlated',
    };
    client.emit('message', JSON.stringify(createRuntimeEvent(accepted, 0, 'hello', {})));
    FakeUpstream.latest.emit({
      type: 'response.created',
      response: { id: 'response-correlated' },
    });
    await flushProxy();

    const metric = {
      schemaVersion: '1.0.0',
      name: 'board_reveal_to_narration',
      unit: 'ms',
      value: -40,
      visualCueId: 'cue-correlated',
    };
    client.emit('message', JSON.stringify(createRuntimeEvent(
      accepted,
      1,
      'metric',
      metric,
      { providerResponseId: 'response-correlated' },
    )));
    client.emit('message', JSON.stringify(createRuntimeEvent(
      accepted,
      2,
      'metric',
      { ...metric, visualCueId: 'cue-unknown' },
      { providerResponseId: 'response-unknown' },
    )));
    const nextGeneration = {
      ...accepted,
      generationId: 'generation-next',
    };
    client.emit('message', JSON.stringify(createRuntimeEvent(
      nextGeneration,
      0,
      'metric',
      { ...metric, visualCueId: 'cue-mismatched' },
      { providerResponseId: 'response-correlated' },
    )));
    await flushProxy();

    const observations = repo.listEvents(session.id)
      .map((event) => event.payload as Record<string, unknown>);
    expect(observations).toEqual([
      expect.objectContaining({
        name: 'board_reveal_to_narration',
        generationId: expect.stringMatching(/^tel2_/),
        providerResponseId: expect.stringMatching(/^tel2_/),
        visualCueId: expect.stringMatching(/^tel2_/),
      }),
    ]);
    expect(JSON.stringify(observations)).not.toContain('response-correlated');
    expect(JSON.stringify(observations)).not.toContain('cue-correlated');
    expect(JSON.stringify(observations)).not.toContain('response-unknown');
    expect(JSON.stringify(observations)).not.toContain('cue-mismatched');
  });

  it('omits real client-carried response correlation from other allowed metrics', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    const accepted = {
      sessionId: session.id,
      connectionEpoch: 5,
      turnId: 'turn-known-response',
      generationId: 'generation-known-response',
    };
    client.emit('message', JSON.stringify(createRuntimeEvent(accepted, 0, 'hello', {})));
    FakeUpstream.latest.emit({
      type: 'response.created',
      response: { id: 'response-known' },
    });
    await flushProxy();

    const metrics = [
      { schemaVersion: '1.0.0', name: 'speech_end_to_response_started', unit: 'ms', value: 50 },
      { schemaVersion: '1.0.0', name: 'speech_end_to_first_audio', unit: 'ms', value: 240 },
      { schemaVersion: '1.0.0', name: 'ask_to_first_audio', unit: 'ms', value: 300 },
      {
        schemaVersion: '1.0.0',
        name: 'barge_in_gate_outcome',
        unit: 'count',
        value: 1,
        dimensions: { outcome: 'local_only_rejected' },
      },
      {
        schemaVersion: '1.0.0',
        name: 'barge_in_gate_outcome',
        unit: 'count',
        value: 1,
        dimensions: { outcome: 'provider_only_rejected' },
      },
      {
        schemaVersion: '1.0.0',
        name: 'section_navigation',
        unit: 'count',
        value: 1,
        dimensions: {
          previousSemanticGroupId: 'section-1',
          nextSemanticGroupId: 'section-2',
          cause: 'picker',
        },
      },
      {
        schemaVersion: '1.0.0',
        name: 'tutor_object_disappearance',
        unit: 'count',
        value: 1,
        dimensions: { objectId: 'object-1', cause: 'scene_mutation' },
      },
      {
        schemaVersion: '1.0.0',
        name: 'media_playback_outcome',
        unit: 'count',
        value: 1,
        dimensions: { outcome: 'autoplay_blocked' },
      },
    ] as const;

    for (const [index, metric] of metrics.entries()) {
      client.emit('message', JSON.stringify(createRuntimeEvent(
        accepted,
        index + 1,
        'metric',
        metric,
        { providerResponseId: 'response-known' },
      )));
    }
    await flushProxy();

    const observations = repo.listEvents(session.id)
      .map((event) => event.payload as Record<string, unknown>);
    expect(observations.map((observation) => observation.name)).toEqual(
      metrics.map((metric) => metric.name),
    );
    expect(observations.every(
      (observation) => !('providerResponseId' in observation),
    )).toBe(true);
  });

  it('records every browser-observed metric without accepting client terminal correlation', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    const active = {
      sessionId: session.id,
      connectionEpoch: 7,
      turnId: 'turn-authoritative',
      generationId: 'generation-authoritative',
    };
    const allowed = [
      { schemaVersion: '1.0.0', name: 'speech_end_to_response_started', unit: 'ms', value: 50 },
      { schemaVersion: '1.0.0', name: 'speech_end_to_first_audio', unit: 'ms', value: 240 },
      { schemaVersion: '1.0.0', name: 'ask_to_first_audio', unit: 'ms', value: 300 },
      {
        schemaVersion: '1.0.0',
        name: 'board_reveal_to_narration',
        unit: 'ms',
        value: -20,
        visualCueId: 'cue-1',
        semanticObjectId: 'object-1',
      },
      {
        schemaVersion: '1.0.0',
        name: 'barge_in_gate_outcome',
        unit: 'count',
        value: 1,
        dimensions: { outcome: 'local_only_rejected' },
      },
      {
        schemaVersion: '1.0.0',
        name: 'barge_in_gate_outcome',
        unit: 'count',
        value: 1,
        dimensions: { outcome: 'provider_only_rejected' },
      },
      {
        schemaVersion: '1.0.0',
        name: 'section_navigation',
        unit: 'count',
        value: 1,
        dimensions: {
          previousSemanticGroupId: 'section-1',
          nextSemanticGroupId: 'section-2',
          cause: 'picker',
        },
      },
      {
        schemaVersion: '1.0.0',
        name: 'tutor_object_disappearance',
        unit: 'count',
        value: 1,
        dimensions: { objectId: 'object-1', cause: 'scene_mutation' },
      },
    ] as const;

    for (const [sequence, payload] of allowed.entries()) {
      client.emit('message', JSON.stringify(createRuntimeEvent(
        active,
        sequence,
        'metric',
        {
          ...payload,
          connectionEpoch: 999,
          turnId: 'turn-payload-forged',
          generationId: 'generation-payload-forged',
          providerResponseId: 'response-payload-forged',
        },
        { providerResponseId: 'response-envelope-forged' },
      )));
    }
    await flushProxy();

    const observations = repo.listEvents(session.id).map((event) => event.payload as Record<string, unknown>);
    expect(observations.map((observation) => observation.name)).toEqual([
      'speech_end_to_response_started',
      'speech_end_to_first_audio',
      'ask_to_first_audio',
      'barge_in_gate_outcome',
      'barge_in_gate_outcome',
      'section_navigation',
      'tutor_object_disappearance',
    ]);
    expect(observations).toEqual(observations.map(() => expect.objectContaining({
      connectionEpoch: 7,
      turnId: expect.stringMatching(/^tel2_/),
      generationId: expect.stringMatching(/^tel2_/),
    })));
    expect(JSON.stringify(observations)).not.toContain('turn-authoritative');
    expect(JSON.stringify(observations)).not.toContain('generation-authoritative');
    expect(observations.every((observation) => !('providerResponseId' in observation))).toBe(true);
  });

  it.each([
    ['provider_usage', {
      schemaVersion: '1.0.0',
      name: 'provider_usage',
      unit: 'count',
      value: 0,
      dimensions: {
        totalTokens: 0,
        inputTextTokens: 0,
        inputAudioTokens: 0,
        inputImageTokens: 0,
        cachedTextTokens: 0,
        cachedAudioTokens: 0,
        cachedImageTokens: 0,
        outputTextTokens: 0,
        outputAudioTokens: 0,
      },
    }],
    ['tutor_audio_output_duration', {
      schemaVersion: '1.0.0',
      name: 'tutor_audio_output_duration',
      unit: 'ms',
      value: 10,
    }],
    ['session_reconnect', {
      schemaVersion: '1.0.0',
      name: 'session_reconnect',
      unit: 'count',
      value: 1,
    }],
    ['barge_in_cancel_outcome: provider_cancelled', {
      schemaVersion: '1.0.0',
      name: 'barge_in_cancel_outcome',
      unit: 'count',
      value: 1,
      dimensions: { outcome: 'provider_cancelled' },
    }],
    ['barge_in_cancel_outcome: provider_completed', {
      schemaVersion: '1.0.0',
      name: 'barge_in_cancel_outcome',
      unit: 'count',
      value: 1,
      dimensions: { outcome: 'provider_completed' },
    }],
    ['barge_in_cancel_outcome: provider_failed', {
      schemaVersion: '1.0.0',
      name: 'barge_in_cancel_outcome',
      unit: 'count',
      value: 1,
      dimensions: { outcome: 'provider_failed' },
    }],
    ['barge_in_gate_outcome: confirmed', {
      schemaVersion: '1.0.0',
      name: 'barge_in_gate_outcome',
      unit: 'count',
      value: 1,
      dimensions: { outcome: 'confirmed' },
    }],
    ['oversized client_queue_overflow', {
      schemaVersion: '1.0.0',
      name: 'telemetry_gap',
      unit: 'count',
      value: Number.MAX_SAFE_INTEGER,
      dimensions: { reason: 'client_queue_overflow' },
    }],
    ['unknown_metric', {
      schemaVersion: '1.0.0',
      name: 'unknown_metric',
      unit: 'count',
      value: 1,
    }],
  ] as const)('rejects client-origin %s while recording an allowed control', async (_label, rejected) => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    const active = { ...identity, sessionId: session.id };

    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'metric', {
      schemaVersion: '1.0.0',
      name: 'speech_end_to_first_audio',
      unit: 'ms',
      value: 240,
    })));
    client.emit('message', JSON.stringify(createRuntimeEvent(
      active,
      1,
      'metric',
      rejected,
      { providerResponseId: 'response-client-forged' },
    )));
    await flushProxy();

    expect(repo.listEvents(session.id).map((event) => event.payload)).toEqual([
      expect.objectContaining({
        name: 'speech_end_to_first_audio',
        connectionEpoch: active.connectionEpoch,
        turnId: expect.stringMatching(/^tel2_/),
        generationId: expect.stringMatching(/^tel2_/),
      }),
    ]);
  });

  it('does not record a reconnect when a released client metric precedes the first start', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    const active = { ...identity, sessionId: session.id };

    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'metric', {
      schemaVersion: '1.0.0',
      name: 'speech_end_to_first_audio',
      unit: 'ms',
      value: 240,
    })));
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'start', {})));
    await flushProxy();

    const events = repo.listEvents(session.id);
    expect(events.filter((event) => event.type === 'session_started')).toHaveLength(1);
    expect(events.filter(
      (event) => event.type === 'metric' &&
        (event.payload as { name?: unknown }).name === 'speech_end_to_first_audio',
    )).toEqual([
      expect.objectContaining({ released: true }),
    ]);
    expect(events.filter(
      (event) => event.type === 'metric' &&
        (event.payload as { name?: unknown }).name === 'session_reconnect',
    )).toEqual([]);
  });

  it('pages released history to find a prior start beyond 5,000 later events', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const firstClient = new FakeClient();
    await connectRealtimeProxy(firstClient as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    firstClient.emit('message', JSON.stringify(createRuntimeEvent({
      sessionId: session.id,
      connectionEpoch: 1,
      turnId: 'turn-first',
      generationId: 'generation-first',
    }, 0, 'start', {})));
    await flushProxy();

    const originalStart = repo.listEvents(session.id).find((event) => event.type === 'session_started');
    expect(originalStart).toBeDefined();
    expect(repo.listEvents(session.id).filter((event) => event.type === 'metric')).toEqual([]);
    for (let index = 0; index < 5_001; index += 1) {
      repo.addEvent(session.id, 'history_filler', { index });
    }

    const secondClient = new FakeClient();
    await connectRealtimeProxy(secondClient as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    const listEvents = repo.listEvents.bind(repo);
    const listEventsSpy = vi.spyOn(repo, 'listEvents').mockImplementation(
      (targetSessionId, limit, throughEventId) => listEvents(targetSessionId, limit, throughEventId),
    );
    secondClient.emit('message', JSON.stringify(createRuntimeEvent({
      sessionId: session.id,
      connectionEpoch: 2,
      turnId: 'turn-second',
      generationId: 'generation-second',
    }, 0, 'start', {})));
    await flushProxy();

    const reconnectQueries = listEventsSpy.mock.calls.filter((call) => call[1] === 5_000);
    const newestStart = listEvents(session.id, 5_010)
      .filter((event) => event.type === 'session_started')
      .at(-1);
    expect(reconnectQueries).toEqual([
      [session.id, 5_000, (newestStart?.id ?? 1) - 1],
      [session.id, 5_000, (originalStart?.id ?? 0) + 1],
    ]);
    const events = listEvents(session.id, 5_010);
    expect(events.filter((event) => event.type === 'session_started').map((event) => event.payload)).toEqual([
      expect.objectContaining({ connectionEpoch: 1 }),
      expect.objectContaining({ connectionEpoch: 2 }),
    ]);
    expect(events.filter((event) => event.type === 'metric')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          name: 'session_reconnect',
          connectionEpoch: 2,
          turnId: expect.stringMatching(/^tel2_/),
          generationId: expect.stringMatching(/^tel2_/),
        }),
      }),
    ]);
  });

  it('requests the initial response when reconnect telemetry persistence fails', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    repo.addEvent(session.id, 'session_started', { connectionEpoch: 1 });
    failMetricWrites(repo);
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    const upstream = FakeUpstream.latest;

    client.emit('message', JSON.stringify(createRuntimeEvent({
      sessionId: session.id,
      connectionEpoch: 2,
      turnId: 'turn-reconnect',
      generationId: 'generation-reconnect',
    }, 0, 'start', {})));
    await flushProxy();

    expect(upstream.sent.map((raw) => JSON.parse(raw) as { type: string }))
      .toContainEqual(expect.objectContaining({ type: 'response.create' }));
    expect(repo.listEvents(session.id).filter((event) => event.type === 'session_started')).toHaveLength(2);
    expect(client.sent.some((event) => event.type === 'error')).toBe(false);
  });

  it('requests the initial response when reconnect history lookup fails', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    repo.addEvent(session.id, 'learner_said', { text: 'released history' });
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    const upstream = FakeUpstream.latest;
    const listEvents = repo.listEvents.bind(repo);
    vi.spyOn(repo, 'listEvents').mockImplementation(
      (targetSessionId, limit, throughEventId) => {
        if (throughEventId !== undefined && throughEventId !== null) {
          throw new Error('telemetry history unavailable');
        }
        return listEvents(targetSessionId, limit, throughEventId);
      },
    );

    client.emit('message', JSON.stringify(createRuntimeEvent({
      sessionId: session.id,
      connectionEpoch: 1,
      turnId: 'turn-first',
      generationId: 'generation-first',
    }, 0, 'start', {})));
    await flushProxy();

    expect(upstream.sent.map((raw) => JSON.parse(raw) as { type: string }))
      .toContainEqual(expect.objectContaining({ type: 'response.create' }));
    expect(listEvents(session.id).filter((event) => event.type === 'session_started')).toHaveLength(1);
    expect(listEvents(session.id).filter((event) => event.type === 'metric').map(
      (event) => event.payload,
    )).toEqual([
      expect.objectContaining({
        name: 'telemetry_gap',
        dimensions: { reason: 'server_history_failure' },
        value: 1,
      }),
    ]);
    expect(client.sent.some((event) => event.type === 'error')).toBe(false);
  });

  it('awaits unresolved history telemetry before lifecycle completion', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    let resolveHistory!: (value: boolean) => void;
    const history = new Promise<boolean>((resolve) => { resolveHistory = resolve; });
    const historyStarted = deferred<void>();
    const metrics: MetricObservation[] = [];
    let lifecycle: ProxyLifecycle | null = null;
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      telemetryRepo: {
        async appendMetric(_sessionId, observation) {
          metrics.push(observation);
          return metrics.length;
        },
        hasPriorReleasedSessionStart: () => {
          historyStarted.resolve();
          return history;
        },
      },
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
      onLifecycle: (value) => { lifecycle = value; },
    });
    client.emit('message', JSON.stringify(createRuntimeEvent({
      sessionId: session.id,
      connectionEpoch: 1,
      turnId: 'turn-first',
      generationId: 'generation-first',
    }, 0, 'start', {})));
    await historyStarted.promise;
    const closing = lifecycle!.close();
    client.emit('message', JSON.stringify(createRuntimeEvent({
      sessionId: session.id,
      connectionEpoch: 1,
      turnId: 'turn-after-close',
      generationId: 'generation-after-close',
    }, 1, 'user_text', {
      text: 'must not persist',
      idempotencyKey: 'after-close-message',
    })));
    FakeUpstream.latest.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'must not persist upstream',
    });
    let settled = false;
    void closing.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveHistory(true);
    await expect(closing).resolves.toBeUndefined();
    expect(metrics).toEqual([
      expect.objectContaining({ name: 'session_reconnect' }),
    ]);
    expect(repo.listEvents(session.id).filter((event) =>
      event.type === 'learner_said')).toEqual([]);
  });

  it('force-terminalizes unresolved history without late telemetry submission', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    let resolveHistory!: (value: boolean) => void;
    const history = new Promise<boolean>((resolve) => { resolveHistory = resolve; });
    const historyForceStarted = deferred<void>();
    const metrics: MetricObservation[] = [];
    let lifecycle: ProxyLifecycle | null = null;
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      telemetryRepo: {
        async appendMetric(_sessionId, observation) {
          metrics.push(observation);
          return metrics.length;
        },
        hasPriorReleasedSessionStart: () => {
          historyForceStarted.resolve();
          return history;
        },
      },
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
      onLifecycle: (value) => { lifecycle = value; },
    });
    client.emit('message', JSON.stringify(createRuntimeEvent({
      sessionId: session.id,
      connectionEpoch: 1,
      turnId: 'turn-first',
      generationId: 'generation-first',
    }, 0, 'start', {})));
    await historyForceStarted.promise;
    await flushProxy();
    const closing = lifecycle!.close();
    await lifecycle!.forceTerminal();
    await expect(lifecycle!.completion).resolves.toBeUndefined();
    resolveHistory(true);
    await flushProxy();
    expect(metrics).toEqual([]);
    await expect(closing).resolves.toBeUndefined();
  });

  it('fails forced shutdown when a sealed client producer is still unsettled', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const originalListEvents = repo.listEvents.bind(repo);
    const blockedEvents = deferred<ReturnType<typeof repo.listEvents>>();
    const producerEntered = deferred<void>();
    const registry = new ProxyLifecycleRegistry();
    const client = new FakeClient();
    let lifecycle: ProxyLifecycle | null = null;
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
      onLifecycle: (value) => {
        lifecycle = value;
        registry.register(value);
      },
    });
    const listEvents = vi.spyOn(repo, 'listEvents').mockImplementation(
      () => {
        producerEntered.resolve();
        return blockedEvents.promise as never;
      },
    );
    client.emit('message', JSON.stringify(createRuntimeEvent({
      sessionId: session.id,
      connectionEpoch: 1,
      turnId: 'turn-first',
      generationId: 'generation-first',
    }, 0, 'start', {})));
    await producerEntered.promise;

    const repositoryClose = vi.fn(async () => {});
    const fatal = vi.fn();
    const result = await runQuiescentShutdown({
      stopAccepting: () => {},
      closeClients: () => {},
      closeProxies: () => registry.shutdown(5),
      closeRepository: repositoryClose,
      log: () => {},
      fatal,
    });
    expect(result).toBe('fatal');
    expect(repositoryClose).not.toHaveBeenCalled();
    expect(fatal).toHaveBeenCalledWith(expect.any(Error));

    blockedEvents.resolve(originalListEvents(session.id, 2_000));
    await expect(lifecycle!.completion).resolves.toBeUndefined();
    listEvents.mockRestore();
  });

  it('flushes response cues and sends response_done when telemetry persistence fails', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    failMetricWrites(repo);
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    const responseId = 'response-observer-failure';
    upstream.emit({ type: 'response.created', response: { id: responseId } });
    upstream.emit({
      type: 'response.function_call_arguments.done',
      response_id: responseId,
      call_id: 'move-observer-failure',
      name: 'propose_teaching_move',
      arguments: JSON.stringify({
        rationale: 'fixture',
        microObjective: 'fraction comparison',
        strategy: 'shared scale',
        childFacingText: 'Compare the marks.',
        proposedAction: 'explain',
      }),
    });
    upstream.emit({
      type: 'response.output_audio.delta',
      response_id: responseId,
      item_id: 'item-observer-failure',
      delta: Buffer.alloc(2_400 * 2).toString('base64'),
    });
    await flushProxy();

    upstream.emit({
      type: 'response.done',
      response: { id: responseId, status: 'completed', output: [{ type: 'function_call' }] },
    });
    await flushProxy();

    expect(client.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'lesson_state' }),
      expect.objectContaining({
        type: 'response_done',
        payload: expect.objectContaining({ response_id: responseId, status: 'completed' }),
      }),
    ]));
  });

  it.each([
    ['cancelled', 'provider_cancelled'],
    ['completed', 'provider_completed'],
    ['failed', 'provider_failed'],
  ] as const)('correlates a confirmed voice barge-in with a %s provider response', async (status, outcome) => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    const active = {
      sessionId: session.id,
      connectionEpoch: 3,
      turnId: 'turn-barge-in',
      generationId: 'generation-barge-in',
    };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'response.created', response: { id: 'response-active' } });
    await flushProxy();

    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'interrupt', { reason: 'voice' })));
    await flushProxy();
    expect(repo.listEvents(session.id).filter((event) => event.type === 'metric').map((event) => event.payload)).toEqual([
      expect.objectContaining({
        name: 'barge_in_gate_outcome',
        dimensions: { outcome: 'confirmed' },
        providerResponseId: expect.stringMatching(/^tel2_/),
      }),
    ]);

    upstream.emit({ type: 'response.done', response: { id: 'response-unrelated', status, output: [] } });
    await flushProxy();
    expect(repo.listEvents(session.id).filter((event) => event.type === 'metric')).toHaveLength(1);

    upstream.emit({ type: 'response.done', response: { id: 'response-active', status, output: [] } });
    await flushProxy();
    const terminalMetrics = repo.listEvents(session.id)
      .filter((event) => event.type === 'metric')
      .map((event) => event.payload as Record<string, unknown>);
    expect(terminalMetrics).toEqual([
      expect.objectContaining({
        name: 'barge_in_gate_outcome',
        dimensions: { outcome: 'confirmed' },
        providerResponseId: expect.stringMatching(/^tel2_/),
      }),
      expect.objectContaining({
        name: 'barge_in_cancel_outcome',
        dimensions: { outcome },
        providerResponseId: expect.stringMatching(/^tel2_/),
      }),
    ]);
    expect(terminalMetrics[0]?.providerResponseId)
      .toBe(terminalMetrics[1]?.providerResponseId);
    expect(JSON.stringify(terminalMetrics)).not.toContain('response-active');
  });

  it('does not record a voice gate outcome for a non-voice interruption', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'response.created', response: { id: 'response-non-voice' } });
    await flushProxy();

    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'metric', {
      schemaVersion: '1.0.0',
      name: 'speech_end_to_response_started',
      unit: 'ms',
      value: 50,
    })));
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 2, 'interrupt', { reason: 'keyboard' })));
    upstream.emit({
      type: 'response.done',
      response: { id: 'response-non-voice', status: 'cancelled', output: [] },
    });
    await flushProxy();

    expect(repo.listEvents(session.id).filter((event) => event.type === 'metric').map((event) => event.payload)).toEqual([
      expect.objectContaining({
        schemaVersion: '1.0.0',
        name: 'speech_end_to_response_started',
        value: 50,
        connectionEpoch: active.connectionEpoch,
        turnId: expect.stringMatching(/^tel2_/),
        generationId: expect.stringMatching(/^tel2_/),
      }),
    ]);
  });

  it('records bounded provider usage and audio output duration without provider content', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'response.created', response: { id: 'response-usage' } });
    upstream.emit({
      type: 'response.done',
      response: {
        id: 'response-usage',
        status: 'completed',
        output: [],
        text: 'secret provider response text',
        audio: 'secret-provider-audio-bytes',
        usage: {
          total_tokens: 253,
          input_tokens: 132,
          output_tokens: 121,
          input_token_details: {
            text_tokens: 119,
            audio_tokens: 13,
            image_tokens: 0,
            cached_tokens: 64,
            cached_tokens_details: { text_tokens: 64, audio_tokens: 0, image_tokens: 0 },
          },
          output_token_details: { text_tokens: 30, audio_tokens: 91 },
        },
      },
    });
    await flushProxy();
    // The browser reports how long the WebRTC track actually played.
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'playback_boundary', {
      response_id: 'response-usage', boundary: 'stopped', playedMs: 500,
    })));
    await flushProxy();

    const metrics = repo.listEvents(session.id).filter((event) => event.type === 'metric');
    expect(metrics.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        name: 'provider_usage',
        value: 253,
        providerResponseId: expect.stringMatching(/^tel2_/),
        dimensions: {
          totalTokens: 253,
          inputTextTokens: 119,
          inputAudioTokens: 13,
          inputImageTokens: 0,
          cachedTextTokens: 64,
          cachedAudioTokens: 0,
          cachedImageTokens: 0,
          outputTextTokens: 30,
          outputAudioTokens: 91,
        },
      }),
      expect.objectContaining({
        name: 'tutor_audio_output_duration',
        unit: 'ms',
        value: 500,
        providerResponseId: expect.stringMatching(/^tel2_/),
      }),
    ]);
    const providerIds = metrics.map(
      (event) => (event.payload as { providerResponseId?: string }).providerResponseId,
    );
    expect(providerIds[0]).toBe(providerIds[1]);
    expect(JSON.stringify(metrics)).not.toContain('response-usage');
    expect(JSON.stringify(metrics)).not.toContain('secret provider response text');
    expect(JSON.stringify(metrics)).not.toContain('secret-provider-audio-bytes');
  });

  it('does not fabricate provider usage zeros when required fields are missing', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({ type: 'response.created', response: { id: 'response-partial-usage' } });
    upstream.emit({
      type: 'response.done',
      response: {
        id: 'response-partial-usage',
        status: 'completed',
        output: [],
        usage: {
          total_tokens: 10,
          input_token_details: { text_tokens: 10 },
        },
      },
    });
    await flushProxy();
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'playback_boundary', {
      response_id: 'response-partial-usage', boundary: 'stopped', playedMs: 5,
    })));
    await flushProxy();

    const metrics = repo.listEvents(session.id).filter((event) => event.type === 'metric');
    expect(metrics.map((event) => (event.payload as { name?: unknown }).name)).toEqual([
      'tutor_audio_output_duration',
    ]);
    expect(metrics[0]?.payload).toMatchObject({
      value: 5,
      providerResponseId: expect.stringMatching(/^tel2_/),
    });
    expect(JSON.stringify(metrics)).not.toContain('response-partial-usage');
  });

  it('does not emit terminal telemetry for an unknown response.done identity', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    const upstream = FakeUpstream.latest;
    upstream.emit({
      type: 'response.done',
      response: {
        id: 'unknown-response',
        status: 'cancelled',
        output: [],
        usage: {
          total_tokens: 2,
          input_token_details: {
            text_tokens: 1,
            audio_tokens: 0,
            image_tokens: 0,
            cached_tokens_details: {
              text_tokens: 0,
              audio_tokens: 0,
              image_tokens: 0,
            },
          },
          output_token_details: { text_tokens: 1, audio_tokens: 0 },
        },
      },
    });
    await flushProxy();

    expect(repo.listEvents(session.id).filter((event) => event.type === 'metric')).toEqual([]);
    expect(client.sent).toContainEqual(expect.objectContaining({
      type: 'response_done',
      payload: expect.objectContaining({
        response_id: 'unknown-response',
        status: 'cancelled',
      }),
    }));
  });

  it('requests the initial response and processes later client input before prior-start lookup resolves', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const baseRepo = new Repo(openTestDb());
    const child = baseRepo.createChild('Maya', 10);
    const session = baseRepo.createSession(child.id, 'fractions');
    baseRepo.addEvent(session.id, 'session_started', { connectionEpoch: 1 });
    const history = deferred<ReturnType<Repo['listEvents']>>();
    const boundedQueries: number[] = [];
    const repo = Object.create(baseRepo) as DomainRepository;
    repo.listEvents = (targetSessionId, limit, throughEventId) => {
      if (throughEventId !== undefined && throughEventId !== null) {
        boundedQueries.push(throughEventId);
        return history.promise;
      }
      return baseRepo.listEvents(targetSessionId, limit, throughEventId);
    };
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    const active = {
      sessionId: session.id,
      connectionEpoch: 2,
      turnId: 'turn-reconnect-private',
      generationId: 'generation-reconnect-private',
    };
    const upstream = FakeUpstream.latest;

    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'start', {})));
    await flushProxy();
    expect(upstream.sent.map((raw) => JSON.parse(raw) as { type: string }))
      .toContainEqual(expect.objectContaining({ type: 'response.create' }));
    const currentStart = baseRepo.listEvents(session.id).at(-1);
    expect(currentStart?.type).toBe('session_started');
    expect(boundedQueries).toEqual([(currentStart?.id ?? 0) - 1]);

    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'user_text', {
      text: 'later client input', idempotencyKey: 'later-client-input',
    })));
    await flushProxy();
    expect(upstream.sent.map((raw) => JSON.parse(raw) as { type: string }))
      .toContainEqual(expect.objectContaining({ type: 'conversation.item.create' }));

    history.resolve(baseRepo.listEvents(session.id, 5_000, (currentStart?.id ?? 1) - 1));
    await flushProxy();
    await flushProxy();
    expect(baseRepo.listEvents(session.id).some(
      (event) => event.type === 'metric'
        && (event.payload as { name?: unknown }).name === 'session_reconnect',
    )).toBe(true);
  });

  it('sends cancel and processes later client messages before telemetry persistence resolves', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const baseRepo = new Repo(openTestDb());
    const child = baseRepo.createChild('Maya', 10);
    const session = baseRepo.createSession(child.id, 'fractions');
    const metricWrite = deferred<number>();
    const repo = Object.create(baseRepo) as DomainRepository;
    repo.addEvent = (targetSessionId, type, payload, released) => type === 'metric'
      ? metricWrite.promise
      : baseRepo.addEvent(targetSessionId, type, payload, released);
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    const active = { ...identity, sessionId: session.id };
    const upstream = FakeUpstream.latest;
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    upstream.emit({ type: 'response.created', response: { id: 'response-delayed-cancel' } });
    await flushProxy();

    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'interrupt', { reason: 'voice' })));
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 2, 'user_text', {
      text: 'later after cancel', idempotencyKey: 'later-after-cancel',
    })));
    await flushProxy();

    const sent = upstream.sent.map((raw) => JSON.parse(raw) as { type: string });
    expect(sent).toContainEqual(expect.objectContaining({ type: 'response.cancel' }));
    expect(sent).toContainEqual(expect.objectContaining({ type: 'conversation.item.create' }));
    metricWrite.resolve(1);
  });

  it('flushes cues and response_done before delayed terminal telemetry writes resolve', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const baseRepo = new Repo(openTestDb());
    const child = baseRepo.createChild('Maya', 10);
    const session = baseRepo.createSession(child.id, 'fractions');
    const metricWrite = deferred<number>();
    const repo = Object.create(baseRepo) as DomainRepository;
    repo.addEvent = (targetSessionId, type, payload, released) => type === 'metric'
      ? metricWrite.promise
      : baseRepo.addEvent(targetSessionId, type, payload, released);
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    const active = { ...identity, sessionId: session.id };
    const upstream = FakeUpstream.latest;
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    upstream.emit({ type: 'response.created', response: { id: 'response-delayed-done' } });
    upstream.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-delayed-done',
      call_id: 'move-delayed-done',
      name: 'propose_teaching_move',
      arguments: JSON.stringify({
        rationale: 'fixture',
        microObjective: 'fraction comparison',
        strategy: 'shared scale',
        childFacingText: 'Compare the marks.',
        proposedAction: 'explain',
      }),
    });
    upstream.emit({
      type: 'response.output_audio.delta',
      response_id: 'response-delayed-done',
      item_id: 'item-delayed-done',
      delta: Buffer.alloc(2_400 * 2).toString('base64'),
    });
    await flushProxy();

    upstream.emit({
      type: 'response.done',
      response: {
        id: 'response-delayed-done',
        status: 'completed',
        output: [{ type: 'function_call' }],
        usage: completeProviderUsage(9),
      },
    });
    await flushProxy();

    expect(client.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'lesson_state' }),
      expect.objectContaining({
        type: 'response_done',
        payload: expect.objectContaining({ response_id: 'response-delayed-done' }),
      }),
    ]));
    metricWrite.resolve(1);
  });

  it('records terminal provider telemetry once for duplicate response.done', async () => {
    vi.stubGlobal('WebSocket', FakeUpstream);
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');
    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture',
      model: 'gpt-realtime-2.1',
      repo,
      sessionId: session.id,
      createUpstream: () => new FakeUpstream() as never,
    });
    const active = { ...identity, sessionId: session.id };
    const upstream = FakeUpstream.latest;
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    upstream.emit({ type: 'response.created', response: { id: 'response-duplicate-done' } });
    await flushProxy();
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 1, 'interrupt', { reason: 'voice' })));
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 2, 'playback_boundary', {
      response_id: 'response-duplicate-done', boundary: 'stopped', playedMs: 100,
    })));
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 3, 'playback_boundary', {
      response_id: 'response-duplicate-done', boundary: 'stopped', playedMs: 100,
    })));
    await flushProxy();

    const done = {
      type: 'response.done',
      response: {
        id: 'response-duplicate-done',
        status: 'cancelled',
        output: [],
        usage: completeProviderUsage(9),
      },
    };
    upstream.emit(done);
    upstream.emit(done);
    await flushProxy();
    await flushProxy();

    const names = repo.listEvents(session.id)
      .filter((event) => event.type === 'metric')
      .map((event) => (event.payload as { name?: unknown }).name);
    expect(names.filter((name) => name === 'provider_usage')).toHaveLength(1);
    expect(names.filter((name) => name === 'tutor_audio_output_duration')).toHaveLength(1);
    expect(names.filter((name) => name === 'barge_in_cancel_outcome')).toHaveLength(1);
  });
});

async function flushProxy(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function failMetricWrites(repo: Repo): void {
  const addEvent = repo.addEvent.bind(repo);
  vi.spyOn(repo, 'addEvent').mockImplementation((sessionId, type, payload, released) => {
    if (type === 'metric') throw new Error('telemetry store unavailable');
    return addEvent(sessionId, type, payload, released);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function completeProviderUsage(totalTokens: number) {
  return {
    total_tokens: totalTokens,
    input_token_details: {
      text_tokens: Math.max(0, totalTokens - 2),
      audio_tokens: 0,
      image_tokens: 0,
      cached_tokens_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0 },
    },
    output_token_details: { text_tokens: 1, audio_tokens: 1 },
  };
}
