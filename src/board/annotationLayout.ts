import { BOARD_H, BOARD_W, type Vec } from '../../shared/boardOps';
import { compileScene, nodeBBox, type BBox, type CompiledItem } from './compile';
import { sampleArcSegments, sampleCurveSegments } from './compileCurves';
import type { SceneItem, SceneState } from './scene';

interface Segment { from: Vec; to: Vec }
interface GeometryObstacle { itemId: string; segments: Segment[]; solids: BBox[] }

const SAFE = { x: 24, y: 24, w: BOARD_W - 48, h: BOARD_H - 48 };
const TOOLBAR = { x: 780, y: 0, w: 220, h: 92 };
const TEXT_GAP = 12;
const STROKE_GAP = 10;

// Prefer small, meaning-preserving moves, then use wider annotation lanes.
// The final top/bottom candidates keep a dense figure readable rather than
// accepting a collision when its immediate neighbourhood is full.
const CANDIDATE_OFFSETS: Vec[] = [
  [0, 0], [0, -52], [0, 52], [-72, 0], [72, 0],
  [-96, -58], [96, -58], [-96, 58], [96, 58],
  [0, -104], [0, 104], [-144, 0], [144, 0],
  [-156, -86], [156, -86], [-156, 86], [156, 86],
  [0, -156], [0, 156],
];

/**
 * Deterministically places free-standing tutor annotations around real stroke
 * geometry. Model coordinates remain a preference, not an authority: the
 * closest collision-free candidate wins. Container-owned text (boxes, tables,
 * axes, number lines) and learner marks are never moved here.
 */
export function layoutTutorAnnotations(scene: SceneState): SceneState {
  let arranged = scene;
  for (const original of scene.items) {
    if (original.owner !== 'tutor' || !isMovableAnnotation(original)) continue;
    arranged = placeAnnotation(arranged, original.id);
  }
  return arranged;
}

/** Exact scene-level defects used by inspection and regression tests. */
export function annotationGeometryCollisions(scene: SceneState): Array<{ itemId: string; withItemId: string }> {
  const compiled = compileScene(scene.items);
  const byId = new Map(compiled.map((item) => [item.id, item]));
  const obstacles = geometryObstacles(scene.items, byId);
  const collisions: Array<{ itemId: string; withItemId: string }> = [];
  const seen = new Set<string>();
  for (const item of scene.items) {
    if (item.owner !== 'tutor' || !isMovableAnnotation(item)) continue;
    const box = byId.get(item.id)?.bbox;
    if (!box) continue;
    for (const obstacle of obstacles) {
      if (obstacle.itemId === item.id) continue;
      const hit = obstacle.solids.some((solid) => boxesOverlap(box, solid, STROKE_GAP)) ||
        obstacle.segments.some((segment) => segmentIntersectsBox(segment, box, STROKE_GAP));
      const key = `${item.id}\u0000${obstacle.itemId}`;
      if (hit && !seen.has(key)) {
        seen.add(key);
        collisions.push({ itemId: item.id, withItemId: obstacle.itemId });
      }
    }
  }
  return collisions;
}

function placeAnnotation(scene: SceneState, itemId: string): SceneState {
  const current = scene.items.find((item) => item.id === itemId);
  if (!current || !isMovableAnnotation(current)) return scene;
  const [preferredX, preferredY] = current.spec.at;
  let best = scene;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestAt: Vec = current.spec.at;

  for (const [dx, dy] of CANDIDATE_OFFSETS) {
    const at: Vec = [preferredX + dx, preferredY + dy];
    const candidate = replaceAnnotationAt(scene, itemId, at);
    const compiled = compileScene(candidate.items);
    const byId = new Map(compiled.map((item) => [item.id, item]));
    const box = byId.get(itemId)?.bbox;
    if (!box) continue;
    const score = layoutScore(candidate, itemId, box, compiled, byId) + Math.hypot(dx, dy) * 0.01;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
      bestAt = at;
    }
    if (score < 1) break;
  }

  if (bestAt[0] === preferredX && bestAt[1] === preferredY) return scene;
  return {
    ...best,
    items: best.items.map((item) => item.id === itemId ? { ...item, revision: item.revision + 1 } : item),
  };
}

function layoutScore(
  scene: SceneState,
  itemId: string,
  box: BBox,
  compiled: CompiledItem[],
  byId: Map<string, CompiledItem>,
): number {
  let score = 0;
  if (!contains(SAFE, box)) score += 1_000_000 + outsideDistance(SAFE, box) * 1_000;
  if (boxesOverlap(box, TOOLBAR, 4)) score += 1_000_000;

  for (const other of compiled) {
    if (other.id === itemId) continue;
    for (const node of other.nodes) {
      if (node.type !== 'path' && boxesOverlap(box, nodeBBox(node), TEXT_GAP)) score += 100_000;
    }
  }
  for (const obstacle of geometryObstacles(scene.items, byId)) {
    if (obstacle.itemId === itemId) continue;
    for (const solid of obstacle.solids) if (boxesOverlap(box, solid, STROKE_GAP)) score += 100_000;
    for (const segment of obstacle.segments) if (segmentIntersectsBox(segment, box, STROKE_GAP)) score += 100_000;
  }
  return score;
}

function isMovableAnnotation(item: SceneItem): item is SceneItem & { spec: Extract<SceneItem['spec'], { kind: 'text' | 'equation' }> } {
  return item.spec.kind === 'text' || item.spec.kind === 'equation';
}

function replaceAnnotationAt(scene: SceneState, itemId: string, at: Vec): SceneState {
  return {
    ...scene,
    items: scene.items.map((item) => isMovableAnnotation(item) && item.id === itemId
      ? { ...item, spec: { ...item.spec, at } }
      : item),
  };
}

function geometryObstacles(items: SceneItem[], compiled: Map<string, CompiledItem>): GeometryObstacle[] {
  return items.map((item) => {
    const spec = item.spec;
    const segments: Segment[] = [];
    const solids: BBox[] = [];
    switch (spec.kind) {
      case 'line':
        segments.push({ from: spec.from, to: spec.to });
        break;
      case 'polygon':
        segments.push(...segmentsForPoints(spec.points, spec.closed !== false));
        if (spec.fill) {
          const box = compiled.get(item.id)?.bbox;
          if (box) solids.push(box);
        }
        break;
      case 'path':
        segments.push(...segmentsForPoints(spec.points, false));
        break;
      case 'curve':
        segments.push(...sampleCurveSegments(spec));
        break;
      case 'arc':
        segments.push(...sampleArcSegments(spec));
        break;
      case 'asset': {
        const box = compiled.get(item.id)?.bbox;
        if (box) solids.push(box);
        break;
      }
      case 'circle':
        segments.push(...ellipseSegments(spec.center, spec.r, spec.r));
        break;
      case 'ellipse':
        segments.push(...ellipseSegments(spec.center, spec.rx, spec.ry));
        break;
      case 'point':
        segments.push(...ellipseSegments(spec.at, 5, 5, 12));
        break;
      case 'angle':
        segments.push(...angleSegments(spec.vertex, spec.from, spec.to, spec.radius ?? 34));
        break;
      case 'axes': {
        const [x0, x1] = spec.xRange;
        const [y0, y1] = spec.yRange;
        const originX = x0 <= 0 && x1 >= 0 ? spec.at[0] + ((0 - x0) / (x1 - x0)) * spec.w : spec.at[0];
        const originY = y0 <= 0 && y1 >= 0 ? spec.at[1] + spec.h - ((0 - y0) / (y1 - y0)) * spec.h : spec.at[1] + spec.h;
        segments.push({ from: [spec.at[0] - 6, originY], to: [spec.at[0] + spec.w + 10, originY] });
        segments.push({ from: [originX, spec.at[1] + spec.h + 6], to: [originX, spec.at[1] - 10] });
        const box = compiled.get(item.id)?.bbox;
        if (box) solids.push(box);
        break;
      }
      case 'numberline':
        segments.push({ from: [spec.at[0] - 8, spec.at[1]], to: [spec.at[0] + spec.w + 8, spec.at[1]] });
        break;
      case 'connector': {
        const from = endpoint(spec.from, compiled);
        const to = endpoint(spec.to, compiled);
        if (from && to) segments.push({ from, to });
        break;
      }
      case 'box':
      case 'bars':
      case 'table': {
        const box = compiled.get(item.id)?.bbox;
        if (box) solids.push(box);
        break;
      }
      case 'plot':
      case 'text':
      case 'equation':
      case 'label':
        break;
    }
    return { itemId: item.id, segments, solids };
  }).filter((obstacle) => obstacle.segments.length > 0 || obstacle.solids.length > 0);
}

function endpoint(value: string | Vec, compiled: Map<string, CompiledItem>): Vec | null {
  if (Array.isArray(value)) return value;
  const box = compiled.get(value)?.bbox;
  return box ? [box.x + box.w / 2, box.y + box.h / 2] : null;
}

function segmentsForPoints(points: Vec[], closed: boolean): Segment[] {
  const segments: Segment[] = [];
  for (let index = 1; index < points.length; index += 1) segments.push({ from: points[index - 1], to: points[index] });
  if (closed && points.length > 2) segments.push({ from: points[points.length - 1], to: points[0] });
  return segments;
}

function ellipseSegments(center: Vec, rx: number, ry: number, steps = 36): Segment[] {
  const points = Array.from({ length: steps + 1 }, (_, index): Vec => {
    const angle = (index / steps) * Math.PI * 2;
    return [center[0] + Math.cos(angle) * rx, center[1] + Math.sin(angle) * ry];
  });
  return segmentsForPoints(points, false);
}

function angleSegments(vertex: Vec, from: Vec, to: Vec, radius: number): Segment[] {
  const a1 = Math.atan2(from[1] - vertex[1], from[0] - vertex[0]);
  const a2 = Math.atan2(to[1] - vertex[1], to[0] - vertex[0]);
  let sweep = a2 - a1;
  while (sweep <= -Math.PI) sweep += Math.PI * 2;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  const steps = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
  const points = Array.from({ length: steps + 1 }, (_, index): Vec => {
    const angle = a1 + sweep * (index / steps);
    return [vertex[0] + Math.cos(angle) * radius, vertex[1] + Math.sin(angle) * radius];
  });
  return segmentsForPoints(points, false);
}

function segmentIntersectsBox(segment: Segment, box: BBox, gap: number): boolean {
  const expanded = { x: box.x - gap, y: box.y - gap, w: box.w + gap * 2, h: box.h + gap * 2 };
  if (pointInside(segment.from, expanded) || pointInside(segment.to, expanded)) return true;
  const topLeft: Vec = [expanded.x, expanded.y];
  const topRight: Vec = [expanded.x + expanded.w, expanded.y];
  const bottomRight: Vec = [expanded.x + expanded.w, expanded.y + expanded.h];
  const bottomLeft: Vec = [expanded.x, expanded.y + expanded.h];
  return [
    { from: topLeft, to: topRight },
    { from: topRight, to: bottomRight },
    { from: bottomRight, to: bottomLeft },
    { from: bottomLeft, to: topLeft },
  ].some((edge) => segmentsIntersect(segment, edge));
}

function segmentsIntersect(left: Segment, right: Segment): boolean {
  const o1 = orientation(left.from, left.to, right.from);
  const o2 = orientation(left.from, left.to, right.to);
  const o3 = orientation(right.from, right.to, left.from);
  const o4 = orientation(right.from, right.to, left.to);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  const epsilon = 1e-7;
  return (Math.abs(o1) < epsilon && onSegment(left.from, right.from, left.to)) ||
    (Math.abs(o2) < epsilon && onSegment(left.from, right.to, left.to)) ||
    (Math.abs(o3) < epsilon && onSegment(right.from, left.from, right.to)) ||
    (Math.abs(o4) < epsilon && onSegment(right.from, left.to, right.to));
}

function orientation(a: Vec, b: Vec, c: Vec): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: Vec, point: Vec, b: Vec): boolean {
  return point[0] >= Math.min(a[0], b[0]) - 1e-7 && point[0] <= Math.max(a[0], b[0]) + 1e-7 &&
    point[1] >= Math.min(a[1], b[1]) - 1e-7 && point[1] <= Math.max(a[1], b[1]) + 1e-7;
}

function boxesOverlap(a: BBox, b: BBox, gap: number): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

function contains(outer: BBox, inner: BBox): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

function outsideDistance(outer: BBox, inner: BBox): number {
  return Math.max(0, outer.x - inner.x) + Math.max(0, outer.y - inner.y) +
    Math.max(0, inner.x + inner.w - (outer.x + outer.w)) + Math.max(0, inner.y + inner.h - (outer.y + outer.h));
}

function pointInside(point: Vec, box: BBox): boolean {
  return point[0] >= box.x && point[0] <= box.x + box.w && point[1] >= box.y && point[1] <= box.y + box.h;
}
