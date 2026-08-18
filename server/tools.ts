import type { LessonStep } from '../src/whiteboard/types';

export const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'draw_line',
      description: 'Draw a straight line segment on the whiteboard between two points.',
      parameters: {
        type: 'object',
        properties: {
          x1: { type: 'number' },
          y1: { type: 'number' },
          x2: { type: 'number' },
          y2: { type: 'number' },
          color: { type: 'string', description: 'CSS color, e.g. "#dc2626". Optional.' },
          strokeWidth: { type: 'number', description: 'Line thickness. Optional.' },
        },
        required: ['x1', 'y1', 'x2', 'y2'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_text',
      description: 'Write a short text annotation on the whiteboard at a position.',
      parameters: {
        type: 'object',
        properties: {
          str: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          color: { type: 'string', description: 'CSS color. Optional.' },
          fontSize: { type: 'number', description: 'Font size in px. Optional.' },
        },
        required: ['str', 'x', 'y'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'draw_ellipse',
      description:
        'Draw an ellipse (or circle, when rx equals ry) on the whiteboard, centered at (x, y).',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Center x.' },
          y: { type: 'number', description: 'Center y.' },
          rx: { type: 'number', description: 'Horizontal radius.' },
          ry: { type: 'number', description: 'Vertical radius.' },
          color: { type: 'string', description: 'CSS color. Optional.' },
          strokeWidth: { type: 'number', description: 'Outline thickness. Optional.' },
        },
        required: ['x', 'y', 'rx', 'ry'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'clear_whiteboard',
      description: 'Erase everything currently drawn on the whiteboard.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

/**
 * Maps a single OpenAI tool call (function name + parsed arguments) to a
 * LessonStep the frontend knows how to play back. Returns null for unknown
 * tool names or malformed arguments so the caller can skip them gracefully.
 */
export function toolCallToStep(name: string, args: Record<string, unknown>): LessonStep | null {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  switch (name) {
    case 'draw_line': {
      const x1 = num(args.x1);
      const y1 = num(args.y1);
      const x2 = num(args.x2);
      const y2 = num(args.y2);
      if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
      return {
        type: 'drawLine',
        x1,
        y1,
        x2,
        y2,
        color: str(args.color),
        strokeWidth: num(args.strokeWidth) ?? undefined,
      };
    }
    case 'write_text': {
      const x = num(args.x);
      const y = num(args.y);
      const s = str(args.str);
      if (x === null || y === null || s === undefined) return null;
      return {
        type: 'writeText',
        str: s,
        x,
        y,
        color: str(args.color),
        fontSize: num(args.fontSize) ?? undefined,
      };
    }
    case 'draw_ellipse': {
      const x = num(args.x);
      const y = num(args.y);
      const rx = num(args.rx);
      const ry = num(args.ry);
      if (x === null || y === null || rx === null || ry === null) return null;
      return {
        type: 'drawEllipse',
        x,
        y,
        rx,
        ry,
        color: str(args.color),
        strokeWidth: num(args.strokeWidth) ?? undefined,
      };
    }
    case 'clear_whiteboard':
      return { type: 'clear' };
    default:
      return null;
  }
}
