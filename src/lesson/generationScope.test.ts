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
});
