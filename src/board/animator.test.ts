import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardAnimator, hideForAnimation } from './animator';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('BoardAnimator cancellation', () => {
  it('drops the transient checkpoint instead of finishing queued drawing', async () => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    document.body.append(path);
    hideForAnimation(path, 'path', 100);
    const animator = new BoardAnimator();
    animator.enqueue({ itemId: 'group-1', nodes: [{ el: path, kind: 'path', length: 100 }] });
    const idle = animator.whenIdle();
    animator.cancelAll();
    await expect(idle).resolves.toBe(false);
    expect(path.style.strokeDashoffset).toBe('100');
  });
});
