import type { BoardOp, Vec } from '../../shared/boardOps';
import type { LearnerBoardAnalysis } from '../../shared/learnerBoard';
import { compileScene, type BBox } from './compile';
import type { SceneState } from './scene';

export function analyzeLearnerBoardChange(
  scene: SceneState,
  ops: BoardOp[],
  semanticGroupId?: string,
): LearnerBoardAnalysis {
  const tutorObjects = compileScene(scene.items)
    .filter((compiled) => scene.items.find((item) => item.id === compiled.id)?.owner === 'tutor');
  const strokes: LearnerBoardAnalysis['strokes'] = [];
  const erasedIds: string[] = [];

  for (const op of ops) {
    if (op.op === 'erase') {
      erasedIds.push(op.id);
      continue;
    }
    if (op.op !== 'add' || op.spec.kind !== 'path') continue;
    const points = op.spec.points;
    const bounds = boundsOf(points);
    const centroid = centroidOf(points);
    const length = pathLength(points);
    const diagonal = Math.max(1, Math.hypot(bounds.w, bounds.h));
    const endpointDistance = distance(points[0], points[points.length - 1]);
    const straightness = clamp01(endpointDistance / Math.max(1, length));
    const closure = clamp01(endpointDistance / diagonal);
    const corners = cornerCount(points);
    const ranked = tutorObjects
      .map((item) => ({ id: item.id, distance: pointBoxDistance(centroid, item.bbox) }))
      .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id));
    const touchedObjectIds = tutorObjects
      .filter((item) => points.some((point) => pointInsideExpandedBox(point, item.bbox, 10)))
      .map((item) => item.id)
      .slice(0, 12);
    strokes.push({
      id: op.id,
      gesture: classifyGesture(points, bounds, length, straightness, closure, corners),
      bounds: roundedBounds(bounds),
      centroid: [round(centroid[0]), round(centroid[1])],
      length: round(length),
      straightness: round(straightness, 3),
      closure: round(closure, 3),
      corners,
      nearestObjectIds: ranked.filter((candidate) => candidate.distance <= 180).slice(0, 3).map((candidate) => candidate.id),
      touchedObjectIds,
    });
  }

  const summaryParts = strokes.map((stroke) => {
    const near = stroke.nearestObjectIds.length ? ` near ${stroke.nearestObjectIds.join(', ')}` : '';
    const touched = stroke.touchedObjectIds.length ? ` touching ${stroke.touchedObjectIds.join(', ')}` : '';
    return `${stroke.gesture} ${stroke.id} at (${stroke.bounds.x},${stroke.bounds.y}) ${stroke.bounds.w}×${stroke.bounds.h}${near}${touched}`;
  });
  if (erasedIds.length) summaryParts.push(`erased ${erasedIds.join(', ')}`);
  return {
    version: '1.0.0',
    ...(semanticGroupId ? { semanticGroupId } : {}),
    strokes,
    erasedIds,
    summary: summaryParts.join('; ').slice(0, 4_000),
  };
}

export function analysisFocusBox(analysis: LearnerBoardAnalysis, padding = 70): BBox | undefined {
  if (analysis.strokes.length === 0) return undefined;
  const left = Math.min(...analysis.strokes.map((stroke) => stroke.bounds.x));
  const top = Math.min(...analysis.strokes.map((stroke) => stroke.bounds.y));
  const right = Math.max(...analysis.strokes.map((stroke) => stroke.bounds.x + stroke.bounds.w));
  const bottom = Math.max(...analysis.strokes.map((stroke) => stroke.bounds.y + stroke.bounds.h));
  const x = Math.max(0, left - padding);
  const y = Math.max(0, top - padding);
  return {
    x,
    y,
    w: Math.min(1000 - x, Math.max(140, right - left + padding * 2)),
    h: Math.min(600 - y, Math.max(120, bottom - top + padding * 2)),
  };
}

function classifyGesture(points: Vec[], bounds: BBox, length: number, straightness: number, closure: number, corners: number): LearnerBoardAnalysis['strokes'][number]['gesture'] {
  const aspect = bounds.w / Math.max(1, bounds.h);
  if (closure <= 0.24 && aspect >= 0.62 && aspect <= 1.65 && corners <= 5) return 'circle';
  if (closure <= 0.24) return 'closed_shape';
  if (isCheck(points, length)) return 'check';
  if (straightness >= 0.9) return aspect >= 3.2 ? 'underline' : 'line';
  if (Math.max(aspect, 1 / Math.max(0.01, aspect)) >= 2.2 && corners >= 2) return 'pointing_mark';
  return 'freehand';
}

function isCheck(points: Vec[], totalLength: number): boolean {
  if (points.length < 3 || totalLength < 30) return false;
  let pivot = 1;
  let maxDepth = Number.NEGATIVE_INFINITY;
  for (let index = 1; index < points.length - 1; index += 1) {
    if (points[index][1] > maxDepth) { maxDepth = points[index][1]; pivot = index; }
  }
  const first = points[0];
  const middle = points[pivot];
  const last = points[points.length - 1];
  return middle[1] > first[1] && middle[1] > last[1] && last[0] > middle[0] &&
    distance(middle, last) > distance(first, middle) * 1.15;
}

function cornerCount(points: Vec[]): number {
  if (points.length < 5) return 0;
  const stride = Math.max(1, Math.floor(points.length / 18));
  let corners = 0;
  for (let index = stride; index + stride < points.length; index += stride) {
    const a = points[index - stride];
    const b = points[index];
    const c = points[index + stride];
    const first = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const second = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let delta = Math.abs(second - first);
    if (delta > Math.PI) delta = Math.PI * 2 - delta;
    if (delta > Math.PI / 3) corners += 1;
  }
  return corners;
}

function boundsOf(points: Vec[]): BBox {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const x = Math.min(...xs); const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function centroidOf(points: Vec[]): Vec {
  return [points.reduce((sum, point) => sum + point[0], 0) / points.length, points.reduce((sum, point) => sum + point[1], 0) / points.length];
}

function pathLength(points: Vec[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += distance(points[index - 1], points[index]);
  return total;
}

function pointBoxDistance(point: Vec, box: BBox): number {
  const dx = Math.max(box.x - point[0], 0, point[0] - (box.x + box.w));
  const dy = Math.max(box.y - point[1], 0, point[1] - (box.y + box.h));
  return Math.hypot(dx, dy);
}

function pointInsideExpandedBox(point: Vec, box: BBox, padding: number): boolean {
  return point[0] >= box.x - padding && point[0] <= box.x + box.w + padding && point[1] >= box.y - padding && point[1] <= box.y + box.h + padding;
}

function roundedBounds(box: BBox): BBox { return { x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h) }; }
function distance(left: Vec, right: Vec): number { return Math.hypot(right[0] - left[0], right[1] - left[1]); }
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function round(value: number, decimals = 1): number { const scale = 10 ** decimals; return Math.round(value * scale) / scale; }
