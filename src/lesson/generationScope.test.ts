import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationScope } from './generationScope';

afterEach(() => vi.useRealTimers());

describe('GenerationScope', () => {
  it('atomically aborts timers and registered work', () => {
    vi.useFakeTimers();
    const scope = new GenerationScope({ sessionId: 's', connectionEpoch: 1, turnId: 't', generationId: 'g' });
    const timeout = vi.fn();
    const interval = vi.fn();
    const cleanup = vi.fn();
    scope.timeout(timeout, 20);
    scope.interval(interval, 10);
    scope.addCleanup(cleanup);
    scope.cancel('learner interruption');
    vi.advanceTimersByTime(100);
    expect(scope.signal.aborted).toBe(true);
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('does not let cancelled scopes schedule stale callbacks', () => {
    vi.useFakeTimers();
    const scope = new GenerationScope({ sessionId: 's', connectionEpoch: 1, turnId: 't', generationId: 'g' });
    scope.cancel('stale');
    const callback = vi.fn();
    scope.timeout(callback, 0);
    vi.runAllTimers();
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'complete', 'fail'] as const)('does not retain work registered after %s', (finish) => {
    vi.useFakeTimers();
    const scope = new GenerationScope({ sessionId: 's', connectionEpoch: 1, turnId: 't', generationId: 'g' });
    if (finish === 'complete') scope.complete();
    else scope[finish]('finished');
    const callback = vi.fn();
    const cleanup = vi.fn();
    scope.timeout(callback, 100);
    scope.interval(callback, 100);
    scope.frame(callback);
    scope.addCleanup(cleanup);
    expect(vi.getTimerCount()).toBe(0);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
  });
});
