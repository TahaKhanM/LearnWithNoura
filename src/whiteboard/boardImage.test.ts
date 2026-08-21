import { describe, expect, it } from 'vitest';
import { boardSnapshotToSvg } from './boardImage';
import { createBoardObject, snapshotBoard } from './scene';
import { DrawLine, drawEllipse, drawPath, writeText } from './types';

describe('boardSnapshotToSvg', () => {
  it('renders every scene primitive without interface chrome', () => {
    const svg = boardSnapshotToSvg(
      snapshotBoard([
        createBoardObject('tutor', DrawLine(1, 2, 3, 4), 'line'),
        createBoardObject('tutor', drawEllipse(50, 60, 20, 10), 'ellipse'),
        createBoardObject(
          'learner',
          drawPath([
            { x: 10, y: 20 },
            { x: 30, y: 40 },
          ]),
          'path',
        ),
        createBoardObject('learner', writeText('a < b & c', 70, 80), 'text'),
      ]),
    );

    expect(svg).toContain('<line ');
    expect(svg).toContain('<ellipse ');
    expect(svg).toContain('<path d="M 10 20 L 30 40"');
    expect(svg).toContain('a &lt; b &amp; c');
    expect(svg).toContain('id="grid"');
    expect(svg).not.toContain('toolbar');
  });
});
