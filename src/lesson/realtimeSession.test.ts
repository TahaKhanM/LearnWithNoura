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

  it('shows the delivered task only after its audio boundary is heard', async () => {
    const session = new RealtimeSession('session');
    const harness = session as unknown as SessionHarness;
    let played = 0;
    harness.audioOut = {
      speaking: true, append: () => {}, currentEnergy: () => 0, playedSamples: () => played,
      stop: () => [], close: async () => {},
    };
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'response_started', { response_id: 'task-response' }));
    const task = {
      taskId: 'circle-acute', prompt: 'Circle the acute angle.', responseMode: 'draw', submitPolicy: 'explicit',
      targetObjectIds: [], boardRevision: 0, allowVoiceWhileDrawing: true,
    };
    harness.handleServer(createRuntimeEvent(identity, 1, 'learner_task', { task, response_id: 'task-response' }, { audioSampleOffsets: { start: 24_000, end: 24_000 } }));
    harness.releasePending();
    expect(session.getSnapshot().task).toBeNull();
    played = 24_000;
    harness.releasePending();
    expect(session.getSnapshot().task).toMatchObject({ taskId: 'circle-acute', responseMode: 'draw', submitPolicy: 'explicit' });
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
    harness.audioOut = {
      speaking: false, append: () => {}, currentEnergy: () => 0, playedSamples: () => 0,
      stop: () => [], close: async () => {},
    };
    session.onBoardOps = async () => false;
    const identity = session.getIdentity();
    harness.handleServer(createRuntimeEvent(identity, 0, 'board_ops', {
      response_id: 'quality-response', event_id: 77,
      ops: [{ op: 'add', id: 'too-dense', spec: { kind: 'text', at: [100, 100], text: 'too dense' } }],
    }, { audioSampleOffsets: { start: 0, end: 0 }, semanticObjectId: 'quality-group' }));
    harness.releasePending();
    await vi.waitFor(() => expect(sent.some((event) => event.type === 'ops_rejected')).toBe(true));
    expect(sent.find((event) => event.type === 'ops_rejected')?.payload).toMatchObject({ event_id: 77, response_id: 'quality-response' });
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
