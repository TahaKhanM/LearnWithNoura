import type { BoardPoint, WhiteboardAction } from './types';

export function pointsToPath(points: BoardPoint[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  const commands = [`M ${points[0].x} ${points[0].y}`];
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    commands.push(`Q ${point.x} ${point.y} ${(point.x + next.x) / 2} ${(point.y + next.y) / 2}`);
  }
  const last = points.at(-1) as BoardPoint;
  commands.push(`L ${last.x} ${last.y}`);
  return commands.join(' ');
}

/** Motion path followed by the purely-presentational Seneca marker. */
export function cursorPathForAction(action: WhiteboardAction): string {
  if (action.type === 'drawLine') {
    return `M ${action.x1} ${action.y1} L ${action.x2} ${action.y2}`;
  }
  if (action.type === 'drawEllipse') {
    return [
      `M ${action.x + action.rx} ${action.y}`,
      `A ${action.rx} ${action.ry} 0 1 1 ${action.x - action.rx} ${action.y}`,
      `A ${action.rx} ${action.ry} 0 1 1 ${action.x + action.rx} ${action.y}`,
    ].join(' ');
  }
  if (action.type === 'writeText') {
    const width = Math.max(
      action.fontSize ?? 20,
      Math.round(action.str.length * (action.fontSize ?? 20) * 52) / 100,
    );
    return `M ${action.x} ${action.y} L ${action.x + width} ${action.y}`;
  }
  return pointsToPath(action.points);
}
