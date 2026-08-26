import { describe, expect, it, vi } from 'vitest';
import { createLiveCompilationService } from './compilationService.js';

describe('createLiveCompilationService', () => {
  it('hands the background compile promise to keepAlive so serverless can wait', async () => {
    const keepAlive = vi.fn();
    const upsert = vi.fn(async (_sessionId: string, update: { status: string }) => ({
      sessionId: 'session-1',
      status: update.status,
      lesson: null,
      failureReason: null,
      createdAt: 1,
      updatedAt: 1,
    }));
    const service = createLiveCompilationService({
      repo: { upsertCompiledLesson: upsert } as never,
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
      harnessUrl: 'http://127.0.0.1:5173/dev/board',
      keepAlive,
    });

    const pending = await service.start({
      sessionId: 'session-1',
      goal: 'fractions',
      objective: 'Place 3/4 on a number line',
    });

    expect(pending.status).toBe('pending');
    expect(keepAlive).toHaveBeenCalledTimes(1);
    const work = keepAlive.mock.calls[0]?.[0];
    expect(work).toBeInstanceOf(Promise);
    await work;
    expect(upsert).toHaveBeenCalledWith('session-1', expect.objectContaining({ status: 'failed' }));
  });

  it('awaits compilation inline when no board harness is configured', async () => {
    const keepAlive = vi.fn();
    const records = new Map<string, { sessionId: string; status: string }>();
    const repo = {
      upsertCompiledLesson: async (sessionId: string, update: { status: string }) => {
        const record = { sessionId, status: update.status };
        records.set(sessionId, record);
        return record;
      },
      getCompiledLesson: async (sessionId: string) => records.get(sessionId) ?? null,
    };
    const service = createLiveCompilationService({
      repo: repo as never,
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

    const finished = await service.start({
      sessionId: 'session-1',
      goal: 'fractions',
      objective: 'Place 3/4 on a number line',
    });

    expect(keepAlive).not.toHaveBeenCalled();
    expect(finished.status).toBe('failed');
  });
});
