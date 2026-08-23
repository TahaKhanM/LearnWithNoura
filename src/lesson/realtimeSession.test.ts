import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeEvent, type GenerationIdentity, type RuntimeEventEnvelope } from '../../shared/runtimeProtocol';
import { ResponseSegmentAnnotator } from '../../server/realtime/segmentAnnotator';
import { RealtimeSession } from './realtimeSession';

interface SessionHarness {
  audioOut: {
    speaking: boolean;
    append(): void;
    currentEnergy(): number;
    playedSamples(): number;
    stop(): never[];
    close(): Promise<void>;
  };
  handleServer(raw: unknown): void;
  handleMicEnergy(rms: number): void;
  releasePending(): void;
  ws?: { readyState: number; send(raw: string): void };
}

beforeEach(() => window.sessionStorage.clear());

function envelope(identity: GenerationIdentity, sequence: number, cue: { payload: Record<string, unknown>; optional: Record<string, unknown> }) {
  const { type, ...payload } = cue.payload;
  return createRuntimeEvent(identity, sequence, String(type), payload, cue.optional);
}

describe('RealtimeSession sealed response release', () => {
  it('does not release future caption, board, pen/character state, or final text before heard PCM', async () => {
    const session = new RealtimeSession('session');
    const harness = session as unknown as SessionHarness;
    let played = 480;
    harness.audioOut = {
      speaking: true, append: () => {}, currentEnergy: () => 0, playedSamples: () => played,
      stop: () => [], close: async () => {},
    };
    const board = vi.fn(async () => true);
    session.onBoardOps = board;
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'response_started', { response_id: 'response' }));

    const annotator = new ResponseSegmentAnnotator();
    annotator.addTranscriptDelta('First phrase. ');
    annotator.addTranscriptDelta('Future phrase?');
    annotator.addSemanticCue({ type: 'board_ops', response_id: 'response', event_id: 12, ops: [] }, { visualCueId: 'cue', semanticObjectId: 'fraction-scale' });
    annotator.addSemanticCue({ type: 'lesson_state', response_id: 'response', state: { activeConcept: 'future concept', characterAttentionTarget: 'semantic_object' } }, { semanticObjectId: 'fraction-scale' });
    annotator.addAudioSamples(480);
    annotator.addAudioSamples(23_520);
    annotator.setFinalTranscript('First phrase. Future phrase?');
    const cues = annotator.seal();
    cues.forEach((cue, index) => harness.handleServer(envelope(identity, index + 1, cue as { payload: Record<string, unknown>; optional: Record<string, unknown> })));

    harness.releasePending();
    expect(session.getSnapshot().captions).toEqual([]);
    expect(session.getSnapshot().lessonState).toEqual({});
    expect(board).not.toHaveBeenCalled();

    played = 24_000;
    harness.releasePending();
    await vi.waitFor(() => expect(board).toHaveBeenCalledTimes(1));
    expect(session.getSnapshot().captions.map((caption) => caption.text)).toEqual(['First phrase.', 'Future phrase?']);
    expect(session.getSnapshot().lessonState).toMatchObject({ activeConcept: 'future concept', characterAttentionTarget: 'semantic_object' });
  });

  it('does not interrupt on server VAD or a short local noise burst alone', () => {
    const session = new RealtimeSession('session');
    const harness = session as unknown as SessionHarness;
    harness.audioOut = {
      speaking: true, append: () => {}, currentEnergy: () => 0, playedSamples: () => 0,
      stop: () => [], close: async () => {},
    };
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'response_started', { response_id: 'response' }));
    harness.handleServer(createRuntimeEvent(identity, 1, 'speech_started', {}));
    for (let frame = 0; frame < 3; frame += 1) harness.handleMicEnergy(0.12);
    expect(session.getIdentity()).toEqual(identity);
  });

  it('moves from speech end to thinking and measures the actual reply gap', () => {
    const now = vi.spyOn(performance, 'now');
    const session = new RealtimeSession('session');
    const harness = session as unknown as SessionHarness;
    harness.audioOut = {
      speaking: false, append: () => {}, currentEnergy: () => 0, playedSamples: () => 0,
      stop: () => [], close: async () => {},
    };
    const identity = session.getIdentity();

    now.mockReturnValue(1_000);
    harness.handleServer(createRuntimeEvent(identity, 0, 'speech_stopped', {}));
    expect(session.getSnapshot().phase).toBe('thinking');

    now.mockReturnValue(1_180);
    harness.handleServer(createRuntimeEvent(identity, 1, 'response_started', { response_id: 'reply' }));
    expect(session.getSnapshot().metrics.speechEndToResponseStartedMs).toBe(180);

    now.mockReturnValue(1_450);
    harness.handleServer(createRuntimeEvent(identity, 2, 'audio', {
      response_id: 'reply', item_id: 'item-reply', delta: btoa('\0\0'),
    }));
    expect(session.getSnapshot().metrics.speechEndToFirstAudioMs).toBe(450);
    expect(session.getSnapshot().phase).toBe('speaking');
    now.mockRestore();
  });

  it('requests one response for a board-only turn but lets speech VAD own mixed speech and drawing', () => {
    const session = new RealtimeSession('session');
    const harness = session as unknown as SessionHarness;
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.ws = {
      readyState: 1,
      send: (raw) => sent.push(JSON.parse(raw) as { type: string; payload: Record<string, unknown> }),
    };
    harness.handleServer(createRuntimeEvent(session.getIdentity(), 0, 'ready', {}));
    const beforeBoard = session.getIdentity();
    session.beginLearnerActivity();
    const boardTurn = session.getIdentity();
    expect(boardTurn).not.toEqual(beforeBoard);
    session.beginLearnerActivity();
    expect(session.getIdentity()).toEqual(boardTurn);
    session.sendBoardEvent({ description: 'one stroke', ops: [] });
    expect(sent.at(-1)?.payload.requestResponse).toBe(true);

    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'speech_started', {}));
    session.beginLearnerActivity();
    session.sendBoardEvent({ description: 'stroke plus speech', ops: [] });
    expect(sent.at(-1)?.payload.requestResponse).toBe(false);
  });

  it('replays persisted learner board operations through the learner-owned path', () => {
    const session = new RealtimeSession('session');
    const harness = session as unknown as SessionHarness;
    const replay = vi.fn();
    session.onLearnerBoardReplay = replay;
    const identity = session.getIdentity();
    const ops = [{ op: 'add', id: 'sketch-test', spec: { kind: 'path', points: [[1, 1], [2, 2]] } }];
    harness.handleServer(createRuntimeEvent(identity, 0, 'learner_board_replay', { batches: [ops] }));
    expect(replay).toHaveBeenCalledWith(ops);
  });

  it('rejects late sealed cues after interruption, reconnect identity replacement, and navigation cleanup', () => {
    const session = new RealtimeSession('session');
    const harness = session as unknown as SessionHarness;
    harness.audioOut = {
      speaking: true, append: () => {}, currentEnergy: () => 0, playedSamples: () => 24_000,
      stop: () => [], close: async () => {},
    };
    const oldIdentity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(oldIdentity, 0, 'response_started', { response_id: 'old' }));
    harness.handleServer(createRuntimeEvent(oldIdentity, 1, 'speech_started', {}));
    for (let frame = 0; frame < 7; frame += 1) harness.handleMicEnergy(0.09);
    expect(session.getIdentity()).not.toEqual(oldIdentity);
    const stale = createRuntimeEvent(oldIdentity, 2, 'transcript_delta', { response_id: 'old', delta: 'stale future' }, { audioSampleOffsets: { start: 0, end: 24_000 } });
    harness.handleServer(stale as RuntimeEventEnvelope<Record<string, unknown>>);
    harness.releasePending();
    expect(session.getSnapshot().captions).toEqual([]);
    session.end();
    harness.handleServer(stale);
    expect(session.getSnapshot().phase).toBe('ended');
    expect(session.getSnapshot().captions).toEqual([]);
  });
});
