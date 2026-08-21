import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Whiteboard } from './Whiteboard';
import { createBoardObject } from './scene';
import { DrawLine } from './types';

function renderBoard(
  overrides: Partial<React.ComponentProps<typeof Whiteboard>> = {},
) {
  const onUpsertObject = vi.fn();
  const onRemoveObject = vi.fn();
  const view = render(
    <Whiteboard
      objects={[]}
      activeTutorObjectId={null}
      onUpsertObject={onUpsertObject}
      onRemoveObject={onRemoveObject}
      {...overrides}
    />,
  );
  const svg = screen.getByRole('img');
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 600,
    width: 1000,
    height: 600,
    toJSON: () => ({}),
  });
  return { ...view, svg, onUpsertObject, onRemoveObject };
}

describe('Whiteboard toolbar', () => {
  it('creates one durable freehand object while the learner draws', () => {
    const { svg, onUpsertObject } = renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Draw' }));

    fireEvent.pointerDown(svg, { clientX: 10, clientY: 20, pointerId: 1, button: 0 });
    fireEvent.pointerMove(svg, { clientX: 30, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 30, clientY: 40, pointerId: 1 });

    const first = onUpsertObject.mock.calls[0][0];
    const last = onUpsertObject.mock.calls.at(-1)?.[0];
    expect(first.owner).toBe('learner');
    expect(last.id).toBe(first.id);
    expect(last.action).toMatchObject({
      type: 'drawPath',
      points: [
        { x: 10, y: 20 },
        { x: 30, y: 40 },
      ],
    });
  });

  it('places learner text where the board was clicked', () => {
    const { svg, onUpsertObject } = renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Add text' }));
    fireEvent.click(svg, { clientX: 120, clientY: 180, button: 0 });

    const input = screen.getByRole('textbox', { name: 'Whiteboard text' });
    fireEvent.change(input, { target: { value: 'my working' } });
    fireEvent.blur(input);

    expect(onUpsertObject).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'learner',
        action: expect.objectContaining({
          type: 'writeText',
          str: 'my working',
          x: 120,
          y: 180,
        }),
      }),
    );
  });

  it('erases the selected board component by stable ID', () => {
    const object = createBoardObject('tutor', DrawLine(10, 10, 100, 100), 'line-1');
    const { container, onRemoveObject } = renderBoard({ objects: [object] });
    fireEvent.click(screen.getByRole('button', { name: 'Erase an object' }));

    const hitTarget = container.querySelector('.whiteboard__hit-target');
    expect(hitTarget).not.toBeNull();
    fireEvent.pointerDown(hitTarget as Element);

    expect(onRemoveObject).toHaveBeenCalledWith('line-1');
  });
});

describe('Seneca drawing cursor', () => {
  it('follows the active tutor stroke without becoming a board object', () => {
    const object = createBoardObject('tutor', DrawLine(10, 20, 30, 40), 'line-1');
    const { container } = renderBoard({
      objects: [object],
      activeTutorObjectId: 'line-1',
    });

    expect(container.querySelectorAll('[data-board-object]')).toHaveLength(1);
    expect(
      container
        .querySelector('.whiteboard__tutor-cursor animateMotion')
        ?.getAttribute('path'),
    ).toBe('M 10 20 L 30 40');
  });
});
