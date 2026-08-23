import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyScene } from './scene';
import { BoardAnimator } from './animator';
import { BoardCanvas } from './BoardCanvas';

afterEach(() => cleanup());

describe('BoardCanvas animator lifecycle', () => {
  it('does not cancel drawing work when parent callbacks change during a re-render', () => {
    const cancel = vi.spyOn(BoardAnimator.prototype, 'cancelAll');
    const base = {
      scene: emptyScene,
      highlights: [],
      tool: 'pointer' as const,
      penColor: '#2C5BE0',
      interactive: true,
      onLearnerStroke: () => {},
      onLearnerErase: () => {},
    };
    const rendered = render(
      <BoardCanvas {...base} onTutorPen={() => {}} animatorRef={() => {}} />,
    );

    rendered.rerender(
      <BoardCanvas {...base} onTutorPen={() => {}} animatorRef={() => {}} />,
    );
    expect(cancel).not.toHaveBeenCalled();

    rendered.unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
