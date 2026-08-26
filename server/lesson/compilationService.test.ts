import { describe, expect, it, vi } from 'vitest';
import { createLiveCompilationService } from './compilationService.js';
import { PROVISIONAL_COMPILER_MODEL } from './provisionalLesson.js';

describe('createLiveCompilationService', () => {
  it('returns a ready provisional lesson immediately and keeps it if the background compile fails', async () => {
    const keepAlive = vi.fn();
    let stored: { status: string; lesson: { compilerModel?: string } | null } | null = null;
    const upsert = vi.fn(async (_sessionId: string, update: { status: string; lesson?: { compilerModel?: string } | null }) => {
      stored = {
        sessionId: 'session-1',
        status: update.status,
        lesson: update.lesson ?? stored?.lesson ?? null,
        failureReason: null,
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

    const ready = await service.start({
      sessionId: 'session-1',
      goal: 'fractions',
      objective: 'Place 3/4 on a number line',
    });

    expect(ready.status).toBe('ready');
    expect(ready.lesson?.compilerModel).toBe(PROVISIONAL_COMPILER_MODEL);
    expect(keepAlive).toHaveBeenCalledTimes(1);
    const work = keepAlive.mock.calls[0]?.[0];
    expect(work).toBeInstanceOf(Promise);
    await work;
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).not.toHaveBeenCalledWith('session-1', expect.objectContaining({ status: 'failed' }));
  });
});
