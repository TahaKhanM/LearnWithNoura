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

  it('does not report idle between a released transaction and its DOM queue', async () => {
    const animator = new BoardAnimator();
    animator.beginTransaction('checkpoint-1');
    let settled = false;
    const idle = animator.whenIdle().then((completed) => {
      settled = true;
      return completed;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    animator.commitTransaction('checkpoint-1');

    await expect(idle).resolves.toBe(true);
  });

  it('finishing a transaction releases its pre-paint hold', async () => {
    const animator = new BoardAnimator();
    animator.beginTransaction('checkpoint-2');
    const idle = animator.whenIdle();

    animator.finishAll();

    await expect(idle).resolves.toBe(true);
  });
});
