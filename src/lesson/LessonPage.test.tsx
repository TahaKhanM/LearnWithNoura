import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardOp } from '../../shared/boardOps';
import type { GenerationIdentity, RuntimeEventEnvelope } from '../../shared/runtimeProtocol';
import { RouterContext } from '../routerContext';

const lessonHarness = vi.hoisted(() => ({
  sessions: [] as unknown[],
  animationResolvers: [] as Array<(completed: boolean) => void>,
}));

vi.mock('../board/BoardCanvas', () => ({
  BoardCanvas: ({ animatorRef }: {
    animatorRef?: (animator: {
      beginTransaction(): void;
      finishAll(): void;
      whenIdle(): Promise<boolean>;
    }) => void;
  }) => {
    animatorRef?.({
      beginTransaction: () => {},
      finishAll: () => {},
      whenIdle: () => new Promise((resolve) => lessonHarness.animationResolvers.push(resolve)),
    });
    return <div data-testid="board-canvas" />;
  },
}));

vi.mock('./Avatar', () => ({
  Avatar: () => <div data-testid="avatar" />,
}));

vi.mock('../board/snapshot', () => ({
  renderSceneImage: async () => 'data:image/jpeg;base64,dGVzdA==',
}));

vi.mock('./realtimeSession', () => {
  const identity: GenerationIdentity = {
    sessionId: 'session-1',
    connectionEpoch: 0,
    turnId: 'turn-0',
    generationId: 'generation-0',
  };

  class RealtimeSession {
    onBoardOps: (
      ops: BoardOp[],
      animate: boolean,
      generation: GenerationIdentity,
      cue?: {
        responseId?: string;
        visualCueId?: string;
        semanticObjectId?: string;
        groupLabel?: string;
        replacesGroup?: string;
      },
    ) => Promise<boolean | void> | boolean | void = () => {};
    onLearnerBoardReplay: (ops: BoardOp[], semanticGroupId?: string) => void = () => {};
    onGenerationCancelled: (generation: GenerationIdentity) => void = () => {};
    onGenerationActivated: (generation: GenerationIdentity, reason: 'interruption' | 'ordinary') => void = () => {};
    onCaptionQuestion: (generation: GenerationIdentity) => void = () => {};
    onSubmissionResult: (submissionId: string, accepted: boolean, error?: string) => void = () => {};
    onVisualPreflight: () => { accepted: boolean; reasons: string[]; layoutIssues: [] } = () => ({ accepted: true, reasons: [], layoutIssues: [] });
    onVisualRender: () => Promise<string | null> | string | null = () => null;
    onEnded: () => void = () => {};
    recordSectionNavigation = vi.fn();
    recordTutorObjectDisappearance = vi.fn();
    noteBoardReveal = vi.fn();
    notifyDraftState = vi.fn();
    submitBoardSubmission = vi.fn();
    beginLearnerActivity = vi.fn();
    sendText = vi.fn();
    setMuted = vi.fn();
    resumeAudio = vi.fn(async () => {});
    end = vi.fn();
    start = vi.fn(async () => {});
    getIdentity = () => identity;
    private readonly listeners = new Set<() => void>();
    private readonly snapshot = {
      phase: 'listening' as const,
      identity,
      micAvailable: false,
      micDenied: false,
      audioBlocked: false,
      muted: false,
      captions: [],
      lessonState: {},
      evidenceCount: 0,
      lastEvidence: null,
      micEnergy: 0,
      voiceEnergy: 0,
      error: null,
      metrics: {},
      task: null as null | {
        taskId: string;
        prompt: string;
        responseMode: 'draw';
        submitPolicy: 'explicit';
        semanticGroupId: string;
      },
      submission: null,
      illustration: null,
    };
    getSnapshot = () => this.snapshot;
    subscribe = (listener: () => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    };
    setTask(task: NonNullable<typeof this.snapshot.task> | null) {
      this.snapshot.task = task;
      this.listeners.forEach((listener) => listener());
    }

    constructor() {
      lessonHarness.sessions.push(this);
    }
  }

  return { RealtimeSession };
});

import { LessonPage } from './LessonPage';

interface SessionDouble {
  onBoardOps(
    ops: BoardOp[],
    animate: boolean,
    identity: GenerationIdentity,
    cue?: {
      responseId?: string;
      visualCueId?: string;
      semanticObjectId?: string;
      groupLabel?: string;
      replacesGroup?: string;
    },
  ): Promise<boolean | void> | boolean | void;
  onLearnerBoardReplay(ops: BoardOp[], semanticGroupId?: string): void;
  getIdentity(): GenerationIdentity;
  onSubmissionResult: (submissionId: string, accepted: boolean, error?: string) => void;
  setTask(task: {
    taskId: string;
    prompt: string;
    responseMode: 'draw';
    submitPolicy: 'explicit';
    semanticGroupId: string;
  } | null): void;
  recordSectionNavigation: ReturnType<typeof vi.fn>;
  recordTutorObjectDisappearance: ReturnType<typeof vi.fn>;
  noteBoardReveal: ReturnType<typeof vi.fn>;
}

const circle = (id: string, x: number): BoardOp => ({
  op: 'add',
  id,
  spec: { kind: 'circle', center: [x, 180], r: 28 },
});

beforeEach(() => {
  lessonHarness.sessions.length = 0;
  lessonHarness.animationResolvers.length = 0;
  window.sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({
      child: { id: 'child-1', name: 'Mina' },
      session: { goal: 'Fractions', status: 'active' },
    }),
  })));
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderStartedLesson(): Promise<{
  session: SessionDouble;
  unmount: () => void;
}> {
  const rendered = render(
    <RouterContext.Provider value={{ path: '/lesson/session-1', navigate: vi.fn() }}>
      <LessonPage sessionId="session-1" />
    </RouterContext.Provider>,
  );
  await waitFor(() => expect((screen.getByTestId('start-lesson') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId('start-lesson'));
  await act(async () => {});
  return {
    session: lessonHarness.sessions[0] as SessionDouble,
    unmount: rendered.unmount,
  };
}

async function replayTutor(
  session: SessionDouble,
  ops: BoardOp[],
  semanticObjectId: string,
  groupLabel: string,
): Promise<void> {
  await act(async () => {
    await session.onBoardOps(
      ops,
      false,
      session.getIdentity(),
      { semanticObjectId, groupLabel },
    );
  });
}

describe('LessonPage board observations', () => {
  it('records only actual initial, notice, and picker navigation', async () => {
    const { session } = await renderStartedLesson();

    await replayTutor(session, [circle('object-a', 180)], 'group-a', 'First');
    expect(session.recordSectionNavigation).toHaveBeenCalledTimes(1);
    expect(session.recordSectionNavigation).toHaveBeenLastCalledWith({
      previousGroupId: null,
      nextGroupId: 'group-a',
      cause: 'initial_anchor',
    });

    await replayTutor(session, [circle('object-b', 420)], 'group-b', 'Second');
    expect(session.recordSectionNavigation).toHaveBeenCalledTimes(1);
    expect((await screen.findByTestId('section-notice')).textContent).toContain('Second');

    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    expect(session.recordSectionNavigation).toHaveBeenLastCalledWith({
      previousGroupId: 'group-a',
      nextGroupId: 'group-b',
      cause: 'notice_open',
    });

    fireEvent.change(screen.getByLabelText('Board section'), {
      target: { value: 'group-a' },
    });
    expect(session.recordSectionNavigation).toHaveBeenLastCalledWith({
      previousGroupId: 'group-b',
      nextGroupId: 'group-a',
      cause: 'picker',
    });
    expect(session.recordSectionNavigation).toHaveBeenCalledTimes(3);
  });

  it('queues task_focus during an open draft and pans after Done', async () => {
    window.sessionStorage.setItem('noura.draft.session-1', JSON.stringify({
      draftId: 'draft-open',
      semanticGroupId: 'group-a',
      entries: [{
        op: {
          op: 'add',
          id: 'learner-mark',
          spec: { kind: 'path', points: [[10, 10], [20, 20]] },
        },
        inverse: { op: 'erase', id: 'learner-mark' },
        note: 'a stroke',
      }],
    }));
    const { session } = await renderStartedLesson();
    await replayTutor(session, [circle('object-a', 180)], 'group-a', 'First');
    await replayTutor(session, [circle('object-b', 420)], 'group-b', 'Second');

    expect((screen.getByLabelText('Board section') as HTMLSelectElement).value).toBe('group-a');
    expect((screen.getByLabelText('Board section') as HTMLSelectElement).disabled).toBe(true);

    act(() => {
      session.setTask({
        taskId: 'task-region-2',
        prompt: 'Draw on the second idea',
        responseMode: 'draw',
        submitPolicy: 'explicit',
        semanticGroupId: 'group-b',
      });
    });
    expect((screen.getByLabelText('Board section') as HTMLSelectElement).value).toBe('group-a');
    expect(session.recordSectionNavigation).not.toHaveBeenCalledWith(
      expect.objectContaining({ nextGroupId: 'group-b', cause: 'task_focus' }),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('draft-done'));
    });
    await act(async () => {
      session.onSubmissionResult('submission-1', true);
    });

    expect((screen.getByLabelText('Board section') as HTMLSelectElement).value).toBe('group-b');
    expect(session.recordSectionNavigation).toHaveBeenCalledWith({
      previousGroupId: 'group-a',
      nextGroupId: 'group-b',
      cause: 'task_focus',
    });
  });

  it('queues a second draft navigation instead of silently overwriting the first', async () => {
    window.sessionStorage.setItem('noura.draft.session-1', JSON.stringify({
      draftId: 'draft-open',
      semanticGroupId: 'group-a',
      entries: [{
        op: {
          op: 'add',
          id: 'learner-mark',
          spec: { kind: 'path', points: [[10, 10], [20, 20]] },
        },
        inverse: { op: 'erase', id: 'learner-mark' },
        note: 'a stroke',
      }],
    }));
    const { session } = await renderStartedLesson();
    await replayTutor(session, [circle('object-a', 180)], 'group-a', 'First');
    await replayTutor(session, [circle('object-b', 420)], 'group-b', 'Second');
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    await replayTutor(session, [circle('object-c', 260)], 'group-c', 'Third');
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    expect((screen.getByLabelText('Board section') as HTMLSelectElement).value).toBe('group-a');
    expect(session.recordSectionNavigation).not.toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'notice_open' }),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('draft-done'));
    });
    await act(async () => {
      session.onSubmissionResult('submission-1', true);
    });

    expect((screen.getByLabelText('Board section') as HTMLSelectElement).value).toBe('group-c');
    expect(session.recordSectionNavigation).toHaveBeenCalledWith({
      previousGroupId: 'group-a',
      nextGroupId: 'group-b',
      cause: 'notice_open',
    });
    expect(session.recordSectionNavigation).toHaveBeenCalledWith({
      previousGroupId: 'group-b',
      nextGroupId: 'group-c',
      cause: 'notice_open',
    });
  });

  it('records draft restoration as navigation after Begin', async () => {
    window.sessionStorage.setItem('noura.draft.session-1', JSON.stringify({
      draftId: 'draft-restored',
      semanticGroupId: 'group-restored',
      entries: [{
        op: {
          op: 'add',
          id: 'learner-restored',
          spec: { kind: 'path', points: [[10, 10], [20, 20]] },
        },
        inverse: { op: 'erase', id: 'learner-restored' },
        note: 'restored mark',
      }],
    }));

    const { session } = await renderStartedLesson();

    expect(session.recordSectionNavigation).toHaveBeenCalledOnce();
    expect(session.recordSectionNavigation).toHaveBeenCalledWith({
      previousGroupId: null,
      nextGroupId: 'group-restored',
      cause: 'draft_restore',
    });
  });

  it('preserves an existing section notice when first-anchor registration opens that section', async () => {
    window.sessionStorage.setItem('noura.draft.session-1', JSON.stringify({
      draftId: 'draft-restored',
      entries: [{
        op: {
          op: 'add',
          id: 'learner-restored',
          spec: { kind: 'path', points: [[10, 10], [20, 20]] },
        },
        inverse: { op: 'erase', id: 'learner-restored' },
        note: 'restored mark',
      }],
    }));
    const { session } = await renderStartedLesson();

    await replayTutor(session, [circle('object-a', 180)], 'group-a', 'First');
    expect((await screen.findByTestId('section-notice')).textContent).toContain('First');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel your drawing' }));

    await replayTutor(session, [circle('object-a-2', 280)], 'group-a', 'First');

    expect(session.recordSectionNavigation).toHaveBeenCalledWith({
      previousGroupId: null,
      nextGroupId: 'group-a',
      cause: 'initial_anchor',
    });
    expect(screen.getByTestId('section-notice').textContent).toContain('First');
  });

  it('suppresses section-filter changes but reports a true tutor scene removal', async () => {
    const { session } = await renderStartedLesson();
    await replayTutor(session, [circle('object-a', 180)], 'group-a', 'First');
    await replayTutor(session, [circle('object-b', 420)], 'group-b', 'Second');

    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    await act(async () => {});
    expect(session.recordTutorObjectDisappearance).not.toHaveBeenCalled();

    await replayTutor(session, [{ op: 'erase', id: 'object-b' }], 'group-b', 'Second');
    await act(async () => {});
    expect(session.recordTutorObjectDisappearance).toHaveBeenCalledOnce();
    expect(session.recordTutorObjectDisappearance).toHaveBeenCalledWith({
      objectId: 'object-b',
      cause: 'scene_mutation',
    });
  });

  it('ignores learner-owned removal and teardown', async () => {
    const { session, unmount } = await renderStartedLesson();
    await replayTutor(session, [circle('object-a', 180)], 'group-a', 'First');

    act(() => session.onLearnerBoardReplay([{
      op: 'add',
      id: 'learner-a',
      spec: { kind: 'path', points: [[20, 20], [40, 40]] },
    }], 'group-a'));
    act(() => session.onLearnerBoardReplay([{ op: 'erase', id: 'learner-a' }], 'group-a'));
    await act(async () => {});
    expect(session.recordTutorObjectDisappearance).not.toHaveBeenCalled();

    unmount();
    await Promise.resolve();
    expect(session.recordTutorObjectDisappearance).not.toHaveBeenCalled();
  });

  it('observes each committed tutor scene directly, including a remove followed by a later re-add', async () => {
    const { session } = await renderStartedLesson();
    await replayTutor(session, [circle('object-a', 180)], 'group-a', 'First');

    act(() => {
      void session.onBoardOps(
        [{ op: 'erase', id: 'object-a' }],
        false,
        session.getIdentity(),
        { semanticObjectId: 'group-a', groupLabel: 'First' },
      );
    });

    expect(session.recordTutorObjectDisappearance).toHaveBeenCalledOnce();
    expect(session.recordTutorObjectDisappearance).toHaveBeenCalledWith({
      objectId: 'object-a',
      cause: 'scene_mutation',
    });

    act(() => {
      void session.onBoardOps(
        [circle('object-a', 180)],
        false,
        session.getIdentity(),
        { semanticObjectId: 'group-a', groupLabel: 'First' },
      );
    });

    expect(session.recordTutorObjectDisappearance).toHaveBeenCalledOnce();
  });

  it('suppresses only tutor IDs retired by an atomic replacement in the same committed scene', async () => {
    const { session } = await renderStartedLesson();
    await replayTutor(
      session,
      [circle('retired-a', 180), circle('retired-b', 280)],
      'group-a',
      'First',
    );
    await act(async () => {
      await session.onBoardOps(
        [circle('unrelated-global', 420)],
        false,
        session.getIdentity(),
      );
    });

    await act(async () => {
      await session.onBoardOps(
        [
          { op: 'erase', id: 'unrelated-global' },
          circle('replacement', 240),
        ],
        false,
        session.getIdentity(),
        {
          semanticObjectId: 'group-a',
          groupLabel: 'First',
          replacesGroup: 'group-a',
        },
      );
    });

    expect(session.recordTutorObjectDisappearance).toHaveBeenCalledOnce();
    expect(session.recordTutorObjectDisappearance).toHaveBeenCalledWith({
      objectId: 'unrelated-global',
      cause: 'scene_mutation',
    });
  });

  it('records tutor reveal only after the committed paint and before completion', async () => {
    const { session } = await renderStartedLesson();
    await replayTutor(session, [circle('object-a', 180)], 'group-a', 'First');
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));

    let completed = false;
    let completion: Promise<boolean | void> | undefined;
    await act(async () => {
      completion = Promise.resolve(session.onBoardOps(
        [circle('object-painted', 200)],
        true,
        session.getIdentity(),
        {
          responseId: 'response-1',
          visualCueId: 'cue-1',
          semanticObjectId: 'group-a',
          groupLabel: 'First',
        },
      ));
      void completion.then(() => {
        completed = true;
      });
      await Promise.resolve();
    });
    expect(session.noteBoardReveal).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);

    act(() => frames.shift()?.(0));
    expect(session.noteBoardReveal).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);

    await act(async () => {
      frames.shift()?.(16);
      await Promise.resolve();
    });
    expect(session.noteBoardReveal).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    expect(session.noteBoardReveal).toHaveBeenCalledWith(
      session.getIdentity(),
      {
        responseId: 'response-1',
        visualCueId: 'cue-1',
        semanticObjectId: 'group-a',
        groupLabel: 'First',
      },
    );

    await act(async () => {
      lessonHarness.animationResolvers.shift()?.(true);
      await completion;
    });
    expect(completed).toBe(true);
  });
});

describe('RealtimeSession board metric recorders', () => {
  it('schema-validates navigation and disappearance before sending', async () => {
    const actual = await vi.importActual<typeof import('./realtimeSession')>('./realtimeSession');
    const session = new actual.RealtimeSession('session-1');
    const sent: RuntimeEventEnvelope<Record<string, unknown>>[] = [];
    const socketHarness = session as unknown as {
      ws: { readyState: number; send(raw: string): void };
    };
    socketHarness.ws = {
      readyState: WebSocket.OPEN,
      send: (raw) => sent.push(JSON.parse(raw) as RuntimeEventEnvelope<Record<string, unknown>>),
    };
    const recorder = session as unknown as {
      recordSectionNavigation(input: {
        previousGroupId: string | null;
        nextGroupId: string;
        cause: 'initial_anchor' | 'notice_open' | 'picker' | 'draft_restore' | 'arrow' | 'task_focus' | 'tutor_announce';
      }): void;
      recordTutorObjectDisappearance(input: {
        objectId: string;
        cause: 'scene_mutation' | 'unknown';
      }): void;
    };

    recorder.recordSectionNavigation({
      previousGroupId: null,
      nextGroupId: 'group-a',
      cause: 'initial_anchor',
    });
    recorder.recordTutorObjectDisappearance({
      objectId: 'object-a',
      cause: 'scene_mutation',
    });
    recorder.recordSectionNavigation({
      previousGroupId: 'group-a',
      nextGroupId: '',
      cause: 'picker',
    });

    expect(sent.filter((event) => event.type === 'metric').map((event) => event.payload)).toEqual([
      {
        schemaVersion: '1.0.0',
        name: 'section_navigation',
        unit: 'count',
        value: 1,
        dimensions: {
          previousSemanticGroupId: 'group-root',
          nextSemanticGroupId: 'group-a',
          cause: 'initial_anchor',
        },
      },
      {
        schemaVersion: '1.0.0',
        name: 'tutor_object_disappearance',
        unit: 'count',
        value: 1,
        dimensions: {
          objectId: 'object-a',
          cause: 'scene_mutation',
        },
      },
    ]);
  });
});
