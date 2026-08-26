/// <reference lib="dom" />

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompiledLessonSchema, COMPILED_LESSON_SCHEMA_VERSION } from '../../shared/compiledLesson';
import type { RuntimeEventEnvelope } from '../../shared/runtimeProtocol';
import { RealtimeSession, type VisualCueMetadata } from '../../src/lesson/realtimeSession';
import { FakeVoiceTransport } from '../../src/lesson/fakeVoiceTransport';
import { openTestDb } from '../store/db';
import { Repo } from '../store/repo';
import { connectRealtimeProxy } from './proxy';

/**
 * The interleaved anchor build end-to-end and fully offline: raw provider
 * events → the real sideband coordinator and storyboard runner → real
 * envelopes → the real RealtimeSession cue timeline under the fake voice
 * transport. Reveals land exactly at playback boundaries, narration beats
 * come between reveals, an interruption resumes at the first unrevealed
 * step, and no revealed object ever disappears.
 */

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
  beatCreates(): Array<{ instructions?: string; max_output_tokens?: number }> {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string; response?: { instructions?: string; max_output_tokens?: number } })
      .filter((event) => event.type === 'response.create' && typeof event.response?.instructions === 'string')
      .map((event) => event.response as { instructions?: string; max_output_tokens?: number });
  }
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
  connectVoice(): Promise<void>;
  send(type: string, payload: Record<string, unknown>): void;
}

function seedBoardLedLesson(repo: Repo, sessionId: string): void {
  repo.upsertCompiledLesson(sessionId, {
    status: 'ready',
    lesson: CompiledLessonSchema.parse({
      compiledLessonId: `compiled-${sessionId}`,
      schemaVersion: COMPILED_LESSON_SCHEMA_VERSION,
      goal: 'Compare two fractions on one number line',
      objective: 'Compare two fractions on one number line',
      blueprint: {
        blueprintId: `blueprint-${sessionId}`,
        goal: 'Compare two fractions on one number line',
        mode: 'board_led',
        successCriteria: ['Learner places fractions on one shared scale'],
        anchor: { semanticGroupId: 'lesson-anchor', template: 'fraction_comparison', instructionalQuestion: 'Which fraction is larger?', invariantObjectIds: [] },
        stages: [
          {
            id: 'orient', kind: 'orient', objective: 'Recall what a fraction shows', boardPurpose: 'establish_anchor',
            allowedBoardMutation: 'establish', learnerOpportunity: 'Say what the parts mean', evidenceExpected: 'recall',
            checks: [{ id: 'orient-check', questionOrTask: 'Which mark is farther right?', responseMode: 'voice' }],
          },
          { id: 'model', kind: 'model', objective: 'Place both fractions', boardPurpose: 'reveal_relation', allowedBoardMutation: 'extend', learnerOpportunity: 'Predict the farther mark', evidenceExpected: 'comparison' },
          { id: 'check', kind: 'guided_check', objective: 'Compare the visible marks', boardPurpose: 'elicit_learner_work', allowedBoardMutation: 'emphasize', learnerOpportunity: 'Circle the larger fraction', evidenceExpected: 'identification' },
        ],
        currentStageIndex: 0,
        detourStack: [],
      },
      anchorScene: {
        groupId: 'lesson-anchor',
        groupLabel: 'Fraction number line',
        template: 'fraction_comparison',
        ops: [
          { op: 'add', id: 'anchor-scale', spec: { kind: 'numberline', at: [130, 300], w: 740, min: 0, max: 1 } },
          { op: 'add', id: 'anchor-mark', spec: { kind: 'point', at: [620, 300], label: '2/3' } },
          { op: 'add', id: 'anchor-label', spec: { kind: 'text', at: [130, 250], text: 'One shared scale' } },
        ],
        storyboard: [
          { id: 'reveal-outline', reveal: 'outline', narration: 'Here is one number line from zero to one.', objectIds: ['anchor-scale'] },
          { id: 'reveal-relation', reveal: 'relation', narration: 'This mark sits at two thirds.', objectIds: ['anchor-mark'] },
          { id: 'reveal-label', reveal: 'label', narration: 'Both fractions will live on this same scale.', objectIds: ['anchor-label'] },
        ],
      },
      compiledAt: 0,
      compilerModel: 'test-double',
    }),
  });
}

interface AppliedReveal { checkpoint?: string; ids: string[]; ops: Array<{ op: string }> }

async function createHarness() {
  vi.stubGlobal('WebSocket', FakeUpstream);
  const repo = new Repo(openTestDb());
  const child = repo.createChild('Maya', 10);
  const storedSession = repo.createSession(child.id, 'fractions');
  seedBoardLedLesson(repo, storedSession.id);
  window.sessionStorage.setItem(`noura.lessonCapability.${storedSession.id}`, 'offline-capability');
  const client = new FakeClient();
  let voice!: FakeVoiceTransport;
  const session = new RealtimeSession(storedSession.id, (input) => {
    voice = new FakeVoiceTransport(input.handlers);
    return voice;
  });
  const internals = session as unknown as SessionInternals;
  void internals.connectVoice();
  const applied: AppliedReveal[] = [];
  session.onBoardOps = async (ops, _animate, _identity, cue?: VisualCueMetadata) => {
    applied.push({
      checkpoint: cue?.checkpoint,
      ids: ops.flatMap((op) => (op.op === 'add' ? [op.id] : [])),
      ops: ops.map((op) => ({ op: op.op })),
    });
    return true;
  };
  await connectRealtimeProxy(client as never, {
    apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo, sessionId: storedSession.id,
    createUpstream: () => new FakeUpstream() as never,
    preflightTimeoutMs: 800,
  });
  const upstream = FakeUpstream.latest;
  let delivered = 0;
  internals.ws = {
    readyState: 1,
    send: (raw) => { void client.emit('message', raw); },
    close: () => {},
  };
  internals.send('hello', {});

  return {
    repo, session, voice, upstream, client, applied,
    sessionId: storedSession.id,
    async pump(): Promise<void> {
      for (let round = 0; round < 8; round += 1) {
        await flushProxy();
        for (const envelope of client.sent.slice(delivered)) internals.handleServer(envelope);
        delivered = client.sent.length;
      }
    },
    async establishAnchor(): Promise<void> {
      // The establishing response speaks first, then requests the visual.
      this.voice.emitBoundary('started', 'anchor-response');
      upstream.emit({ type: 'response.created', response: { id: 'anchor-response' } });
      upstream.emit({
        type: 'response.function_call_arguments.done', response_id: 'anchor-response', call_id: 'anchor-call', name: 'request_visual',
        arguments: JSON.stringify({
          schemaVersion: '3.0.0', requestId: 'anchor-request', action: 'establish',
          purpose: 'Anchor the comparison', idea: 'Both fractions on one shared number line', density: 'minimal',
        }),
      });
      // The session's default preflight handler approves through the loop.
      await this.pump();
      upstream.emit({ type: 'response.done', response: { id: 'anchor-response', status: 'completed', output: [{ type: 'function_call' }] } });
      await this.pump();
    },
    async playBeat(responseId: string, playedMs = 900): Promise<void> {
      upstream.emit({ type: 'response.created', response: { id: responseId } });
      await this.pump();
      this.voice.emitBoundary('started', responseId);
      upstream.emit({ type: 'response.done', response: { id: responseId, status: 'completed', output: [] } });
      await this.pump();
      this.voice.emitBoundary('stopped', responseId, playedMs);
      await this.pump();
    },
  };
}

function flushProxy(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => vi.unstubAllGlobals());

describe('interleaved anchor build through the real session', () => {
  it('reveals each step at a playback boundary with a narration beat between reveals', async () => {
    const harness = await createHarness();
    await harness.establishAnchor();
    // The establishing response is still audibly playing: nothing revealed.
    expect(harness.applied).toEqual([]);
    expect(harness.upstream.beatCreates()).toHaveLength(0);

    // Its playback boundary reveals ONLY step one; the first beat follows.
    harness.voice.emitBoundary('stopped', 'anchor-response', 1_500);
    await harness.pump();
    expect(harness.applied.map((reveal) => reveal.ids)).toEqual([['anchor-scale']]);
    expect(harness.upstream.beatCreates()).toHaveLength(1);
    expect(harness.upstream.beatCreates()[0].instructions).toContain('Here is one number line from zero to one.');

    // Beat one plays; step two appears exactly at its stop boundary.
    await harness.playBeat('beat-0');
    expect(harness.applied.map((reveal) => reveal.ids)).toEqual([['anchor-scale'], ['anchor-mark']]);
    expect(harness.upstream.beatCreates()).toHaveLength(2);
    expect(harness.upstream.beatCreates()[1].instructions).toContain('This mark sits at two thirds.');

    // Beat two plays; the final step appears at its boundary; the closing
    // handoff response carries the stage's exact check wording.
    await harness.playBeat('beat-1');
    expect(harness.applied.map((reveal) => reveal.ids)).toEqual([['anchor-scale'], ['anchor-mark'], ['anchor-label']]);
    await harness.playBeat('beat-2');
    const handoff = harness.upstream.beatCreates().at(-1);
    expect(handoff?.instructions).toContain('Which mark is farther right?');
    expect(handoff?.max_output_tokens).toBeUndefined();

    // Everything the child saw is released, replayable board truth, in
    // storyboard order, and nothing was ever erased or cleared.
    expect(harness.applied.every((reveal) => reveal.ops.every((op) => op.op === 'add'))).toBe(true);
    const released = harness.repo.listEvents(harness.sessionId)
      .filter((event) => event.type === 'semantic_scene');
    expect(released).toHaveLength(3);
    harness.session.end();
  });

  it('a barge-in mid-beat cancels the narration, keeps revealed objects, and resumes the build', async () => {
    const harness = await createHarness();
    await harness.establishAnchor();
    harness.voice.emitBoundary('stopped', 'anchor-response', 1_500);
    await harness.pump();
    harness.upstream.emit({ type: 'response.created', response: { id: 'beat-0' } });
    await harness.pump();
    harness.voice.emitBoundary('started', 'beat-0');
    await harness.pump();
    expect(harness.applied.map((reveal) => reveal.ids)).toEqual([['anchor-scale']]);

    // Dual-confirmed barge-in mid-narration: provider speech start plus
    // sustained local mic energy. Playback clears; the beat is cancelled.
    harness.upstream.emit({ type: 'input_audio_buffer.speech_started' });
    await harness.pump();
    for (let frame = 0; frame < 7; frame += 1) (harness.session as unknown as SessionInternals).handleMicEnergy(0.09);
    await harness.pump();
    expect(harness.voice.playbackClears).toBe(1);
    harness.upstream.emit({ type: 'response.done', response: { id: 'beat-0', status: 'cancelled', output: [] } });
    await harness.pump();

    // The learner asks; the ordinary machinery answers.
    harness.upstream.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Wait — why does it stop at one?' });
    harness.upstream.emit({ type: 'input_audio_buffer.speech_stopped' });
    await harness.pump();
    harness.upstream.emit({ type: 'response.created', response: { id: 'answer-response' } });
    await harness.pump();
    harness.voice.emitBoundary('started', 'answer-response');
    harness.upstream.emit({ type: 'response.done', response: { id: 'answer-response', status: 'completed', output: [] } });
    await harness.pump();
    // While the answer still plays, nothing new appears.
    expect(harness.applied.map((reveal) => reveal.ids)).toEqual([['anchor-scale']]);

    // The answer's playback boundary reveals the first unrevealed step and
    // the resume beat reconnects to the build.
    harness.voice.emitBoundary('stopped', 'answer-response', 1_200);
    await harness.pump();
    await harness.pump();
    expect(harness.applied.map((reveal) => reveal.ids)).toEqual([['anchor-scale'], ['anchor-mark']]);
    const resumeBeat = harness.upstream.beatCreates().at(-1);
    expect(resumeBeat?.instructions).toContain('Back to our picture');
    expect(resumeBeat?.instructions).toContain('This mark sits at two thirds.');

    // Permanence: every applied operation ever sent to the board is an add.
    expect(harness.applied.every((reveal) => reveal.ops.every((op) => op.op === 'add'))).toBe(true);
    harness.session.end();
  });
});
