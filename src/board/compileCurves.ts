/**
 * Compile tutor arcs and cubic Bézier curves into drawable path nodes.
 * Extracted from compile.ts so the core compiler does not grow further.
 */

import type { Vec } from '../../shared/boardOps';
import { isCenterArc, type ArcSpec, type CurveSpec } from '../../shared/authoredSpecs';
import type { BBox, PathNode } from './compile';

function dist(a: Vec, b: Vec): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function circleFromThree(a: Vec, b: Vec, c: Vec): { center: Vec; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-6) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { center: [ux, uy], r: Math.hypot(a[0] - ux, a[1] - uy) };
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function arcBBox(center: Vec, r: number, start: number, end: number): BBox {
  const points: Vec[] = [
    [center[0] + r * Math.cos(start), center[1] + r * Math.sin(start)],
    [center[0] + r * Math.cos(end), center[1] + r * Math.sin(end)],
  ];
  let sweep = end - start;
  while (sweep <= 0) sweep += Math.PI * 2;
  while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
  for (const cardinal of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    const fromStart = (cardinal - start + Math.PI * 2) % (Math.PI * 2);
    if (fromStart <= sweep) {
      points.push([center[0] + r * Math.cos(cardinal), center[1] + r * Math.sin(cardinal)]);
    }
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function cubicPoint(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const mt = 1 - t;
  return [
    mt * mt * mt * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t * t * t * p3[0],
    mt * mt * mt * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t * t * t * p3[1],
  ];
}

function cubicLength(p0: Vec, p1: Vec, p2: Vec, p3: Vec): number {
  let total = 0;
  let previous = p0;
  for (let step = 1; step <= 16; step += 1) {
    const next = cubicPoint(p0, p1, p2, p3, step / 16);
    total += dist(previous, next);
    previous = next;
  }
  return total;
}

function cubicBBox(points: Vec[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 3 < points.length; i += 3) {
    for (let step = 0; step <= 12; step += 1) {
      const [x, y] = cubicPoint(points[i], points[i + 1], points[i + 2], points[i + 3], step / 12);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

export function compileArc(spec: ArcSpec, color: string): PathNode[] {
  let center: Vec;
  let r: number;
  let start: number;
  let end: number;
  if (isCenterArc(spec)) {
    center = spec.center;
    r = spec.r;
    start = degToRad(spec.startDeg);
    end = degToRad(spec.endDeg);
  } else {
    const circle = circleFromThree(spec.from, spec.through, spec.to);
    if (!circle) return [];
    center = circle.center;
    r = circle.r;
    start = Math.atan2(spec.from[1] - center[1], spec.from[0] - center[0]);
    const mid = Math.atan2(spec.through[1] - center[1], spec.through[0] - center[0]);
    end = Math.atan2(spec.to[1] - center[1], spec.to[0] - center[0]);
    let sweep = end - start;
    while (sweep <= -Math.PI) sweep += Math.PI * 2;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    const midSweep = ((mid - start + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    if (midSweep * sweep < 0) {
      sweep = sweep > 0 ? sweep - Math.PI * 2 : sweep + Math.PI * 2;
    }
    end = start + sweep;
  }
  let sweep = end - start;
  while (sweep <= -Math.PI * 2) sweep += Math.PI * 2;
  while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
  const startPt: Vec = [center[0] + r * Math.cos(start), center[1] + r * Math.sin(start)];
  const endPt: Vec = [center[0] + r * Math.cos(end), center[1] + r * Math.sin(end)];
  const large = Math.abs(sweep) > Math.PI ? 1 : 0;
  const sweepFlag = sweep > 0 ? 1 : 0;
  return [{
    type: 'path',
    d: `M ${startPt[0].toFixed(1)} ${startPt[1].toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 ${large} ${sweepFlag} ${endPt[0].toFixed(1)} ${endPt[1].toFixed(1)}`,
    color,
    width: 3,
    length: r * Math.abs(sweep),
    bbox: arcBBox(center, r, start, end),
  }];
}

export function compileCurve(spec: CurveSpec, color: string): PathNode[] {
  const points = spec.points;
  if (points.length < 4) return [];
  let d = `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  let length = 0;
  for (let i = 1; i + 2 < points.length; i += 3) {
    d += ` C ${points[i][0].toFixed(1)} ${points[i][1].toFixed(1)}, ${points[i + 1][0].toFixed(1)} ${points[i + 1][1].toFixed(1)}, ${points[i + 2][0].toFixed(1)} ${points[i + 2][1].toFixed(1)}`;
    length += cubicLength(points[i - 1], points[i], points[i + 1], points[i + 2]);
  }
  return [{
    type: 'path',
    d,
    color,
    width: spec.width ?? 3,
    length,
    bbox: cubicBBox(points),
  }];
}

export function sampleArcSegments(spec: ArcSpec, steps = 18): Array<{ from: Vec; to: Vec }> {
  if (compileArc(spec, '#000').length === 0) return [];
  let center: Vec;
  let r: number;
  let start: number;
  let end: number;
  if (isCenterArc(spec)) {
    center = spec.center;
    r = spec.r;
    start = degToRad(spec.startDeg);
    end = degToRad(spec.endDeg);
  } else {
    const circle = circleFromThree(spec.from, spec.through, spec.to);
    if (!circle) return [];
    center = circle.center;
    r = circle.r;
    start = Math.atan2(spec.from[1] - center[1], spec.from[0] - center[0]);
    end = Math.atan2(spec.to[1] - center[1], spec.to[0] - center[0]);
  }
  const segments: Array<{ from: Vec; to: Vec }> = [];
  let sweep = end - start;
  while (sweep <= -Math.PI) sweep += Math.PI * 2;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  const count = Math.max(6, Math.ceil(Math.abs(sweep) / (Math.PI / steps)));
  for (let i = 0; i < count; i += 1) {
    const a = start + (sweep * i) / count;
    const b = start + (sweep * (i + 1)) / count;
    segments.push({
      from: [center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)],
      to: [center[0] + r * Math.cos(b), center[1] + r * Math.sin(b)],
    });
  }
  return segments;
}

export function sampleCurveSegments(spec: CurveSpec): Array<{ from: Vec; to: Vec }> {
  const segments: Array<{ from: Vec; to: Vec }> = [];
  const points = spec.points;
  for (let i = 0; i + 3 < points.length; i += 3) {
    let previous = points[i];
    for (let step = 1; step <= 10; step += 1) {
      const next = cubicPoint(points[i], points[i + 1], points[i + 2], points[i + 3], step / 10);
      segments.push({ from: previous, to: next });
      previous = next;
    }
  }
  return segments;
}
