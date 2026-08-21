import type { BoardPoint } from './types';

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
