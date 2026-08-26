import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createRuntimeEvent, type GenerationIdentity, type RuntimeEventEnvelope } from '../../shared/runtimeProtocol';
import { openTestDb } from '../store/db';
import { Repo } from '../store/repo';
import { SidebandRegistry } from './callBootstrap';
import { connectRealtimeProxy } from './proxy';

class FakeUpstream {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  url: string;
  constructor(url = 'wss://fake') { this.url = url; }
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

function makeSession() {
  const repo = new Repo(openTestDb());
  const child = repo.createChild('Maya', 10);
  const session = repo.createSession(child.id, 'fractions');
  return { repo, session };
}

describe('sideband attach', () => {
  it('attaches to the persisted call id instead of opening a model session', async () => {
    const { repo, session } = makeSession();
    repo.addEvent(session.id, 'voice_call', { callId: 'rtc_attach_1' });
    const client = new FakeClient();
    let seenUrl = '';
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id,
      createUpstream: (url) => { seenUrl = url; return new FakeUpstream(url) as never; },
    });
    expect(seenUrl).toBe('wss://api.openai.com/v1/realtime?call_id=rtc_attach_1');
  });

  it('adopts the bootstrap sideband and replays its buffered frames into the coordinator', async () => {
    const { repo, session } = makeSession();
    repo.addEvent(session.id, 'voice_call', { callId: 'rtc_adopt_1' });
    const registry = new SidebandRegistry();
    const stashed = new FakeUpstream('wss://api.openai.com/v1/realtime?call_id=rtc_adopt_1');
    registry.stash(session.id, 'rtc_adopt_1', stashed as never);
    // Provider events that arrived between bootstrap and envelope connect.
    stashed.emit({ type: 'session.updated' });

    const client = new FakeClient();
    await connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id,
      sidebandRegistry: registry,
      createUpstream: () => { throw new Error('adoption must not open a second sideband'); },
    });
    const active = { ...identity, sessionId: session.id };
    client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.sent.some((event) => event.type === 'ready')).toBe(true);
    // The adopted socket, already configured at bootstrap, receives no
    // duplicate initial session.update on adoption.
    expect(stashed.sent.filter((raw) => (JSON.parse(raw) as { type: string }).type === 'session.update')).toHaveLength(0);
  });

  it('rejects an envelope connection when no voice call was ever bootstrapped', async () => {
    const { repo, session } = makeSession();
    const client = new FakeClient();
    await expect(connectRealtimeProxy(client as never, {
      apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id,
    })).rejects.toThrow(/voice call/i);
  });

  it('a sideband reconnect reattaches the same call and restores floor, blueprint, and board', async () => {
    const { repo, session } = makeSession();
    repo.addEvent(session.id, 'voice_call', { callId: 'rtc_reconnect_1' });
    // Prior lesson history: a released tutor drawing and a delivered task.
    repo.addEvent(session.id, 'board_ops', {
      semanticObjectId: 'anchor-section',
      groupLabel: 'Number line',
      ops: [{ op: 'add', id: 'anchor-line', spec: { kind: 'line', from: [100, 300], to: [900, 300] } }],
    });
    repo.addEvent(session.id, 'lesson_blueprint', {
      blueprint: {
        goal: 'Compare two fractions on one number line',
        mode: 'board_led',
        successCriteria: ['places fractions'],
        anchor: { template: 'fraction_comparison', semanticGroupId: 'anchor-section', question: 'Which is larger?' },
        stages: [{ id: 'orient', kind: 'orient', objective: 'Recall', boardPurpose: 'establish_anchor', allowedBoardMutation: 'establish', learnerOpportunity: 'Say', evidenceExpected: 'recall' }],
        currentStageIndex: 0,
        detourStack: [],
      },
    });
    repo.addEvent(session.id, 'learner_task', {
      task: { taskId: 'task-1', prompt: 'Circle the larger fraction.', responseMode: 'draw', submitPolicy: 'explicit', targetObjectIds: [], boardRevision: 0, allowVoiceWhileDrawing: true },
    });

    // First sideband connection lives and dies (Vercel recycles it).
    const first = new FakeClient();
    let firstUpstream: FakeUpstream | null = null;
    await connectRealtimeProxy(first as never, {
      apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id,
      createUpstream: (url) => { firstUpstream = new FakeUpstream(url); return firstUpstream as never; },
    });
    firstUpstream!.onopen?.();
    first.emit('message', JSON.stringify(createRuntimeEvent({ ...identity, sessionId: session.id }, 0, 'hello', {})));
    firstUpstream!.emit({ type: 'session.updated' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first.sent.some((event) => event.type === 'ready')).toBe(true);
    first.close();
    first.emit('close');

    // Second connection: same persisted call, full state restoration.
    const second = new FakeClient();
    let secondUpstream: FakeUpstream | null = null;
    await connectRealtimeProxy(second as never, {
      apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: session.id,
      createUpstream: (url) => { secondUpstream = new FakeUpstream(url); return secondUpstream as never; },
    });
    expect(secondUpstream!.url).toBe('wss://api.openai.com/v1/realtime?call_id=rtc_reconnect_1');
    secondUpstream!.onopen?.();
    second.emit('message', JSON.stringify(createRuntimeEvent({ ...identity, sessionId: session.id, connectionEpoch: 2 }, 0, 'hello', {})));
    secondUpstream!.emit({ type: 'session.updated' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(second.sent.some((event) => event.type === 'ready')).toBe(true);
    const boardReplay = second.sent.find((event) => event.type === 'board_replay');
    expect(boardReplay).toBeDefined();
    expect(JSON.stringify(boardReplay?.payload)).toContain('anchor-line');
    const restoredTask = second.sent.find((event) => event.type === 'learner_task');
    expect((restoredTask?.payload as { task?: { taskId?: string } } | undefined)?.task?.taskId).toBe('task-1');
    // The restored connection keeps the same call: no new voice_call event.
    const callEvents = repo.listEvents(session.id, 2000).filter((event) => event.type === 'voice_call');
    expect(callEvents).toHaveLength(1);
    // The reattached sideband was reconfigured with the full session config.
    const update = JSON.parse(secondUpstream!.sent[0]) as { type: string; session: { instructions: string } };
    expect(update.type).toBe('session.update');
    expect(update.session.instructions).toContain('anchor-line');
  });
});
