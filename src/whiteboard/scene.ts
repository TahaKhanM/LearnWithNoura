import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  type BoardPoint,
  type WhiteboardAction,
} from './types';

export type BoardOwner = 'tutor' | 'learner';

/** The durable unit on the board. IDs make individual erasing possible. */
export interface BoardObject {
  id: string;
  owner: BoardOwner;
  action: WhiteboardAction;
}

export interface BoardSnapshot {
  version: 1;
  width: number;
  height: number;
  objects: BoardObject[];
}

let fallbackId = 0;

export function createBoardObject(
  owner: BoardOwner,
  action: WhiteboardAction,
  id = nextBoardObjectId(owner),
): BoardObject {
  return { id, owner, action };
}

export function nextBoardObjectId(owner: BoardOwner): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${owner}-${crypto.randomUUID()}`;
  }
  fallbackId += 1;
  return `${owner}-${fallbackId}`;
}

export function snapshotBoard(objects: BoardObject[]): BoardSnapshot {
  return {
    version: 1,
    width: BOARD_WIDTH,
    height: BOARD_HEIGHT,
    // Copy the containers so an in-flight request is not changed by a
    // learner edit made after the request starts.
    objects: objects.map((object) => ({
      ...object,
      action:
        object.action.type === 'drawPath'
          ? {
              ...object.action,
              points: object.action.points.map((point) => ({ ...point })),
            }
          : { ...object.action },
    })),
  };
}

/** A light sampler keeps long freehand strokes compact in model context. */
export function samplePath(points: BoardPoint[], maxPoints = 80): BoardPoint[] {
  if (points.length <= maxPoints) return points;
  const last = points.length - 1;
  return Array.from({ length: maxPoints }, (_, index) => {
    const sourceIndex = Math.round((index / (maxPoints - 1)) * last);
    return points[sourceIndex];
  });
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function compactPoint(point: BoardPoint): [number, number] {
  return [rounded(point.x), rounded(point.y)];
}

/**
 * Removes UI-only IDs and uses short field names before sending the scene
 * to the model. Ownership remains because learner marks must be respected.
 */
export function compactBoardSnapshot(snapshot: BoardSnapshot): object {
  const maxObjects = 200;
  const omittedObjects = Math.max(0, snapshot.objects.length - maxObjects);
  // Preserve both the foundation of a diagram and its newest annotations.
  const visibleObjects =
    omittedObjects === 0
      ? snapshot.objects
      : [...snapshot.objects.slice(0, maxObjects / 2), ...snapshot.objects.slice(-maxObjects / 2)];
  const freehandCount = visibleObjects.filter(
    ({ action }) => action.type === 'drawPath',
  ).length;
  const pointsPerPath =
    freehandCount === 0 ? 80 : Math.max(6, Math.min(80, Math.floor(1_000 / freehandCount)));

  return {
    size: [snapshot.width, snapshot.height],
    ...(omittedObjects > 0 ? { omittedObjects } : {}),
    objects: visibleObjects.map(({ owner, action }) => {
      if (action.type === 'drawLine') {
        return {
          owner,
          type: 'line',
          from: compactPoint({ x: action.x1, y: action.y1 }),
          to: compactPoint({ x: action.x2, y: action.y2 }),
          color: action.color,
        };
      }
      if (action.type === 'drawEllipse') {
        return {
          owner,
          type: 'ellipse',
          center: compactPoint({ x: action.x, y: action.y }),
          radii: [rounded(action.rx), rounded(action.ry)],
          color: action.color,
        };
      }
      if (action.type === 'writeText') {
        return {
          owner,
          type: 'text',
          at: compactPoint({ x: action.x, y: action.y }),
          text: action.str.slice(0, 240),
          color: action.color,
        };
      }
      return {
        owner,
        type: 'freehand',
        points: samplePath(action.points, pointsPerPath).map(compactPoint),
        color: action.color,
      };
    }),
  };
}
