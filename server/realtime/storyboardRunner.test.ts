import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompiledLessonSchema, COMPILED_LESSON_SCHEMA_VERSION } from '../../shared/compiledLesson';
import { createRuntimeEvent, type GenerationIdentity, type RuntimeEventEnvelope } from '../../shared/runtimeProtocol';
import type { MetricObservation } from '../../shared/sessionTelemetry';
import type { BoardDirector, DirectorSceneRequest } from '../board/director';
import { openTestDb } from '../store/db';
import { Repo } from '../store/repo';
import { connectRealtimeProxy, type ProxyOptions } from './proxy';

/**
 * The interleaved reveal-narrate engine against the fake sideband and fake
 * client: beat ordering (reveal → narrate → reveal), floor semantics,
 * interruption with resume-at-the-first-unrevealed-step, fail-closed stops,
 * and the Director slow tier. All model interactions are scripted doubles.
 */

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
  ofType<T extends Record<string, unknown>>(type: string): T[] {
    return this.sent.map((raw) => JSON.parse(raw) as T & { type: string }).filter((event) => event.type === type);
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

const ANCHOR_STEPS = [
  { id: 'reveal-outline', reveal: 'outline', narration: 'Here is one number line from zero to one.', objectIds: ['anchor-scale'] },
  { id: 'reveal-relation', reveal: 'relation', narration: 'This mark sits at two thirds.', objectIds: ['anchor-mark'] },
  { id: 'reveal-label', reveal: 'label', narration: 'Both fractions will live on this same scale.', objectIds: ['anchor-label'] },
] as const;

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
        storyboard: ANCHOR_STEPS.map((step) => ({ ...step, objectIds: [...step.objectIds] })),
      },
      compiledAt: 0,
      compilerModel: 'test-double',
    }),
  });
}

interface ResponseCreatePayload extends Record<string, unknown> {
  type: string;
  response?: { instructions?: string; max_output_tokens?: number };
}

interface SystemNote extends Record<string, unknown> {
  type: string;
  item?: { type?: string; role?: string; content?: Array<{ text?: string }> };
}

async function connectBoardLed(
  options: Partial<ProxyOptions> & { wrapRepo?: (repo: Repo) => ProxyOptions['repo'] } = {},
) {
  vi.stubGlobal('WebSocket', FakeUpstream);
  const repo = new Repo(openTestDb());
  const child = repo.createChild('Maya', 10);
  const session = repo.createSession(child.id, 'fractions');
  seedBoardLedLesson(repo, session.id);
  const metrics: MetricObservation[] = [];
  const client = new FakeClient();
  const { wrapRepo, ...proxyOptions } = options;
  await connectRealtimeProxy(client as never, {
    apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo: wrapRepo ? wrapRepo(repo) : repo, sessionId: session.id,
    createUpstream: () => new FakeUpstream() as never,
    preflightTimeoutMs: 400,
    telemetryRepo: {
      appendMetric: async (_sessionId, observation) => { metrics.push(observation); return metrics.length; },
      hasPriorReleasedSessionStart: async () => false,
    },
    ...proxyOptions,
  });
  const active = { ...identity, sessionId: session.id };
  client.emit('message', JSON.stringify(createRuntimeEvent(active, 0, 'hello', {})));
  const sequence = { value: 1 };
  const upstream = FakeUpstream.latest;

  return {
    repo, session, client, upstream, active, metrics,
    emitClient(type: string, payload: Record<string, unknown>) {
      client.emit('message', JSON.stringify(createRuntimeEvent(active, sequence.value++, type, payload)));
    },
    boardCues() {
      return client.sent.filter((event) => event.type === 'board_ops');
    },
    responseCreates(): ResponseCreatePayload[] {
      return upstream.ofType<ResponseCreatePayload>('response.create');
    },
    /** Creates carrying per-response instructions: beats and handoffs. */
    scopedCreates(): ResponseCreatePayload[] {
      return upstream.ofType<ResponseCreatePayload>('response.create')
        .filter((event) => typeof event.response?.instructions === 'string');
    },
    systemNotes(): string[] {
      return upstream.ofType<SystemNote>('conversation.item.create')
        .filter((event) => event.item?.role === 'system')
        .map((event) => event.item?.content?.[0]?.text ?? '');
    },
    toolOutput(callId: string): Record<string, unknown> {
      const event = upstream.sent.map((raw) => JSON.parse(raw) as { type: string; item?: { call_id?: string; output?: string } })
        .find((candidate) => candidate.type === 'conversation.item.create' && candidate.item?.call_id === callId);
      return JSON.parse(event?.item?.output ?? '{}') as Record<string, unknown>;
    },
    progressEvents() {
      return repo.listEventsForInternalAudit(session.id)
        .filter((event) => event.type === 'storyboard_progress')
        .map((event) => event.payload as { runId: string; source: string; revealedSteps: number; totalSteps: number; status: string });
    },
    async establish(responseId = 'anchor-response', callId = 'anchor-call') {
      upstream.emit({ type: 'response.created', response: { id: responseId } });
      upstream.emit({
        type: 'response.function_call_arguments.done', response_id: responseId, call_id: callId, name: 'request_visual',
        arguments: JSON.stringify({
          schemaVersion: '3.0.0', requestId: 'anchor-request', action: 'establish',
          purpose: 'Anchor the comparison', idea: 'Both fractions on one shared number line', density: 'minimal',
        }),
      });
      await flushProxy();
      const preflight = [...client.sent].reverse().find((event) => event.type === 'visual_preflight');
      this.emitClient('visual_preflight_result', {
        preflight_id: (preflight!.payload as { preflight_id?: string }).preflight_id,
        accepted: true,
        reasons: [],
      });
      await flushProxy();
      await flushProxy();
    },
    showStep(cueIndex: number) {
      const cue = this.boardCues()[cueIndex];
      const eventId = (cue.payload as { event_id?: number }).event_id;
      this.emitClient('ops_presented', { event_id: eventId });
      this.emitClient('ops_shown', { event_id: eventId });
    },
  };
}

async function flushProxy(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Acknowledge a deferred covering `response.create` so the floor is free. */
async function settleUnscopedCreate(
  harness: { upstream: FakeUpstream; responseCreates(): Array<{ response?: { instructions?: string } }> },
  responseId: string,
): Promise<void> {
  const last = harness.responseCreates().at(-1);
  if (!last || last.response?.instructions) return;
  harness.upstream.emit({ type: 'response.created', response: { id: responseId } });
  harness.upstream.emit({ type: 'response.done', response: { id: responseId, status: 'completed', output: [] } });
  await flushProxy();
}

afterEach(() => vi.unstubAllGlobals());

describe('the storyboard runner', () => {
  it('plays the compiled anchor as reveal → narrate → reveal, then hands off the stage check', async () => {
    const harness = await connectBoardLed();
    await harness.establish();
    expect(harness.toolOutput('anchor-call')).toMatchObject({ ok: true, accepted: true, status: 'building' });
    // The establishing response finishes; nothing may narrate until step 0
    // is confirmed visible.
    harness.upstream.emit({ type: 'response.done', response: { id: 'anchor-response', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();
    expect(harness.responseCreates()).toHaveLength(0);
    expect(harness.boardCues()).toHaveLength(1);

    // Step 0 confirmed → beat 0 is created with per-response instructions
    // scoped to exactly that beat and a token cap.
    harness.showStep(0);
    await flushProxy();
    const beat0 = harness.scopedCreates();
    expect(beat0).toHaveLength(1);
    expect(beat0[0].response?.instructions).toContain('Here is one number line from zero to one.');
    expect(beat0[0].response?.instructions).toContain('Stop after this beat.');
    expect(beat0[0].response?.max_output_tokens).toBe(1_200);

    // Beat 0 exists → step 1's cue rides tagged to beat 0's playback.
    harness.upstream.emit({ type: 'response.created', response: { id: 'beat-0' } });
    await flushProxy();
    const cues = harness.boardCues();
    expect(cues).toHaveLength(2);
    expect(cues[1].payload).toMatchObject({ checkpoint: 'relation', response_id: 'beat-0', await_narration: true });

    // A second structural request during the build is rejected. Its tool
    // continuation races the active beat, which the provider reports as an
    // already-active response — a benign, settled race.
    harness.upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'beat-0', call_id: 'busy-call', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'busy', action: 'compare',
        purpose: 'Another picture', idea: 'A second scene', density: 'minimal',
      }),
    });
    await flushProxy();
    expect(harness.toolOutput('busy-call')).toMatchObject({ ok: false, reason: expect.stringContaining('already in progress') });
    harness.upstream.emit({ type: 'error', error: { code: 'conversation_already_has_active_response', message: 'Conversation already has an active response' } });
    await flushProxy();

    // A beat that happens to end with a question mark never becomes a
    // learner handoff: beats are tutor-floor continuations.
    harness.upstream.emit({ type: 'response.output_audio_transcript.done', response_id: 'beat-0', transcript: 'See the whole line from zero to one?' });
    harness.upstream.emit({ type: 'response.done', response: { id: 'beat-0', status: 'completed', output: [] } });
    await flushProxy();
    expect(harness.client.sent.filter((event) => event.type === 'learner_task')).toEqual([]);

    // Step 1 shown → beat 1; then the final step and its beat.
    harness.showStep(1);
    await flushProxy();
    expect(harness.scopedCreates()).toHaveLength(2);
    expect(harness.scopedCreates()[1].response?.instructions).toContain('This mark sits at two thirds.');
    harness.upstream.emit({ type: 'response.created', response: { id: 'beat-1' } });
    await flushProxy();
    expect(harness.boardCues()).toHaveLength(3);
    expect(harness.boardCues()[2].payload).toMatchObject({ checkpoint: 'label', response_id: 'beat-1' });
    harness.upstream.emit({ type: 'response.done', response: { id: 'beat-1', status: 'completed', output: [] } });
    harness.showStep(2);
    await flushProxy();
    const beat2 = harness.scopedCreates()[2];
    expect(beat2.response?.instructions).toContain('Both fractions will live on this same scale.');
    harness.upstream.emit({ type: 'response.created', response: { id: 'beat-2' } });
    await flushProxy();
    expect(harness.boardCues()).toHaveLength(3);
    harness.upstream.emit({ type: 'response.done', response: { id: 'beat-2', status: 'completed', output: [] } });
    await flushProxy();

    // After the last beat, ONE unmarked handoff response carries the
    // stage's exact check wording and no token cap.
    const handoff = harness.scopedCreates()[3];
    expect(handoff.response?.instructions).toContain('Which mark is farther right?');
    expect(handoff.response?.instructions).toContain('propose_teaching_move');
    expect(handoff.response?.max_output_tokens).toBeUndefined();
    harness.upstream.emit({ type: 'response.created', response: { id: 'handoff-response' } });
    await flushProxy();
    // The run stays open until the handoff response actually finishes.
    expect(harness.progressEvents().every((event) => event.status !== 'completed')).toBe(true);

    // The handoff response delivers the task through the EXISTING contract:
    // propose_teaching_move, then the spoken question, then delivery.
    harness.upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'handoff-response', call_id: 'move-call', name: 'propose_teaching_move',
      arguments: JSON.stringify({
        rationale: 'Deliver the stage check', microObjective: 'compare marks', strategy: 'ask about the visible marks',
        childFacingText: 'Which mark is farther right?', questionOrTask: 'Which mark is farther right?',
        taskId: 'orient-check', responseMode: 'voice', proposedAction: 'question',
      }),
    });
    await flushProxy();
    harness.upstream.emit({ type: 'response.done', response: { id: 'handoff-response', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();
    expect(harness.progressEvents().at(-1)).toMatchObject({ status: 'completed', revealedSteps: 3, totalSteps: 3, source: 'anchor' });
    expect(harness.metrics.filter((metric) => metric.name === 'storyboard_outcome')).toEqual([
      expect.objectContaining({ dimensions: { outcome: 'completed', source: 'anchor', revealedSteps: 3, totalSteps: 3 } }),
    ]);
    expect(harness.metrics.filter((metric) => metric.name === 'visual_first_paint')).toEqual([
      expect.objectContaining({ unit: 'ms', dimensions: { lane: 'anchor' } }),
    ]);
    expect(harness.metrics.filter((metric) => metric.name === 'visual_scene_complete')).toEqual([
      expect.objectContaining({ unit: 'ms', dimensions: { lane: 'anchor' } }),
    ]);
    harness.upstream.emit({ type: 'response.created', response: { id: 'ask-response' } });
    harness.upstream.emit({ type: 'response.output_audio_transcript.done', response_id: 'ask-response', transcript: 'Which mark is farther right?' });
    harness.upstream.emit({ type: 'response.done', response: { id: 'ask-response', status: 'completed', output: [] } });
    await flushProxy();
    const tasks = harness.client.sent.filter((event) => event.type === 'learner_task');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].payload).toMatchObject({ task: { taskId: 'orient-check', responseMode: 'voice' } });

    // Every revealed step is a released, replayable board event.
    const scenes = harness.repo.listEvents(harness.session.id).filter((event) => event.type === 'semantic_scene');
    expect(scenes).toHaveLength(3);
  });

  it('pauses on a barge-in mid-beat and resumes at the first unrevealed step with framing', async () => {
    const harness = await connectBoardLed();
    await harness.establish();
    harness.upstream.emit({ type: 'response.done', response: { id: 'anchor-response', status: 'completed', output: [{ type: 'function_call' }] } });
    harness.showStep(0);
    await flushProxy();
    harness.upstream.emit({ type: 'response.created', response: { id: 'beat-0' } });
    await flushProxy();
    expect(harness.boardCues()).toHaveLength(2);

    // The learner barges in while beat 0 is speaking: the beat is cancelled
    // through the ordinary generation machinery and the run pauses.
    harness.emitClient('interrupt', { reason: 'voice', heardMs: 800 });
    await flushProxy();
    expect(harness.upstream.ofType('response.cancel')).toHaveLength(1);
    harness.upstream.emit({ type: 'response.done', response: { id: 'beat-0', status: 'cancelled', output: [] } });
    await flushProxy();
    expect(harness.progressEvents().every((event) => event.status !== 'abandoned')).toBe(true);
    const beatsBeforeAnswer = harness.scopedCreates().length;

    // The learner asks; the ordinary voice turn answers.
    harness.upstream.emit({ type: 'input_audio_buffer.speech_started' });
    harness.upstream.emit({ type: 'input_audio_buffer.speech_stopped' });
    await flushProxy();
    harness.upstream.emit({ type: 'response.created', response: { id: 'answer-response' } });
    harness.upstream.emit({ type: 'response.output_audio_transcript.done', response_id: 'answer-response', transcript: 'Great question. The line shows every number between zero and one.' });
    harness.upstream.emit({ type: 'response.done', response: { id: 'answer-response', status: 'completed', output: [] } });
    await flushProxy();

    // The answer resolved the learner's turn: the pending step cue (whose
    // original envelope died with the interrupted generation) is re-sent,
    // bound to the answer's playback boundary. Revealed objects stayed —
    // nothing was ever erased.
    const cues = harness.boardCues();
    expect(cues).toHaveLength(3);
    expect(cues[2].payload).toMatchObject({
      checkpoint: 'relation',
      response_id: 'answer-response',
      event_id: (cues[1].payload as { event_id?: number }).event_id,
      await_narration: true,
    });
    expect(cues.every((cue) => (cue.payload as { ops: Array<{ op: string }> }).ops.every((op) => op.op === 'add'))).toBe(true);

    // Its confirmation produces the resume beat with reconnect framing.
    harness.showStep(2);
    await flushProxy();
    const resumeBeat = harness.scopedCreates()[beatsBeforeAnswer];
    expect(resumeBeat.response?.instructions).toContain('Back to our picture');
    expect(resumeBeat.response?.instructions).toContain('This mark sits at two thirds.');
  });

  it('abandons cleanly when a step is never confirmed, and the tutor continues honestly', async () => {
    const harness = await connectBoardLed({ stepRevealTimeoutMs: 60 });
    await harness.establish();
    harness.upstream.emit({ type: 'response.done', response: { id: 'anchor-response', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();
    // The client never confirms step 0.
    await new Promise((resolve) => setTimeout(resolve, 120));
    await flushProxy();
    expect(harness.progressEvents().at(-1)).toMatchObject({ status: 'abandoned', revealedSteps: 0, totalSteps: 3 });
    expect(harness.metrics.filter((metric) => metric.name === 'storyboard_outcome')).toEqual([
      expect.objectContaining({ dimensions: expect.objectContaining({ outcome: 'abandoned', source: 'anchor' }) }),
    ]);
    expect(harness.systemNotes().some((note) => note.includes('board build stopped early'))).toBe(true);
    // The tutor is brought back to the floor to continue with what is
    // visible instead of stalling silently.
    expect(harness.responseCreates()).toHaveLength(1);
  });

  it('fails closed when the client rejects a step, without double-injecting notes', async () => {
    const harness = await connectBoardLed();
    await harness.establish();
    harness.upstream.emit({ type: 'response.done', response: { id: 'anchor-response', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();
    const cue = harness.boardCues()[0];
    harness.emitClient('ops_rejected', {
      event_id: (cue.payload as { event_id?: number }).event_id,
      reason: 'The checkpoint exceeded the board layout budget.',
    });
    await flushProxy();
    expect(harness.progressEvents().at(-1)).toMatchObject({ status: 'abandoned' });
    const notes = harness.systemNotes();
    expect(notes.filter((note) => note.includes('Board checkpoint rejected'))).toHaveLength(1);
    expect(notes.filter((note) => note.includes('board build stopped early'))).toEqual([]);
  });

  it('builds a Director scene the same way, announced beside the anchor', async () => {
    let directorRequest: DirectorSceneRequest | null = null;
    const directVisual: BoardDirector = async (request) => {
      directorRequest = request;
      return {
        ok: true,
        scene: {
          groupId: request.sectionId,
          groupLabel: 'Equal fractions case',
          template: null,
          ops: [
            { op: 'add', id: 'eq-box', spec: { kind: 'box', at: [500, 200], w: 320, h: 120, text: 'Both shares match' } },
            { op: 'add', id: 'eq-label', spec: { kind: 'label', target: 'eq-box', side: 'below', text: 'one half equals two quarters' } },
          ],
          storyboard: [
            { id: 'eq-outline', reveal: 'outline', narration: 'Here both shares take up the same space.', objectIds: ['eq-box'] },
            { id: 'eq-label-step', reveal: 'label', narration: 'That is why the two fractions are equal.', objectIds: ['eq-label'] },
          ],
        },
      };
    };
    const harness = await connectBoardLed({ directVisual });
    harness.upstream.emit({ type: 'response.created', response: { id: 'cover-response' } });
    harness.upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'cover-response', call_id: 'compare-call', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'equal-case', action: 'compare',
        purpose: 'Contrast with an equal case', idea: 'A case where the two fractions are equal', density: 'minimal',
      }),
    });
    await flushProxy();
    // Latency cover: the tool answers immediately and the model keeps
    // teaching; the Director received the board ledger and stage brief.
    expect(harness.toolOutput('compare-call')).toMatchObject({ ok: true, status: 'preparing', semanticGroupId: 'lesson-anchor-alt1' });
    expect(directorRequest).toMatchObject({
      sectionId: 'lesson-anchor-alt1',
      stageBrief: expect.stringContaining('orient'),
      boardSummary: expect.stringContaining('board is empty'),
    });
    // Covering speech waits until the acknowledgement response finishes.
    harness.upstream.emit({ type: 'response.done', response: { id: 'cover-response', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();
    await settleUnscopedCreate(harness, 'cover-2');

    // The directed scene preflights through the client, persists for
    // reconnect, and builds step by step like the anchor.
    const preflight = [...harness.client.sent].reverse().find((event) => event.type === 'visual_preflight');
    expect(preflight?.payload).toMatchObject({ semanticObjectId: 'lesson-anchor-alt1' });
    harness.emitClient('visual_preflight_result', {
      preflight_id: (preflight!.payload as { preflight_id?: string }).preflight_id,
      accepted: true,
      reasons: [],
    });
    await flushProxy();
    await flushProxy();
    expect(harness.repo.listEvents(harness.session.id).some((event) => event.type === 'directed_scene')).toBe(true);
    const cues = harness.boardCues();
    expect(cues).toHaveLength(1);
    expect(cues[0].payload).toMatchObject({ checkpoint: 'outline', await_narration: true });

    harness.showStep(0);
    await flushProxy();
    const beat0 = harness.scopedCreates().at(-1);
    // The first beat announces the side section: the learner's view never
    // switches silently.
    expect(beat0?.response?.instructions).toContain('A new board section called “Equal fractions case”');
    expect(beat0?.response?.instructions).toContain('Here both shares take up the same space.');
    harness.upstream.emit({ type: 'response.created', response: { id: 'director-beat-0' } });
    await flushProxy();
    expect(harness.boardCues()).toHaveLength(2);
    harness.upstream.emit({ type: 'response.done', response: { id: 'director-beat-0', status: 'completed', output: [] } });
    harness.showStep(1);
    await flushProxy();
    harness.upstream.emit({ type: 'response.created', response: { id: 'director-beat-1' } });
    await flushProxy();
    harness.upstream.emit({ type: 'response.done', response: { id: 'director-beat-1', status: 'completed', output: [] } });
    await flushProxy();
    const handoff = harness.scopedCreates().at(-1);
    expect(handoff?.response?.instructions).toContain('propose_teaching_move');
    harness.upstream.emit({ type: 'response.created', response: { id: 'director-handoff' } });
    harness.upstream.emit({ type: 'response.done', response: { id: 'director-handoff', status: 'completed', output: [] } });
    await flushProxy();
    expect(harness.progressEvents().at(-1)).toMatchObject({ status: 'completed', source: 'director', revealedSteps: 2, totalSteps: 2 });
  });

  it('restores an in-progress build on reconnect and resumes at the first unrevealed step', async () => {
    const harness = await connectBoardLed();
    await harness.establish();
    harness.upstream.emit({ type: 'response.done', response: { id: 'anchor-response', status: 'completed', output: [{ type: 'function_call' }] } });
    harness.showStep(0);
    await flushProxy();
    harness.upstream.emit({ type: 'response.created', response: { id: 'beat-0' } });
    await flushProxy();
    // One of three steps is on the learner's screen; the connection drops.

    const client2 = new FakeClient();
    await connectRealtimeProxy(client2 as never, {
      apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo: harness.repo, sessionId: harness.session.id,
      createUpstream: () => new FakeUpstream() as never,
      telemetryRepo: {
        appendMetric: async () => 0,
        hasPriorReleasedSessionStart: async () => true,
      },
    });
    const upstream2 = FakeUpstream.latest;
    const active2: GenerationIdentity = { sessionId: harness.session.id, connectionEpoch: 2, turnId: 'turn-1', generationId: 'generation-1' };
    let sequence2 = 0;
    const emit2 = (type: string, payload: Record<string, unknown>) =>
      client2.emit('message', JSON.stringify(createRuntimeEvent(active2, sequence2++, type, payload)));
    emit2('hello', {});
    upstream2.emit({ type: 'session.updated' });
    await flushProxy();

    // The revealed step replays as released board truth; the unrevealed
    // steps wait — the run is restored paused, not restarted.
    const replay = client2.sent.find((event) => event.type === 'board_replay');
    expect(JSON.stringify(replay?.payload)).toContain('anchor-scale');
    expect(JSON.stringify(replay?.payload)).not.toContain('anchor-mark');
    expect(client2.sent.filter((event) => event.type === 'board_ops')).toEqual([]);

    // The resume greeting resolves; the build continues at its playback
    // boundary, at the first unrevealed step, with reconnect framing.
    emit2('start', {});
    await flushProxy();
    upstream2.emit({ type: 'response.created', response: { id: 'resume-response' } });
    upstream2.emit({ type: 'response.done', response: { id: 'resume-response', status: 'completed', output: [] } });
    await flushProxy();
    const cues = client2.sent.filter((event) => event.type === 'board_ops');
    expect(cues).toHaveLength(1);
    expect(cues[0].payload).toMatchObject({ checkpoint: 'relation', response_id: 'resume-response', await_narration: true });
    emit2('ops_shown', { event_id: (cues[0].payload as { event_id?: number }).event_id });
    await flushProxy();
    const beat = upstream2.ofType<ResponseCreatePayload>('response.create')
      .filter((event) => typeof event.response?.instructions === 'string').at(-1);
    expect(beat?.response?.instructions).toContain('resumed after a reconnection');
    expect(beat?.response?.instructions).toContain('This mark sits at two thirds.');
  });

  it('bridges a Director failure honestly and allows one simpler retry', async () => {
    let rejectDirector!: () => void;
    const directorGate = new Promise<void>((resolve) => { rejectDirector = resolve; });
    const directVisual: BoardDirector = async () => {
      await directorGate;
      return { ok: false, reasons: ['The scene never satisfied the vision inspection.'] };
    };
    const harness = await connectBoardLed({ directVisual });
    harness.upstream.emit({ type: 'response.created', response: { id: 'cover-response' } });
    harness.upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'cover-response', call_id: 'compare-call', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'doomed-case', action: 'compare',
        purpose: 'Contrast with an equal case', idea: 'A case where the two fractions are equal', density: 'minimal',
      }),
    });
    await flushProxy();
    expect(harness.toolOutput('compare-call')).toMatchObject({ status: 'preparing' });
    harness.upstream.emit({ type: 'response.done', response: { id: 'cover-response', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();
    await settleUnscopedCreate(harness, 'cover-2');
    const createsBefore = harness.responseCreates().length;
    rejectDirector();
    await flushProxy();

    // Honest bridge: the tutor hears the picture will not appear and is
    // brought back to the floor; nothing was drawn or persisted.
    expect(harness.systemNotes().some((note) => note.includes('could not be prepared'))).toBe(true);
    expect(harness.responseCreates().length).toBe(createsBefore + 1);
    expect(harness.boardCues()).toEqual([]);
    expect(harness.repo.listEventsForInternalAudit(harness.session.id).filter((event) => event.type === 'directed_scene')).toEqual([]);

    // A failed request may retry once with a simpler request in this turn.
    harness.upstream.emit({ type: 'response.created', response: { id: 'retry-response' } });
    harness.upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'retry-response', call_id: 'retry-call', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'simpler-case', action: 'compare',
        purpose: 'Contrast with an equal case', idea: 'One simple bar split into equal halves', density: 'minimal',
      }),
    });
    await flushProxy();
    expect(harness.toolOutput('retry-call')).toMatchObject({ status: 'preparing', semanticGroupId: 'lesson-anchor-alt2' });
  });

  it('completes only when the closing handoff response finishes, retrying a transient create rejection', async () => {
    const harness = await connectBoardLed();
    await harness.establish();
    harness.upstream.emit({ type: 'response.done', response: { id: 'anchor-response', status: 'completed', output: [{ type: 'function_call' }] } });
    // Play through all three steps and their beats.
    for (let step = 0; step < 3; step += 1) {
      harness.showStep(step);
      await flushProxy();
      harness.upstream.emit({ type: 'response.created', response: { id: `beat-${step}` } });
      await flushProxy();
      harness.upstream.emit({ type: 'response.done', response: { id: `beat-${step}`, status: 'completed', output: [] } });
      await flushProxy();
    }
    // The closing handoff create was sent…
    expect(harness.scopedCreates()).toHaveLength(4);
    // …but the provider rejects it: another response was already active.
    harness.upstream.emit({ type: 'error', error: { code: 'conversation_already_has_active_response', message: 'Conversation already has an active response' } });
    await flushProxy();
    // The run must NOT be completed yet: the stage check has not been handed off.
    expect(harness.progressEvents().every((event) => event.status !== 'completed')).toBe(true);

    // The blocking response resolves; the runner retries the handoff.
    harness.upstream.emit({ type: 'response.created', response: { id: 'blocking-response' } });
    harness.upstream.emit({ type: 'response.done', response: { id: 'blocking-response', status: 'completed', output: [] } });
    await flushProxy();
    const handoffs = harness.scopedCreates().filter((event) => event.response?.instructions?.includes('Which mark is farther right?'));
    expect(handoffs).toHaveLength(2);

    // The retried handoff is created — the run is still open until it finishes.
    harness.upstream.emit({ type: 'response.created', response: { id: 'handoff-response' } });
    await flushProxy();
    expect(harness.progressEvents().every((event) => event.status !== 'completed')).toBe(true);
    harness.upstream.emit({ type: 'response.done', response: { id: 'handoff-response', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();
    expect(harness.progressEvents().at(-1)).toMatchObject({ status: 'completed', revealedSteps: 3, totalSteps: 3 });
    expect(harness.metrics.filter((metric) => metric.name === 'storyboard_outcome')).toEqual([
      expect.objectContaining({ dimensions: expect.objectContaining({ outcome: 'completed' }) }),
    ]);
  });

  it('recreates a handoff that was cancelled by a barge-in instead of losing the stage check', async () => {
    const harness = await connectBoardLed();
    await harness.establish();
    harness.upstream.emit({ type: 'response.done', response: { id: 'anchor-response', status: 'completed', output: [{ type: 'function_call' }] } });
    for (let step = 0; step < 3; step += 1) {
      harness.showStep(step);
      await flushProxy();
      harness.upstream.emit({ type: 'response.created', response: { id: `beat-${step}` } });
      await flushProxy();
      harness.upstream.emit({ type: 'response.done', response: { id: `beat-${step}`, status: 'completed', output: [] } });
      await flushProxy();
    }
    harness.upstream.emit({ type: 'response.created', response: { id: 'handoff-1' } });
    await flushProxy();
    // The learner barges in while the handoff is speaking.
    harness.upstream.emit({ type: 'input_audio_buffer.speech_started' });
    harness.upstream.emit({ type: 'response.done', response: { id: 'handoff-1', status: 'cancelled', output: [] } });
    harness.upstream.emit({ type: 'input_audio_buffer.speech_stopped' });
    await flushProxy();
    expect(harness.progressEvents().every((event) => event.status !== 'completed')).toBe(true);
    // Their turn resolves; the handoff is recreated so the check is not lost.
    harness.upstream.emit({ type: 'response.created', response: { id: 'answer-response' } });
    harness.upstream.emit({ type: 'response.done', response: { id: 'answer-response', status: 'completed', output: [] } });
    await flushProxy();
    const handoffs = harness.scopedCreates().filter((event) => event.response?.instructions?.includes('Which mark is farther right?'));
    expect(handoffs).toHaveLength(2);
    harness.upstream.emit({ type: 'response.created', response: { id: 'handoff-2' } });
    harness.upstream.emit({ type: 'response.done', response: { id: 'handoff-2', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();
    expect(harness.progressEvents().at(-1)).toMatchObject({ status: 'completed' });
  });

  it('does not complete a handoff on provider failed; retries on the next quiet floor', async () => {
    const harness = await connectBoardLed();
    await harness.establish();
    harness.upstream.emit({ type: 'response.done', response: { id: 'anchor-response', status: 'completed', output: [{ type: 'function_call' }] } });
    for (let step = 0; step < 3; step += 1) {
      harness.showStep(step);
      await flushProxy();
      harness.upstream.emit({ type: 'response.created', response: { id: `beat-${step}` } });
      await flushProxy();
      harness.upstream.emit({ type: 'response.done', response: { id: `beat-${step}`, status: 'completed', output: [] } });
      await flushProxy();
    }
    harness.upstream.emit({ type: 'response.created', response: { id: 'handoff-1' } });
    await flushProxy();
    harness.upstream.emit({ type: 'response.done', response: { id: 'handoff-1', status: 'failed', output: [] } });
    await flushProxy();
    expect(harness.progressEvents().every((event) => event.status !== 'completed')).toBe(true);

    harness.upstream.emit({ type: 'response.created', response: { id: 'quiet-response' } });
    harness.upstream.emit({ type: 'response.done', response: { id: 'quiet-response', status: 'completed', output: [] } });
    await flushProxy();
    const handoffs = harness.scopedCreates().filter((event) => event.response?.instructions?.includes('Which mark is farther right?'));
    expect(handoffs.length).toBeGreaterThanOrEqual(2);
    harness.upstream.emit({ type: 'response.created', response: { id: 'handoff-2' } });
    harness.upstream.emit({ type: 'response.done', response: { id: 'handoff-2', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();
    expect(harness.progressEvents().at(-1)).toMatchObject({ status: 'completed' });
  });

  it('advances past a confirmed step only after its progress write is durable', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let gateArmed = false;
    const harness = await connectBoardLed({
      wrapRepo: (repo) => {
        const wrapped = Object.create(repo) as ProxyOptions['repo'];
        wrapped.addEvent = async (sessionId, type, payload, released) => {
          if (type === 'storyboard_progress' && gateArmed) { gateArmed = false; await writeGate; }
          return repo.addEvent(sessionId, type, payload, released);
        };
        return wrapped;
      },
    });
    await harness.establish();
    harness.upstream.emit({ type: 'response.done', response: { id: 'anchor-response', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();
    gateArmed = true;
    harness.showStep(0);
    await flushProxy();
    // The step is confirmed on screen, but the progress write has not landed
    // yet: the run must not narrate past a boundary that is not durable.
    expect(harness.scopedCreates()).toHaveLength(0);
    releaseWrite();
    await flushProxy();
    expect(harness.scopedCreates()).toHaveLength(1);
    expect(harness.progressEvents().at(-1)).toMatchObject({ status: 'active', revealedSteps: 1 });
  });

  it('a reconnect during the progress write resumes at the durable step, never skipping ahead', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let gateArmed = false;
    const harness = await connectBoardLed({
      wrapRepo: (repo) => {
        const wrapped = Object.create(repo) as ProxyOptions['repo'];
        wrapped.addEvent = async (sessionId, type, payload, released) => {
          if (type === 'storyboard_progress' && gateArmed) { gateArmed = false; await writeGate; }
          return repo.addEvent(sessionId, type, payload, released);
        };
        return wrapped;
      },
    });
    await harness.establish();
    harness.upstream.emit({ type: 'response.done', response: { id: 'anchor-response', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();
    gateArmed = true;
    harness.showStep(0);
    await flushProxy();

    // The sideband reconnects while the revealedSteps=1 write is in flight.
    const client2 = new FakeClient();
    await connectRealtimeProxy(client2 as never, {
      apiKey: 'offline-fixture', model: 'gpt-realtime-2.1', repo: harness.repo, sessionId: harness.session.id,
      createUpstream: () => new FakeUpstream() as never,
      telemetryRepo: { appendMetric: async () => 0, hasPriorReleasedSessionStart: async () => true },
    });
    const upstream2 = FakeUpstream.latest;
    const active2: GenerationIdentity = { sessionId: harness.session.id, connectionEpoch: 2, turnId: 'turn-1', generationId: 'generation-1' };
    let sequence2 = 0;
    const emit2 = (type: string, payload: Record<string, unknown>) =>
      client2.emit('message', JSON.stringify(createRuntimeEvent(active2, sequence2++, type, payload)));
    emit2('hello', {});
    upstream2.emit({ type: 'session.updated' });
    await flushProxy();
    emit2('start', {});
    await flushProxy();
    upstream2.emit({ type: 'response.created', response: { id: 'resume-response' } });
    upstream2.emit({ type: 'response.done', response: { id: 'resume-response', status: 'completed', output: [] } });
    await flushProxy();
    // Durable truth says no step is confirmed yet, so the restore re-sends
    // step 0 (idempotent re-apply) — it may not skip to step 1.
    const cues = client2.sent.filter((event) => event.type === 'board_ops');
    expect(cues).toHaveLength(1);
    expect(cues[0].payload).toMatchObject({ checkpoint: 'outline' });
    releaseWrite();
    await flushProxy();
  });
});

describe('visual request scoping across turns', () => {
  it('abandons a slow anchor preflight that completes after a learner turn, with an honest tool failure', async () => {
    const harness = await connectBoardLed({ preflightTimeoutMs: 5_000 });
    harness.upstream.emit({ type: 'response.created', response: { id: 'anchor-response' } });
    harness.upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'anchor-response', call_id: 'anchor-call', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'anchor-request', action: 'establish',
        purpose: 'Anchor the comparison', idea: 'Both fractions on one shared number line', density: 'minimal',
      }),
    });
    await flushProxy();
    const preflight = [...harness.client.sent].reverse().find((event) => event.type === 'visual_preflight');
    expect(preflight).toBeDefined();

    // The learner completes a turn while the preflight is still in flight.
    harness.upstream.emit({ type: 'input_audio_buffer.speech_started' });
    harness.upstream.emit({ type: 'input_audio_buffer.speech_stopped' });
    await flushProxy();

    // The stale acceptance arrives now: nothing may build mid-learner-turn.
    harness.emitClient('visual_preflight_result', {
      preflight_id: (preflight!.payload as { preflight_id?: string }).preflight_id,
      accepted: true,
      reasons: [],
    });
    await flushProxy();
    await flushProxy();
    expect(harness.boardCues()).toEqual([]);
    expect(harness.toolOutput('anchor-call')).toMatchObject({
      ok: false, accepted: false, reason: expect.stringContaining('moved on'),
    });
    expect(harness.metrics.filter((metric) => metric.name === 'storyboard_outcome')).toEqual([
      expect.objectContaining({ dimensions: expect.objectContaining({ outcome: 'abandoned', source: 'anchor', revealedSteps: 0 }) }),
    ]);
  });

  it('abandons an anchor preflight that completes between speech_started and speech_stopped', async () => {
    const harness = await connectBoardLed({ preflightTimeoutMs: 5_000 });
    harness.upstream.emit({ type: 'response.created', response: { id: 'anchor-response' } });
    harness.upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'anchor-response', call_id: 'anchor-call', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'anchor-request', action: 'establish',
        purpose: 'Anchor the comparison', idea: 'Both fractions on one shared number line', density: 'minimal',
      }),
    });
    await flushProxy();
    const preflight = [...harness.client.sent].reverse().find((event) => event.type === 'visual_preflight');
    expect(preflight).toBeDefined();

    harness.upstream.emit({ type: 'input_audio_buffer.speech_started' });
    await flushProxy();

    harness.emitClient('visual_preflight_result', {
      preflight_id: (preflight!.payload as { preflight_id?: string }).preflight_id,
      accepted: true,
      reasons: [],
    });
    await flushProxy();
    await flushProxy();
    expect(harness.boardCues()).toEqual([]);
    expect(harness.toolOutput('anchor-call')).toMatchObject({
      ok: false, accepted: false, reason: expect.stringContaining('moved on'),
    });
  });

  it('abandons a superseded Director completion explicitly and builds only the newest request', async () => {
    const gates = new Map<string, () => void>();
    const directVisual: BoardDirector = async (request) => {
      await new Promise<void>((resolve) => { gates.set(request.sectionId, resolve); });
      return {
        ok: true,
        scene: {
          groupId: request.sectionId,
          groupLabel: `Case ${request.sectionId}`,
          template: null,
          ops: [{ op: 'add', id: `${request.sectionId}-box`, spec: { kind: 'box', at: [500, 200], w: 320, h: 120, text: 'case' } }],
          storyboard: [{ id: `${request.sectionId}-outline`, reveal: 'outline', narration: 'Look at this case.', objectIds: [`${request.sectionId}-box`] }],
        },
      };
    };
    const harness = await connectBoardLed({ directVisual });
    harness.upstream.emit({ type: 'response.created', response: { id: 'turn1-response' } });
    harness.upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'turn1-response', call_id: 'alt1-call', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'alt1-case', action: 'compare',
        purpose: 'Contrast with an equal case', idea: 'A case where the two fractions are equal', density: 'minimal',
      }),
    });
    await flushProxy();
    expect(harness.toolOutput('alt1-call')).toMatchObject({ status: 'preparing', semanticGroupId: 'lesson-anchor-alt1' });
    harness.upstream.emit({ type: 'response.done', response: { id: 'turn1-response', status: 'completed', output: [{ type: 'function_call' }] } });

    // A learner turn starts the next teaching turn; the tutor asks for a
    // DIFFERENT comparison before the first one ever finished.
    harness.upstream.emit({ type: 'input_audio_buffer.speech_started' });
    harness.upstream.emit({ type: 'input_audio_buffer.speech_stopped' });
    await flushProxy();
    harness.upstream.emit({ type: 'response.created', response: { id: 'turn2-response' } });
    harness.upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'turn2-response', call_id: 'alt2-call', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'alt2-case', action: 'compare',
        purpose: 'Contrast with an unequal case', idea: 'A case where one fraction is clearly larger', density: 'minimal',
      }),
    });
    await flushProxy();
    expect(harness.toolOutput('alt2-call')).toMatchObject({ status: 'preparing', semanticGroupId: 'lesson-anchor-alt2' });

    // The stale alt1 completion arrives: it is abandoned explicitly (honest
    // note, telemetry), builds nothing, and interrupts nothing.
    const createsBefore = harness.responseCreates().length;
    gates.get('lesson-anchor-alt1')!();
    await flushProxy();
    expect(harness.systemNotes().filter((note) => note.includes('lesson has moved on'))).toHaveLength(1);
    expect(harness.boardCues()).toEqual([]);
    expect(harness.responseCreates().length).toBe(createsBefore);
    expect(harness.repo.listEventsForInternalAudit(harness.session.id).filter((event) => event.type === 'directed_scene')).toEqual([]);
    expect(harness.metrics.filter((metric) => metric.name === 'storyboard_outcome')).toEqual([
      expect.objectContaining({ dimensions: expect.objectContaining({ outcome: 'abandoned', source: 'director' }) }),
    ]);

    // The newest request is the one that builds.
    harness.upstream.emit({ type: 'response.done', response: { id: 'turn2-response', status: 'completed', output: [{ type: 'function_call' }] } });
    gates.get('lesson-anchor-alt2')!();
    await flushProxy();
    const preflight = [...harness.client.sent].reverse().find((event) => event.type === 'visual_preflight');
    expect(preflight?.payload).toMatchObject({ semanticObjectId: 'lesson-anchor-alt2' });
    harness.emitClient('visual_preflight_result', {
      preflight_id: (preflight!.payload as { preflight_id?: string }).preflight_id,
      accepted: true,
      reasons: [],
    });
    await flushProxy();
    await flushProxy();
    expect(harness.repo.listEvents(harness.session.id).some((event) => event.type === 'directed_scene')).toBe(true);
    expect(harness.boardCues()).toHaveLength(1);
    expect(JSON.stringify(harness.boardCues()[0].payload)).toContain('lesson-anchor-alt2');
  });

  it('abandons a Director completion that lands while another build is active, leaving that run untouched', async () => {
    let releaseDirector!: () => void;
    const directVisual: BoardDirector = async (request) => {
      await new Promise<void>((resolve) => { releaseDirector = resolve; });
      return {
        ok: true,
        scene: {
          groupId: request.sectionId,
          groupLabel: 'Slow case',
          template: null,
          ops: [
            { op: 'add', id: 'slow-box', spec: { kind: 'box', at: [500, 200], w: 320, h: 120, text: 'slow' } },
            { op: 'add', id: 'slow-label', spec: { kind: 'label', target: 'slow-box', side: 'below', text: 'late' } },
          ],
          storyboard: [
            { id: 'slow-outline', reveal: 'outline', narration: 'One.', objectIds: ['slow-box'] },
            { id: 'slow-label-step', reveal: 'label', narration: 'Two.', objectIds: ['slow-label'] },
          ],
        },
      };
    };
    const harness = await connectBoardLed({ directVisual });
    harness.upstream.emit({ type: 'response.created', response: { id: 'turn1-response' } });
    harness.upstream.emit({
      type: 'response.function_call_arguments.done', response_id: 'turn1-response', call_id: 'slow-call', name: 'request_visual',
      arguments: JSON.stringify({
        schemaVersion: '3.0.0', requestId: 'slow-case', action: 'compare',
        purpose: 'Contrast with an equal case', idea: 'A case where the two fractions are equal', density: 'minimal',
      }),
    });
    await flushProxy();
    expect(harness.toolOutput('slow-call')).toMatchObject({ status: 'preparing' });
    harness.upstream.emit({ type: 'response.done', response: { id: 'turn1-response', status: 'completed', output: [{ type: 'function_call' }] } });
    await flushProxy();
    await settleUnscopedCreate(harness, 'cover-2');

    // A learner turn, then the tutor establishes the compiled anchor: a
    // storyboard run is now active when the slow Director result lands.
    harness.upstream.emit({ type: 'input_audio_buffer.speech_started' });
    harness.upstream.emit({ type: 'input_audio_buffer.speech_stopped' });
    await flushProxy();
    await harness.establish('turn2-response', 'anchor-call');
    expect(harness.toolOutput('anchor-call')).toMatchObject({ status: 'building' });
    expect(harness.boardCues()).toHaveLength(1);

    releaseDirector();
    await flushProxy();
    // The stale completion is abandoned honestly, exactly once, and the
    // active anchor run is untouched: no failure state, no interruption.
    expect(harness.systemNotes().filter((note) => note.includes('lesson has moved on'))).toHaveLength(1);
    expect(harness.metrics.filter((metric) => metric.name === 'storyboard_outcome')).toEqual([
      expect.objectContaining({ dimensions: { outcome: 'abandoned', source: 'director', revealedSteps: 0, totalSteps: 2 } }),
    ]);
    expect(harness.progressEvents().every((event) => event.status === 'active')).toBe(true);

    // The anchor build continues normally.
    harness.upstream.emit({ type: 'response.done', response: { id: 'turn2-response', status: 'completed', output: [{ type: 'function_call' }] } });
    harness.showStep(0);
    await flushProxy();
    expect(harness.scopedCreates()).toHaveLength(1);
    expect(harness.scopedCreates()[0].response?.instructions).toContain('Here is one number line from zero to one.');
  });
});
