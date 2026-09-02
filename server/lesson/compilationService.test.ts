import { describe, expect, it, vi } from 'vitest';
import { createLiveCompilationService } from './compilationService.js';
import { PROVISIONAL_COMPILER_MODEL } from './provisionalLesson.js';

describe('createLiveCompilationService', () => {
  it('keeps Begin pending and fails honestly when the background compile fails', async () => {
    const keepAlive = vi.fn();
    let stored: {
      sessionId: string;
      status: string;
      lesson: { compilerModel?: string } | null;
      failureReason: string | null;
      createdAt: number;
      updatedAt: number;
    } | null = null;
    const upsert = vi.fn(async (_sessionId: string, update: { status: string; lesson?: { compilerModel?: string } | null; failureReason?: string }) => {
      stored = {
        sessionId: 'session-1',
        status: update.status,
        lesson: update.lesson ?? stored?.lesson ?? null,
        failureReason: update.failureReason ?? null,
        createdAt: 1,
        updatedAt: 1,
      };
      return stored;
    });
    const service = createLiveCompilationService({
      repo: {
        upsertCompiledLesson: upsert,
        getCompiledLesson: async () => stored,
      } as never,
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('scripted compile failure');
            },
          },
        },
      } as never,
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      harnessUrl: null,
      keepAlive,
    });

    const pending = await service.start({
      sessionId: 'session-1',
      goal: 'fractions',
      objective: 'Place 3/4 on a number line',
    });

    expect(pending.status).toBe('pending');
    expect(pending.lesson?.compilerModel).toBe(PROVISIONAL_COMPILER_MODEL);
    expect(keepAlive).toHaveBeenCalledTimes(1);
    const work = keepAlive.mock.calls[0]?.[0];
    expect(work).toBeInstanceOf(Promise);
    await work;
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenLastCalledWith('session-1', expect.objectContaining({
      status: 'failed',
      failureReason: expect.stringContaining('could not prepare'),
    }));
  });

  it('promotes a board-led compile without requiring server-side Chromium', async () => {
    const keepAlive = vi.fn();
    let stored: {
      status: string;
      lesson: { compilerModel?: string; blueprint?: { mode?: string }; anchorScene?: unknown } | null;
      failureReason: string | null;
    } | null = null;
    const upsert = vi.fn(async (_sessionId: string, update: {
      status: string;
      lesson?: { compilerModel?: string; blueprint?: { mode?: string }; anchorScene?: unknown } | null;
      failureReason?: string;
    }) => {
      stored = {
        status: update.status,
        lesson: update.lesson ?? stored?.lesson ?? null,
        failureReason: update.failureReason ?? null,
      };
      return stored;
    });
    const authored = JSON.stringify({
      mode: 'board_led',
      successCriteria: ['Learner places one value on the scale'],
      stages: [
        { id: 'orient', kind: 'orient', objective: 'Read the scale', boardPurpose: 'establish_anchor', allowedBoardMutation: 'establish', learnerOpportunity: 'Name the endpoints', evidenceExpected: 'recall' },
        { id: 'model', kind: 'model', objective: 'Place a value', boardPurpose: 'reveal_relation', allowedBoardMutation: 'extend', learnerOpportunity: 'Predict its position', evidenceExpected: 'reasoning' },
        { id: 'check', kind: 'guided_check', objective: 'Use the line', boardPurpose: 'elicit_learner_work', allowedBoardMutation: 'emphasize', learnerOpportunity: 'Explain one position', evidenceExpected: 'application', checks: [{ id: 'check-1', questionOrTask: 'Where does five go?', responseMode: 'voice', targetObjectIds: ['scale'] }] },
      ],
      anchor: {
        kind: 'raw', domain: 'quantitative', groupLabel: 'Number line',
        instructionalQuestion: 'Where does five go?',
        ops: [{ op: 'add', id: 'scale', kind: 'numberline', at: [100, 300], w: 800, min: 0, max: 10, step: 1 }],
        storyboard: [{ id: 'scale-step', reveal: 'outline', narration: 'This scale runs from zero to ten.', objectIds: ['scale'] }],
      },
    });
    const service = createLiveCompilationService({
      repo: { upsertCompiledLesson: upsert, getCompiledLesson: async () => stored } as never,
      client: { chat: { completions: { create: async () => ({ choices: [{ message: { content: authored } }] }) } } } as never,
      model: 'gpt-5.6-terra', reasoningEffort: 'medium', harnessUrl: null, keepAlive,
    });

    const pending = await service.start({ sessionId: 'session-2', goal: 'number lines', objective: 'Place five on a number line' });
    expect(pending.status).toBe('pending');
    await keepAlive.mock.calls[0]?.[0];
    const promoted = upsert.mock.calls.at(-1)?.[1];
    expect(promoted?.status).toBe('ready');
    expect(promoted?.lesson?.compilerModel).toBe('gpt-5.6-terra');
    expect(promoted?.lesson?.blueprint?.mode).toBe('board_led');
    expect(promoted?.lesson?.anchorScene).toBeTruthy();
  });
});
