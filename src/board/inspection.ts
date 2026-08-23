import { BOARD_H, BOARD_W, type ShapeSpec, type Vec } from '../../shared/boardOps';
import { compileScene, nodeBBox, type BBox } from './compile';
import { annotationGeometryCollisions } from './annotationLayout';
import type { SceneItem, SceneState } from './scene';

const SAFE = { x: 24, y: 24, w: BOARD_W - 48, h: BOARD_H - 48 };
const TOOLBAR = { x: 780, y: 0, w: 220, h: 92 };
const TEXT_BEARING = new Set<ShapeSpec['kind']>(['text', 'equation', 'label', 'point', 'angle', 'bars', 'numberline', 'box', 'table']);

export interface SceneInspection {
  accepted: boolean;
  issues: Array<{ itemId: string; kind: 'bounds' | 'collision' | 'stroke_collision' | 'reserved' | 'non_finite'; withItemId?: string }>;
}

export function inspectScene(scene: SceneState): SceneInspection {
  const compiled = compileScene(scene.items);
  const issues: SceneInspection['issues'] = [];
  for (const item of compiled) {
    const box = item.bbox;
    if (![box.x, box.y, box.w, box.h].every(Number.isFinite)) issues.push({ itemId: item.id, kind: 'non_finite' });
    else if (!contains(SAFE, box)) issues.push({ itemId: item.id, kind: 'bounds' });
    const source = scene.items.find((candidate) => candidate.id === item.id);
    if (source && TEXT_BEARING.has(source.spec.kind) && intersects(box, TOOLBAR)) issues.push({ itemId: item.id, kind: 'reserved' });
  }
  for (let left = 0; left < compiled.length; left += 1) {
    const leftSource = scene.items.find((item) => item.id === compiled[left].id);
    if (!leftSource || !TEXT_BEARING.has(leftSource.spec.kind)) continue;
    const leftTextBoxes = compiled[left].nodes.filter((node) => node.type !== 'path').map(nodeBBox);
    if (leftTextBoxes.length === 0) continue;
    for (let right = left + 1; right < compiled.length; right += 1) {
      const rightSource = scene.items.find((item) => item.id === compiled[right].id);
      if (!rightSource || !TEXT_BEARING.has(rightSource.spec.kind)) continue;
      if (dependentPair(leftSource, rightSource)) continue;
      const rightTextBoxes = compiled[right].nodes.filter((node) => node.type !== 'path').map(nodeBBox);
      if (leftTextBoxes.some((leftBox) => rightTextBoxes.some((rightBox) => overlapRatio(leftBox, rightBox) > 0.16))) {
        issues.push({ itemId: compiled[right].id, kind: 'collision', withItemId: compiled[left].id });
      }
    }
  }
  for (const collision of annotationGeometryCollisions(scene)) {
    issues.push({ ...collision, kind: 'stroke_collision' });
  }
  return { accepted: issues.length === 0, issues };
}

/** One deterministic containment/collision repair pass; callers inspect again. */
export function repairSceneOnce(scene: SceneState, inspection = inspectScene(scene)): SceneState {
  const compiled = new Map(compileScene(scene.items).map((item) => [item.id, item.bbox]));
  const issueMap = new Map<string, SceneInspection['issues']>();
  for (const issue of inspection.issues) issueMap.set(issue.itemId, [...(issueMap.get(issue.itemId) ?? []), issue]);
  const items = scene.items.map((item) => {
    const box = compiled.get(item.id);
    const issues = issueMap.get(item.id);
    if (!box || !issues?.length) return item;
    let dx = 0;
    let dy = 0;
    if (box.x < SAFE.x) dx += SAFE.x - box.x;
    if (box.x + box.w > SAFE.x + SAFE.w) dx -= box.x + box.w - (SAFE.x + SAFE.w);
    if (box.y < SAFE.y) dy += SAFE.y - box.y;
    if (box.y + box.h > SAFE.y + SAFE.h) dy -= box.y + box.h - (SAFE.y + SAFE.h);
    if (issues.some((issue) => issue.kind === 'reserved')) dy += TOOLBAR.y + TOOLBAR.h + 14 - (box.y + dy);
    const collision = issues.find((issue) => issue.kind === 'collision' && issue.withItemId);
    if (collision?.withItemId) {
      const other = compiled.get(collision.withItemId);
      if (other) {
        const down = other.y + other.h + 18 - (box.y + dy);
        dy += down;
        if (box.y + dy + box.h > SAFE.y + SAFE.h) dy = other.y - 18 - box.h - box.y;
      }
    }
    if (dx === 0 && dy === 0) return item;
    return { ...item, spec: translateSpec(item.spec, dx, dy), revision: item.revision + 1 };
  });
  return { ...scene, items };
}

export function countAvoidableConnectorCrossings(scene: SceneState): number {
  const compiled = new Map(compileScene(scene.items).map((item) => [item.id, item]));
  const segments = scene.items.flatMap((item) => {
    if (item.spec.kind === 'line' && item.spec.arrow === 'end') return [{ from: item.spec.from, to: item.spec.to }];
    if (item.spec.kind === 'connector' && Array.isArray(item.spec.from) && Array.isArray(item.spec.to)) return [{ from: item.spec.from, to: item.spec.to }];
    if (item.spec.kind === 'connector') {
      const path = compiled.get(item.id)?.nodes.find((node) => node.type === 'path');
      if (path?.type === 'path') {
        const coords = path.d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
        if (coords.length >= 4) return [{ from: [coords[0], coords[1]] as Vec, to: [coords[coords.length - 2], coords[coords.length - 1]] as Vec }];
      }
    }
    return [];
  });
  let crossings = 0;
  for (let left = 0; left < segments.length; left += 1) for (let right = left + 1; right < segments.length; right += 1) {
    if (!sharesEndpoint(segments[left], segments[right]) && segmentsCross(segments[left].from, segments[left].to, segments[right].from, segments[right].to)) crossings += 1;
  }
  return crossings;
}

function translateSpec(spec: ShapeSpec, dx: number, dy: number): ShapeSpec {
  const move = ([x, y]: Vec): Vec => [x + dx, y + dy];
  switch (spec.kind) {
    case 'line': return { ...spec, from: move(spec.from), to: move(spec.to) };
    case 'polygon': return { ...spec, points: spec.points.map(move) };
    case 'circle': return { ...spec, center: move(spec.center) };
    case 'ellipse': return { ...spec, center: move(spec.center) };
    case 'point': case 'text': case 'equation': case 'axes': case 'bars': case 'numberline': case 'box': case 'table': return { ...spec, at: move(spec.at) };
    case 'angle': return { ...spec, vertex: move(spec.vertex), from: move(spec.from), to: move(spec.to) };
    case 'connector': return { ...spec, ...(Array.isArray(spec.from) ? { from: move(spec.from) } : {}), ...(Array.isArray(spec.to) ? { to: move(spec.to) } : {}) };
    case 'path': return { ...spec, points: spec.points.map(move) };
    case 'label': case 'plot': return spec;
  }
}

function contains(outer: BBox, inner: BBox): boolean { return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h; }
function intersects(a: BBox, b: BBox): boolean { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
function overlapRatio(a: BBox, b: BBox): number {
  const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (width * height) / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
}
function dependentPair(left: SceneItem, right: SceneItem): boolean {
  if (left.spec.kind === 'label' && left.spec.target === right.id) return true;
  if (right.spec.kind === 'label' && right.spec.target === left.id) return true;
  if (left.spec.kind === 'plot' && left.spec.axes === right.id) return true;
  if (right.spec.kind === 'plot' && right.spec.axes === left.id) return true;
  return false;
}

function sharesEndpoint(left: { from: Vec; to: Vec }, right: { from: Vec; to: Vec }): boolean {
  return [left.from, left.to].some((a) => [right.from, right.to].some((b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1));
}

function segmentsCross(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const orient = (p: Vec, q: Vec, r: Vec) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const values = [orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)];
  return values[0] * values[1] < 0 && values[2] * values[3] < 0;
}
