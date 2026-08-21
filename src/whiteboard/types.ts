export const BOARD_WIDTH = 1000;
export const BOARD_HEIGHT = 600;

export interface DrawLineAction {
  type: 'drawLine';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color?: string;
  strokeWidth?: number;
}

export interface WriteTextAction {
  type: 'writeText';
  str: string;
  x: number;
  y: number;
  color?: string;
  fontSize?: number;
}

export interface DrawEllipseAction {
  type: 'drawEllipse';
  x: number;
  y: number;
  rx: number;
  ry: number;
  color?: string;
  strokeWidth?: number;
}

export interface BoardPoint {
  x: number;
  y: number;
}

/** A freehand stroke created with the learner's pen tool. */
export interface DrawPathAction {
  type: 'drawPath';
  points: BoardPoint[];
  color?: string;
  strokeWidth?: number;
}

export type WhiteboardAction =
  | DrawLineAction
  | WriteTextAction
  | DrawEllipseAction
  | DrawPathAction;

export interface ChatStep {
  type: 'chat';
  text: string;
}

export interface ClearStep {
  type: 'clear';
}

export type LessonStep = WhiteboardAction | ChatStep | ClearStep;

export function DrawLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  options?: { color?: string; strokeWidth?: number },
): DrawLineAction {
  return { type: 'drawLine', x1, y1, x2, y2, ...options };
}

export function writeText(
  str: string,
  x: number,
  y: number,
  options?: { color?: string; fontSize?: number },
): WriteTextAction {
  return { type: 'writeText', str, x, y, ...options };
}

export function chat(text: string): ChatStep {
  return { type: 'chat', text };
}

export function clearWhiteboard(): ClearStep {
  return { type: 'clear' };
}

export function drawEllipse(
  x: number,
  y: number,
  rx: number,
  ry: number,
  options?: { color?: string; strokeWidth?: number },
): DrawEllipseAction {
  return { type: 'drawEllipse', x, y, rx, ry, ...options };
}

export function drawPath(
  points: BoardPoint[],
  options?: { color?: string; strokeWidth?: number },
): DrawPathAction {
  return { type: 'drawPath', points, ...options };
}
