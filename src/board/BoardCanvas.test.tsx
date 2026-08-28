import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyScene, applyOps } from './scene';
import { BoardAnimator } from './animator';
import { BoardCanvas } from './BoardCanvas';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

describe('BoardCanvas compact focus coordinates', () => {
  it('hides peek-neighbour labels using world space, not the active region local crop', () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query.includes('max-width: 540px') || query.includes('max-height: 500px') || query.includes('prefers-reduced-motion'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    let scene = applyOps(emptyScene, [
      { op: 'add', id: 'one-note', spec: { kind: 'text', at: [200, 120], text: 'First idea' } },
    ], 'tutor', 'region-one').scene;
    scene = applyOps(scene, [
      { op: 'add', id: 'two-note', spec: { kind: 'text', at: [200, 120], text: 'Second idea' } },
    ], 'tutor', 'region-two').scene;

    const { container } = render(
      <BoardCanvas
        scene={scene}
        highlights={[]}
        tool="pointer"
        penColor="#2C5BE0"
        interactive={false}
        onLearnerStroke={() => {}}
        onLearnerErase={() => {}}
        focusSemanticObjectId="region-two"
        cameraRegionId="region-two"
      />,
    );

    const neighbour = container.querySelector('[data-item="one-note"] [data-required-text="First idea"]');
    const focused = container.querySelector('[data-item="two-note"] [data-required-text="Second idea"]');
    expect(neighbour?.getAttribute('visibility')).toBe('hidden');
    expect(focused?.getAttribute('visibility')).toBe('visible');
  });
});
