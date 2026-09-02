import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeEvent, type GenerationIdentity, type RuntimeEventEnvelope } from '../../shared/runtimeProtocol';
import type { MetricInput } from '../../shared/sessionTelemetry';
import { FakeVoiceTransport } from './fakeVoiceTransport';
import { RealtimeSession } from './realtimeSession';

interface SessionHarness {
  voice: FakeVoiceTransport | null;
  handleServer(raw: unknown): void;
  handleMicEnergy(rms: number): void;
  releasePending(): void;
  ws?: { readyState: number; send(raw: string): void; close?(): void };
}

interface MetricQueueHarness extends SessionHarness {
  connectionEpoch: number;
  activateScope(advanceGeneration: boolean): void;
  emitMetric(input: MetricInput, identity?: GenerationIdentity, providerResponseId?: string): void;
}

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

/** The browser↔server envelope socket, capturable per instance. */
class FakeEnvelopeSocket {
  static instances: FakeEnvelopeSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = FakeEnvelopeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  url: string;
  protocols?: string[];
  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeEnvelopeSocket.instances.push(this);
  }
  send(raw: string): void { this.sent.push(raw); }
  close(): void { this.readyState = 3; }
}

/** A session driven by a deterministic fake voice transport. */
function sessionWithVoice(): { session: RealtimeSession; harness: SessionHarness; voice: FakeVoiceTransport } {
  window.sessionStorage.setItem('noura.lessonCapability.session', 'capability');
  let voice!: FakeVoiceTransport;
  const session = new RealtimeSession('session', (input) => {
    voice = new FakeVoiceTransport(input.handlers);
    return voice;
  });
  const harness = session as unknown as SessionHarness & { connectVoice(): Promise<void> };
  void harness.connectVoice();
  return { session, harness, voice };
}

describe('RealtimeSession connecting metric queue', () => {
  it('flushes draft_restore in a bounded FIFO with the identity accepted by ready', () => {
    const session = new RealtimeSession('session');
    const harness = session as unknown as MetricQueueHarness;
    const sent: RuntimeEventEnvelope<Record<string, unknown>>[] = [];
    let readyState: number = WebSocket.CONNECTING;
    harness.ws = {
      get readyState() { return readyState; },
      send: (raw) => sent.push(JSON.parse(raw) as RuntimeEventEnvelope<Record<string, unknown>>),
      close: () => {},
    };
    const staleIdentity = session.getIdentity();

    for (let index = 0; index < 70; index += 1) {
      session.recordTutorObjectDisappearance({
        objectId: `object-${index}`,
        cause: 'scene_mutation',
      });
    }
    session.recordSectionNavigation({
      previousGroupId: null,
      nextGroupId: 'restored-group',
      cause: 'draft_restore',
    });
    harness.emitMetric({
      schemaVersion: '1.0.0',
      name: 'board_reveal_to_narration',
      unit: 'ms',
      value: 10,
    }, staleIdentity, 'response-before-boundary');
    expect(sent).toEqual([]);

    harness.connectionEpoch += 1;
    harness.activateScope(false);
    const acceptedIdentity = session.getIdentity();
    readyState = WebSocket.OPEN;
    harness.handleServer(createRuntimeEvent(acceptedIdentity, 0, 'ready', {}));

    const metrics = sent.filter((event) => event.type === 'metric');
    expect(metrics).toHaveLength(65);
    expect(metrics[0]?.payload).toEqual({
      schemaVersion: '1.0.0',
      name: 'telemetry_gap',
      unit: 'count',
      value: 7,
      dimensions: { reason: 'client_queue_overflow' },
    });
    expect(metrics.slice(1, -1).map((event) =>
      (event.payload as { dimensions: { objectId: string } }).dimensions.objectId,
    )).toEqual(Array.from({ length: 63 }, (_, index) => `object-${index + 7}`));
    expect(metrics.at(-1)?.payload).toEqual({
      schemaVersion: '1.0.0',
      name: 'section_navigation',
      unit: 'count',
      value: 1,
      dimensions: {
        previousSemanticGroupId: 'group-root',
        nextSemanticGroupId: 'restored-group',
        cause: 'draft_restore',
      },
    });
    expect(metrics).toEqual(metrics.map(() => expect.objectContaining(acceptedIdentity)));
    expect(metrics.every((event) => event.providerResponseId === undefined)).toBe(true);
    session.end();
  });

  it('clears queued metrics when the lesson ends', () => {
    const session = new RealtimeSession('session');
    const harness = session as unknown as MetricQueueHarness;
    const sent: RuntimeEventEnvelope<Record<string, unknown>>[] = [];
    let readyState: number = WebSocket.CONNECTING;
    harness.ws = {
      get readyState() { return readyState; },
      send: (raw) => sent.push(JSON.parse(raw) as RuntimeEventEnvelope<Record<string, unknown>>),
      close: () => {},
    };
    const identity = session.getIdentity();

    session.recordSectionNavigation({
      previousGroupId: null,
      nextGroupId: 'restored-group',
      cause: 'draft_restore',
    });
    session.end();

    harness.ws = {
      get readyState() { return readyState; },
      send: (raw) => sent.push(JSON.parse(raw) as RuntimeEventEnvelope<Record<string, unknown>>),
      close: () => {},
    };
    readyState = WebSocket.OPEN;
    harness.handleServer(createRuntimeEvent(identity, 0, 'ready', {}));
    expect(sent.filter((event) => event.type === 'metric')).toEqual([]);
  });
});

describe('RealtimeSession visual preflight feedback', () => {
  it('returns closed collision ids and bounds to the server', async () => {
    const { session, harness } = sessionWithVoice();
    const sent: RuntimeEventEnvelope<Record<string, unknown>>[] = [];
    harness.ws = {
      readyState: WebSocket.OPEN,
      send: (raw) => sent.push(JSON.parse(raw) as RuntimeEventEnvelope<Record<string, unknown>>),
      close: () => {},
    };
    session.onVisualPreflight = async () => ({
      accepted: false,
      reasons: ['collision:moving:fixed'],
      layoutIssues: [{
        code: 'collision',
        itemId: 'moving',
        withItemId: 'fixed',
        itemBounds: { x: 390, y: 250, w: 220, h: 100 },
        withItemBounds: { x: 390, y: 245, w: 220, h: 100 },
      }],
    });

    harness.handleServer(createRuntimeEvent(session.getIdentity(), 0, 'visual_preflight', {
      preflight_id: 'preflight-1',
      ops: [],
      semanticObjectId: 'section-1',
    }));
    await vi.waitFor(() => expect(sent.some((event) => event.type === 'visual_preflight_result')).toBe(true));

    expect(sent.find((event) => event.type === 'visual_preflight_result')?.payload).toMatchObject({
      preflight_id: 'preflight-1',
      accepted: false,
      reasons: ['collision:moving:fixed'],
      layout_issues: [expect.objectContaining({ code: 'collision', itemId: 'moving', withItemId: 'fixed' })],
    });
    session.end();
  });
});

describe('RealtimeSession playback-bound release', () => {
  it('never shows a completed subtitle before its audio starts', () => {
    const { session, harness, voice } = sessionWithVoice();
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'response_started', { response_id: 'caption-response' }));
    harness.handleServer(createRuntimeEvent(identity, 1, 'transcript_done', {
      response_id: 'caption-response', text: 'First spoken phrase. Second spoken phrase.',
    }, { providerResponseId: 'caption-response' }));
    expect(session.getSnapshot().captions).toEqual([]);

    voice.emitBoundary('started', 'caption-response');
    expect(session.getSnapshot().captions.map((line) => line.text)).toEqual(['First spoken phrase.']);
    voice.emitBoundary('stopped', 'caption-response', 2_000);
    expect(session.getSnapshot().captions.map((line) => line.text)).toEqual([
      'First spoken phrase. Second spoken phrase.',
    ]);
    expect(session.getSnapshot().captions.every((line) => !line.live)).toBe(true);
  });

  it('keeps consecutive responses ordered when an earlier final transcript arrives late', () => {
    const { session, harness, voice } = sessionWithVoice();
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'response_started', { response_id: 'r1' }));
    voice.emitBoundary('started', 'r1');
    harness.handleServer(createRuntimeEvent(identity, 1, 'transcript_delta', { response_id: 'r1', delta: 'First rough phrase. ' }));
    voice.emitBoundary('stopped', 'r1', 900);
    harness.handleServer(createRuntimeEvent(identity, 2, 'user_transcript', { text: 'Learner asks next.' }));
    harness.handleServer(createRuntimeEvent(identity, 3, 'response_started', { response_id: 'r2' }));
    voice.emitBoundary('started', 'r2');
    harness.handleServer(createRuntimeEvent(identity, 4, 'transcript_done', { response_id: 'r2', text: 'Second response.' }));
    voice.emitBoundary('stopped', 'r2', 800);
    harness.handleServer(createRuntimeEvent(identity, 5, 'transcript_done', { response_id: 'r1', text: 'First corrected phrase.' }));

    expect(session.getSnapshot().captions.map((line) => `${line.role}:${line.text}`)).toEqual([
      'tutor:First corrected phrase.',
      'child:Learner asks next.',
      'tutor:Second response.',
    ]);
  });

  it('an interruption freezes the heard subtitle and rejects the unheard tail', () => {
    const { session, harness, voice } = sessionWithVoice();
    const identity = session.getIdentity();
    harness.ws = { readyState: 1, send: () => {} };
    harness.handleServer(createRuntimeEvent(identity, 0, 'response_started', { response_id: 'interrupted-caption' }));
    harness.handleServer(createRuntimeEvent(identity, 1, 'transcript_done', {
      response_id: 'interrupted-caption', text: 'Heard phrase. Unheard future phrase.',
    }));
    voice.emitBoundary('started', 'interrupted-caption');
    session.sendText('Stop there.');

    expect(session.getSnapshot().captions).toEqual([
      { role: 'tutor', text: 'Heard phrase.', live: false, responseId: 'interrupted-caption' },
    ]);
  });

  it('keeps subtitles useful when the media connection fails', () => {
    const { session, harness, voice } = sessionWithVoice();
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'response_started', { response_id: 'caption-only' }));
    harness.handleServer(createRuntimeEvent(identity, 1, 'transcript_done', {
      response_id: 'caption-only', text: 'This caption remains available.',
    }));
    expect(session.getSnapshot().captions).toEqual([]);
    voice.fail();
    expect(session.getSnapshot().captions.map((line) => line.text)).toEqual(['This caption remains available.']);
  });

  it('acknowledges first paint before draw-on animation completion', async () => {
    const { session, harness } = sessionWithVoice();
    const sent: RuntimeEventEnvelope<Record<string, unknown>>[] = [];
    harness.ws = {
      readyState: 1,
      send: (raw) => sent.push(JSON.parse(raw) as RuntimeEventEnvelope<Record<string, unknown>>),
    };
    let finishAnimation!: () => void;
    const animation = new Promise<void>((resolve) => { finishAnimation = resolve; });
    session.onBoardOps = async (_ops, _animate, identity, cue) => {
      session.noteBoardReveal(identity, cue ?? {});
      await animation;
      return true;
    };
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'board_ops', {
      response_id: 'draw-response', event_id: 91, ops: [],
    }, { providerResponseId: 'draw-response' }));

    await vi.waitFor(() => expect(sent.some((event) => event.type === 'ops_presented')).toBe(true));
    expect(sent.find((event) => event.type === 'ops_presented')?.payload).toEqual({ event_id: 91 });
    expect(sent.some((event) => event.type === 'ops_shown')).toBe(false);

    finishAnimation();
    await vi.waitFor(() => expect(sent.some((event) => event.type === 'ops_shown')).toBe(true));
  });

  it('renders Director candidates through the connected lesson browser', async () => {
    const { session, harness } = sessionWithVoice();
    const sent: RuntimeEventEnvelope<Record<string, unknown>>[] = [];
    harness.ws = {
      readyState: 1,
      send: (raw) => sent.push(JSON.parse(raw) as RuntimeEventEnvelope<Record<string, unknown>>),
    };
    session.onVisualRender = vi.fn(async () => 'data:image/jpeg;base64,Y2FuZGlkYXRl');
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'visual_render', {
      render_id: 'render-1',
      semanticObjectId: 'lesson-anchor',
      ops: [{ op: 'add', id: 'line', spec: { kind: 'line', from: [0, 0], to: [10, 10] } }],
    }));

    await vi.waitFor(() => expect(sent.some((event) => event.type === 'visual_render_result')).toBe(true));
    expect(session.onVisualRender).toHaveBeenCalledWith(expect.any(Array), 'lesson-anchor');
    expect(sent.find((event) => event.type === 'visual_render_result')?.payload).toEqual({
      render_id: 'render-1',
      image_data_url: 'data:image/jpeg;base64,Y2FuZGlkYXRl',
    });
  });

  it('releases captions and ordinary visuals on arrival but holds lesson state while the response plays', async () => {
    const { session, harness, voice } = sessionWithVoice();
    const board = vi.fn(async () => true);
    session.onBoardOps = board;
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'response_started', { response_id: 'response' }));
    voice.emitBoundary('started', 'response');

    harness.handleServer(createRuntimeEvent(identity, 1, 'transcript_delta', { response_id: 'response', delta: 'First phrase. ' }, { providerResponseId: 'response' }));
    harness.handleServer(createRuntimeEvent(identity, 2, 'board_ops', {
      response_id: 'response', event_id: 12, ops: [],
    }, { providerResponseId: 'response', visualCueId: 'cue', semanticObjectId: 'fraction-scale' }));
    harness.handleServer(createRuntimeEvent(identity, 3, 'lesson_state', {
      response_id: 'response', state: { activeConcept: 'future concept', characterAttentionTarget: 'semantic_object' },
    }, { providerResponseId: 'response', semanticObjectId: 'fraction-scale' }));

    expect(session.getSnapshot().captions.map((caption) => caption.text)).toEqual(['First phrase.']);
    expect(session.getSnapshot().lessonState).toEqual({});
    await vi.waitFor(() => expect(board).toHaveBeenCalledTimes(1));

    voice.emitBoundary('stopped', 'response', 4_000);
    await vi.waitFor(() => expect(session.getSnapshot().lessonState).toMatchObject({
      activeConcept: 'future concept',
      characterAttentionTarget: 'semantic_object',
    }));
  });

  it('releases visuals immediately when their response is not audibly playing', async () => {
    const { session, harness } = sessionWithVoice();
    const board = vi.fn(async () => true);
    session.onBoardOps = board;
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'response_started', { response_id: 'tool-first' }));
    // A staged plan arrives before any audio: the visibility barrier depends
    // on rendering now so the tool result can return and speech can begin.
    harness.handleServer(createRuntimeEvent(identity, 1, 'board_ops', {
      response_id: 'tool-first', event_id: 5, ops: [],
    }, { providerResponseId: 'tool-first' }));
    await vi.waitFor(() => expect(board).toHaveBeenCalledTimes(1));
  });

  it('sends interrupt with heard playback duration and relays the stop boundary for telemetry', () => {
    const now = vi.spyOn(performance, 'now');
    const { session, harness, voice } = sessionWithVoice();
    const sent: RuntimeEventEnvelope<Record<string, unknown>>[] = [];
    harness.ws = {
      readyState: 1,
      send: (raw) => sent.push(JSON.parse(raw) as RuntimeEventEnvelope<Record<string, unknown>>),
    };
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'response_started', { response_id: 'response-1' }));
    voice.emitBoundary('started', 'response-1');
    voice.advancePlayback(1_234);
    now.mockReturnValue(80);
    harness.handleServer(createRuntimeEvent(identity, 1, 'speech_started', {}));
    for (let frame = 1; frame <= 7; frame += 1) {
      now.mockReturnValue(80 + frame * 40);
      harness.handleMicEnergy(0.09);
    }

    expect(sent.filter((event) => event.type === 'interrupt').map((event) => event.payload))
      .toEqual([{ reason: 'voice', heardMs: 1_234 }]);
    expect(sent.filter((event) => event.type === 'playback_boundary').map((event) => event.payload))
      .toEqual([{ response_id: 'response-1', boundary: 'stopped', playedMs: 1_234 }]);
    expect(voice.playbackClears).toBe(1);
    expect(voice.suppressedResponses).toContain('response-1');
    expect(session.getIdentity()).toMatchObject({
      turnId: 'turn-1',
      generationId: 'generation-1',
    });
  });

  it('does not interrupt on server VAD or a short local noise burst alone', () => {
    const { session, harness, voice } = sessionWithVoice();
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'response_started', { response_id: 'response' }));
    voice.emitBoundary('started', 'response');
    harness.handleServer(createRuntimeEvent(identity, 1, 'speech_started', {}));
    for (let frame = 0; frame < 3; frame += 1) harness.handleMicEnergy(0.12);
    expect(session.getIdentity()).toEqual(identity);
  });

  it('emits typed speech and ask timing metrics with identity only in the envelope', () => {
    const now = vi.spyOn(performance, 'now');
    const { session, harness, voice } = sessionWithVoice();
    const sent: RuntimeEventEnvelope<Record<string, unknown>>[] = [];
    harness.ws = {
      readyState: 1,
      send: (raw) => sent.push(JSON.parse(raw) as RuntimeEventEnvelope<Record<string, unknown>>),
      close: () => {},
    };
    let identity = session.getIdentity();

    now.mockReturnValue(1_000);
    harness.handleServer(createRuntimeEvent(identity, 0, 'speech_stopped', {}));
    now.mockReturnValue(1_180);
    harness.handleServer(createRuntimeEvent(identity, 1, 'response_started', { response_id: 'voice-reply' }));
    now.mockReturnValue(1_450);
    voice.emitBoundary('started', 'voice-reply');

    now.mockReturnValue(2_000);
    session.sendText('What is one half?');
    identity = session.getIdentity();
    now.mockReturnValue(2_300);
    harness.handleServer(createRuntimeEvent(identity, 0, 'response_started', { response_id: 'text-reply' }));
    voice.emitBoundary('started', 'text-reply');

    const metrics = sent.filter((event) => event.type === 'metric');
    expect(metrics.map((event) => event.payload)).toEqual([
      {
        schemaVersion: '1.0.0',
        name: 'speech_end_to_response_started',
        unit: 'ms',
        value: 180,
      },
      {
        schemaVersion: '1.0.0',
        name: 'speech_end_to_first_audio',
        unit: 'ms',
        value: 450,
      },
      {
        schemaVersion: '1.0.0',
        name: 'ask_to_first_audio',
        unit: 'ms',
        value: 300,
      },
    ]);
    expect(metrics).toEqual(metrics.map(() => expect.objectContaining({
      sessionId: 'session',
      connectionEpoch: identity.connectionEpoch,
      turnId: expect.any(String),
      generationId: expect.any(String),
    })));
    expect(metrics.every((event) => {
      const payload = event.payload;
      return !('connectionEpoch' in payload) &&
        !('turnId' in payload) &&
        !('generationId' in payload) &&
        !('providerResponseId' in payload);
    })).toBe(true);
    session.end();
  });

  it('emits rejected local-only and provider-only gate observations', () => {
    const now = vi.spyOn(performance, 'now');
    const { harness, voice } = sessionWithVoice();
    const sent: RuntimeEventEnvelope<Record<string, unknown>>[] = [];
    harness.ws = {
      readyState: 1,
      send: (raw) => sent.push(JSON.parse(raw) as RuntimeEventEnvelope<Record<string, unknown>>),
    };
    const session = (harness as unknown as { getIdentity(): GenerationIdentity; });
    const identity = session.getIdentity();
    voice.emitBoundary('started', 'response');

    now.mockReturnValue(0);
    harness.handleServer(createRuntimeEvent(identity, 0, 'speech_started', {}));
    now.mockReturnValue(100);
    harness.handleServer(createRuntimeEvent(identity, 1, 'speech_stopped', {}));
    for (let frame = 1; frame <= 7; frame += 1) {
      now.mockReturnValue(200 + frame * 40);
      harness.handleMicEnergy(0.09);
    }
    now.mockReturnValue(200 + 7 * 40 + 161);
    harness.handleMicEnergy(0.005);

    const metrics = sent.filter((event) => event.type === 'metric');
    expect(metrics.map((event) => event.payload)).toEqual([
      {
        schemaVersion: '1.0.0',
        name: 'barge_in_gate_outcome',
        unit: 'count',
        value: 1,
        dimensions: { outcome: 'provider_only_rejected' },
      },
      {
        schemaVersion: '1.0.0',
        name: 'barge_in_gate_outcome',
        unit: 'count',
        value: 1,
        dimensions: { outcome: 'local_only_rejected' },
      },
    ]);
    expect(metrics.every((event) => event.providerResponseId === undefined)).toBe(true);
  });

  it('correlates playback start with a current board reveal in the envelope', () => {
    const now = vi.spyOn(performance, 'now');
    const { session, harness, voice } = sessionWithVoice();
    const sent: RuntimeEventEnvelope<Record<string, unknown>>[] = [];
    harness.ws = {
      readyState: 1,
      send: (raw) => sent.push(JSON.parse(raw) as RuntimeEventEnvelope<Record<string, unknown>>),
    };
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'response_started', { response_id: 'response-1' }));
    now.mockReturnValue(1_050);
    voice.emitBoundary('started', 'response-1');
    now.mockReturnValue(1_820);
    session.noteBoardReveal(identity, {
      responseId: 'response-1',
      visualCueId: 'cue-1',
      semanticObjectId: 'anchor-1',
    });
    session.noteBoardReveal({ ...identity, generationId: 'generation-stale' }, {
      responseId: 'response-1',
      visualCueId: 'cue-stale',
    });
    session.noteBoardReveal(identity, { visualCueId: 'cue-missing-response' });

    const revealMetrics = sent.filter((event) =>
      event.type === 'metric' &&
      (event.payload as { name?: unknown }).name === 'board_reveal_to_narration');
    expect(revealMetrics).toHaveLength(1);
    expect(revealMetrics[0]).toMatchObject({
      ...identity,
      providerResponseId: 'response-1',
      payload: {
        schemaVersion: '1.0.0',
        name: 'board_reveal_to_narration',
        unit: 'ms',
        value: -770,
        visualCueId: 'cue-1',
        semanticObjectId: 'anchor-1',
      },
    });
    expect(revealMetrics[0]?.payload).not.toHaveProperty('providerResponseId');
  });

  it('moves from speech end to thinking and measures the actual reply gap', () => {
    const now = vi.spyOn(performance, 'now');
    const { session, harness, voice } = sessionWithVoice();
    const identity = session.getIdentity();

    now.mockReturnValue(1_000);
    harness.handleServer(createRuntimeEvent(identity, 0, 'speech_stopped', {}));
    expect(session.getSnapshot().phase).toBe('thinking');

    now.mockReturnValue(1_180);
    harness.handleServer(createRuntimeEvent(identity, 1, 'response_started', { response_id: 'reply' }));
    expect(session.getSnapshot().metrics.speechEndToResponseStartedMs).toBe(180);

    now.mockReturnValue(1_450);
    voice.emitBoundary('started', 'reply');
    expect(session.getSnapshot().metrics.speechEndToFirstAudioMs).toBe(450);
    expect(session.getSnapshot().phase).toBe('speaking');
    now.mockRestore();
  });

  it('keeps a drawing draft open across pauses and submits exactly once on Done', () => {
    vi.useFakeTimers();
    try {
      const session = new RealtimeSession('session');
      const harness = session as unknown as SessionHarness;
      const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
      harness.ws = {
        readyState: 1,
        send: (raw) => sent.push(JSON.parse(raw) as { type: string; payload: Record<string, unknown> }),
      };
      harness.handleServer(createRuntimeEvent(session.getIdentity(), 0, 'ready', {}));

      // Opening the draft acquires the learner floor but submits nothing.
      session.beginLearnerActivity();
      session.notifyDraftState(true, 'draft-1');
      expect(sent.filter((event) => event.type === 'draft_state')).toHaveLength(1);

      // An arbitrary pause between strokes never creates a submission, a
      // capture, or a thinking state.
      vi.advanceTimersByTime(30_000);
      expect(sent.some((event) => event.type === 'board_submission')).toBe(false);
      expect(session.getSnapshot().phase).not.toBe('thinking');

      // Speech during an open draft accumulates as context: no thinking yet.
      harness.handleServer(createRuntimeEvent(session.getIdentity(), 1, 'speech_started', {}));
      harness.handleServer(createRuntimeEvent(session.getIdentity(), 2, 'speech_stopped', {}));
      expect(session.getSnapshot().phase).not.toBe('thinking');

      // Done sends exactly one idempotent submission and moves to thinking.
      session.submitBoardSubmission({
        submissionId: 'submission-abc-123', draftId: 'draft-1',
        description: 'one circle around the acute angle', ops: [],
      });
      const submissions = sent.filter((event) => event.type === 'board_submission');
      expect(submissions).toHaveLength(1);
      expect(submissions[0]?.payload.submissionId).toBe('submission-abc-123');
      expect(session.getSnapshot().phase).toBe('thinking');
      expect(session.getSnapshot().submission).toMatchObject({ submissionId: 'submission-abc-123', status: 'sending' });

      harness.handleServer(createRuntimeEvent(session.getIdentity(), 3, 'board_submission_ack', { submissionId: 'submission-abc-123' }));
      expect(session.getSnapshot().submission).toMatchObject({ status: 'accepted' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a retryable failure when the submission is never acknowledged', () => {
    vi.useFakeTimers();
    try {
      const session = new RealtimeSession('session');
      const harness = session as unknown as SessionHarness;
      const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
      harness.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw) as { type: string; payload: Record<string, unknown> }) };
      harness.handleServer(createRuntimeEvent(session.getIdentity(), 0, 'ready', {}));
      const results: Array<{ id: string; accepted: boolean }> = [];
      session.onSubmissionResult = (id, accepted) => results.push({ id, accepted });
      session.submitBoardSubmission({ submissionId: 'submission-timeout-1', draftId: 'draft-2', description: 'a stroke', ops: [] });
      vi.advanceTimersByTime(9_000);
      expect(session.getSnapshot().submission).toMatchObject({ status: 'failed' });
      expect(results).toEqual([{ id: 'submission-timeout-1', accepted: false }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the delivered task only after its response playback stops', () => {
    const { session, harness, voice } = sessionWithVoice();
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'response_started', { response_id: 'task-response' }));
    voice.emitBoundary('started', 'task-response');
    const task = {
      taskId: 'circle-acute', prompt: 'Circle the acute angle.', responseMode: 'draw', submitPolicy: 'explicit',
      targetObjectIds: [], boardRevision: 0, allowVoiceWhileDrawing: true,
    };
    harness.handleServer(createRuntimeEvent(identity, 1, 'learner_task', { task, response_id: 'task-response' }, { providerResponseId: 'task-response' }));
    harness.releasePending();
    expect(session.getSnapshot().task).toBeNull();
    voice.emitBoundary('stopped', 'task-response', 5_000);
    expect(session.getSnapshot().task).toMatchObject({ taskId: 'circle-acute', responseMode: 'draw', submitPolicy: 'explicit' });
  });

  it('does not deliver a task during the generation-to-audio gap', () => {
    const { session, harness, voice } = sessionWithVoice();
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'response_started', { response_id: 'pending-task-response' }));
    const task = {
      taskId: 'pending-task', prompt: 'Point to the larger mark.', responseMode: 'voice', submitPolicy: 'vad',
      targetObjectIds: [], boardRevision: 0, allowVoiceWhileDrawing: true,
    };
    harness.handleServer(createRuntimeEvent(identity, 1, 'learner_task', {
      task, response_id: 'pending-task-response',
    }));
    harness.releasePending();
    expect(session.getSnapshot().task).toBeNull();
    voice.emitBoundary('started', 'pending-task-response');
    expect(session.getSnapshot().task).toBeNull();
    voice.emitBoundary('stopped', 'pending-task-response', 900);
    expect(session.getSnapshot().task).toMatchObject({ taskId: 'pending-task' });
  });

  it('replays persisted learner board operations through the learner-owned path', () => {
    const session = new RealtimeSession('session');
    const harness = session as unknown as SessionHarness;
    const replay = vi.fn();
    session.onLearnerBoardReplay = replay;
    const identity = session.getIdentity();
    const ops = [{ op: 'add', id: 'sketch-test', spec: { kind: 'path', points: [[1, 1], [2, 2]] } }];
    harness.handleServer(createRuntimeEvent(identity, 0, 'learner_board_replay', { batches: [{ ops, semanticObjectId: 'fraction-scale' }] }));
    expect(replay).toHaveBeenCalledWith(ops, 'fraction-scale');
  });

  it('restores tutor board section metadata during replay', () => {
    const session = new RealtimeSession('session');
    const harness = session as unknown as SessionHarness;
    const board = vi.fn(async () => true);
    session.onBoardOps = board;
    const identity = session.getIdentity();
    const ops = [{ op: 'add', id: 'proof-line', spec: { kind: 'line', from: [1, 1], to: [2, 2] } }];
    harness.handleServer(createRuntimeEvent(identity, 0, 'board_replay', { batches: [{ ops, semanticObjectId: 'proof', groupLabel: 'Proof' }] }));
    expect(board).toHaveBeenCalledWith(ops, false, expect.anything(), { semanticObjectId: 'proof', groupLabel: 'Proof' });
  });

  it('reports a deterministic board-quality rejection back to the agent', async () => {
    const session = new RealtimeSession('session');
    const harness = session as unknown as SessionHarness;
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw) as { type: string; payload: Record<string, unknown> }) };
    session.onBoardOps = async () => false;
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'board_ops', {
      response_id: 'quality-response', event_id: 77,
      ops: [{ op: 'add', id: 'too-dense', spec: { kind: 'text', at: [100, 100], text: 'too dense' } }],
    }, { providerResponseId: 'quality-response', semanticObjectId: 'quality-group' }));
    harness.releasePending();
    await vi.waitFor(() => expect(sent.some((event) => event.type === 'ops_rejected')).toBe(true));
    expect(sent.find((event) => event.type === 'ops_rejected')?.payload).toMatchObject({ event_id: 77, response_id: 'quality-response' });
  });

  it('reports a thrown board renderer failure instead of leaving the tool pending', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const session = new RealtimeSession('session');
    const harness = session as unknown as SessionHarness;
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw) as { type: string; payload: Record<string, unknown> }) };
    session.onBoardOps = async () => { throw new Error('renderer crashed'); };
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'board_ops', {
      response_id: 'render-crash-response', event_id: 78,
      ops: [{ op: 'add', id: 'line', spec: { kind: 'line', from: [1, 1], to: [2, 2] } }],
    }, { providerResponseId: 'render-crash-response' }));
    harness.releasePending();
    await vi.waitFor(() => expect(sent.some((event) => event.type === 'ops_rejected')).toBe(true));
    expect(sent.find((event) => event.type === 'ops_rejected')?.payload).toMatchObject({
      event_id: 78,
      reason: expect.stringContaining('renderer failed'),
    });
    expect(session.getSnapshot().error).toMatch(/could not show/i);
    expect(consoleError).toHaveBeenCalled();
  });

  it('keeps voice playback alive across a sideband envelope reconnect', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeEnvelopeSocket);
    FakeEnvelopeSocket.instances = [];
    try {
      window.sessionStorage.setItem('noura.lessonCapability.session', 'capability');
      let voice!: FakeVoiceTransport;
      const session = new RealtimeSession('session', (input) => {
        voice = new FakeVoiceTransport(input.handlers);
        return voice;
      });
      const harness = session as unknown as SessionHarness;
      await session.start();
      const first = FakeEnvelopeSocket.instances.at(-1);
      expect(first).toBeDefined();
      first!.readyState = 1;
      first!.onopen?.();
      harness.handleServer(createRuntimeEvent(session.getIdentity(), 0, 'ready', {}));
      voice.emitBoundary('started', 'mid-lesson-response');
      expect(session.getSnapshot().phase).toBe('speaking');

      // Vercel recycles the envelope connection mid-response: the WebRTC
      // audio plane must keep playing while the control plane reconnects.
      first!.onclose?.();
      expect(session.getSnapshot().phase).toBe('reconnecting');
      expect(voice.playbackClears).toBe(0);
      expect(voice.playingResponseId()).toBe('mid-lesson-response');
      expect(voice.state).toBe('connected');

      vi.advanceTimersByTime(600);
      expect(FakeEnvelopeSocket.instances).toHaveLength(2);
      session.end();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('rejects late cues after interruption, reconnect identity replacement, and navigation cleanup', () => {
    const { session, harness, voice } = sessionWithVoice();
    const oldIdentity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(oldIdentity, 0, 'response_started', { response_id: 'old' }));
    voice.emitBoundary('started', 'old');
    harness.handleServer(createRuntimeEvent(oldIdentity, 1, 'speech_started', {}));
    for (let frame = 0; frame < 7; frame += 1) harness.handleMicEnergy(0.09);
    expect(session.getIdentity()).not.toEqual(oldIdentity);
    const stale = createRuntimeEvent(oldIdentity, 2, 'transcript_delta', { response_id: 'old', delta: 'stale future. ' }, { providerResponseId: 'old' });
    harness.handleServer(stale as RuntimeEventEnvelope<Record<string, unknown>>);
    harness.releasePending();
    expect(session.getSnapshot().captions).toEqual([]);
    session.end();
    harness.handleServer(stale);
    expect(session.getSnapshot().phase).toBe('ended');
    expect(session.getSnapshot().captions).toEqual([]);
  });

  it('turns a grounding fallback into one normalized image tap event', () => {
    const { session, harness } = sessionWithVoice();
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.ws = { readyState: WebSocket.OPEN, send: (raw) => sent.push(JSON.parse(raw) as { type: string; payload: Record<string, unknown> }) };
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'image_region_tap_request', {
      request_id: 'ground-1', image_id: 'worksheet-image', hint: 'Tap the axle',
    }));
    expect(session.getSnapshot().imageGrounding).toEqual({
      requestId: 'ground-1', imageId: 'worksheet-image', hint: 'Tap the axle',
    });
    expect(session.submitImageRegionTap({ type: 'PointSelector', x: 0.4, y: 0.6 })).toBe(true);
    expect(sent.at(-1)).toMatchObject({
      type: 'image_region_tap',
      payload: {
        request_id: 'ground-1', image_id: 'worksheet-image',
        selector: { type: 'PointSelector', x: 0.4, y: 0.6 },
      },
    });
    expect(session.getSnapshot().imageGrounding).toBeNull();
    expect(session.submitImageRegionTap({ type: 'PointSelector', x: 0.5, y: 0.5 })).toBe(false);
  });
});
