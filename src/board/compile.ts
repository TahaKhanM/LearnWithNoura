/**
 * Compiles semantic scene items into exact drawable geometry. Everything
 * that must be precise — arcs, ticks, arrows, curve sampling, label
 * placement, wrapping, clamping — is computed here, deterministically,
 * rather than trusted from the model.
 */

import { BOARD_W, BOARD_H, PALETTE, type Vec, type ShapeSpec, type AxesSpec } from '../../shared/boardOps';
import { compileExpression } from '../../shared/expr';
import { measureText, wrapText, TEXT_SIZES } from './measure';
import type { SceneItem } from './scene';

export interface PathNode {
  type: 'path';
  d: string;
  color: string;
  width: number;
  dash?: boolean;
  fill?: string;
  /** Total stroke length, for draw-on animation and pen tracking. */
  length: number;
  /**
   * Explicit bounds for paths whose data cannot be bounded by reading its
   * coordinates (arc commands carry radii and flags, not points).
   */
  bbox?: BBox;
}

export interface TextNode {
  type: 'text';
  x: number;
  y: number;
  text: string;
  size: number;
  color: string;
  anchor: 'start' | 'middle' | 'end';
  /** Estimated width, so animation can reveal left to right. */
  w: number;
}

export interface KatexNode {
  type: 'katex';
  x: number;
  y: number;
  latex: string;
  fontSize: number;
  color: string;
  w: number;
  h: number;
}

export type RenderNode = PathNode | TextNode | KatexNode;

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CompiledItem {
  id: string;
  owner: 'tutor' | 'learner';
  revision: number;
  nodes: RenderNode[];
  bbox: BBox;
}

const INK = PALETTE.ink;
const INK_SOFT = '#6E6862';

// ---------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------

function dist(a: Vec, b: Vec): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function polylineLength(points: Vec[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

function polylinePath(points: Vec[], close = false): string {
  const [first, ...rest] = points;
  const d = `M ${first[0].toFixed(1)} ${first[1].toFixed(1)} ${rest
    .map((p) => `L ${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(' ')}`;
  return close ? `${d} Z` : d;
}

/** Two short strokes forming an open arrowhead at `tip`, coming from `from`. */
function arrowHead(tip: Vec, from: Vec, size = 11): { d: string; length: number } {
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const left: Vec = [
    tip[0] - size * Math.cos(angle - 0.46),
    tip[1] - size * Math.sin(angle - 0.46),
  ];
  const right: Vec = [
    tip[0] - size * Math.cos(angle + 0.46),
    tip[1] - size * Math.sin(angle + 0.46),
  ];
  return {
    d: `M ${left[0].toFixed(1)} ${left[1].toFixed(1)} L ${tip[0].toFixed(1)} ${tip[1].toFixed(1)} L ${right[0].toFixed(1)} ${right[1].toFixed(1)}`,
    length: size * 2,
  };
}

/** Full-circle path with its exact bounds, since arcs defeat coordinate
 * scanning. Used for circles, dots and markers everywhere. */
function circlePath(cx: number, cy: number, r: number): { d: string; length: number; bbox: BBox } {
  return {
    d: `M ${(cx + r).toFixed(1)} ${cy.toFixed(1)} A ${r} ${r} 0 1 1 ${(cx - r).toFixed(1)} ${cy.toFixed(1)} A ${r} ${r} 0 1 1 ${(cx + r).toFixed(1)} ${cy.toFixed(1)}`,
    length: 2 * Math.PI * r,
    bbox: { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r },
  };
}

/** 1-2-5 tick spacing that lands on human-friendly values. */
function niceStep(roughStep: number): number {
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const residual = roughStep / magnitude;
  if (residual <= 1.2) return magnitude;
  if (residual <= 2.5) return 2 * magnitude;
  if (residual <= 6) return 5 * magnitude;
  return 10 * magnitude;
}

function boxesIntersect(a: BBox, b: BBox, gap = 4): boolean {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  );
}

function bboxOfPoints(points: Vec[]): BBox {
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

function unionBBox(boxes: BBox[]): BBox {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const points: Vec[] = [];
  for (const b of boxes) {
    points.push([b.x, b.y], [b.x + b.w, b.y + b.h]);
  }
  return bboxOfPoints(points);
}

function nodeBBox(node: RenderNode): BBox {
  if (node.type === 'text') {
    const x = node.anchor === 'middle' ? node.x - node.w / 2 : node.anchor === 'end' ? node.x - node.w : node.x;
    return { x, y: node.y - node.size, w: node.w, h: node.size * 1.25 };
  }
  if (node.type === 'katex') {
    return { x: node.x, y: node.y, w: node.w, h: node.h };
  }
  if (node.bbox) return node.bbox;
  // Parse coordinates out of the path data for a conservative bound.
  const coords = node.d.match(/-?\d+(\.\d+)?/g) ?? [];
  const points: Vec[] = [];
  for (let i = 0; i + 1 < coords.length; i += 2) {
    points.push([Number(coords[i]), Number(coords[i + 1])]);
  }
  return points.length > 0 ? bboxOfPoints(points) : { x: 0, y: 0, w: 0, h: 0 };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const LINE_HEIGHT = 1.22;

function textNodes(
  at: Vec,
  text: string,
  size: number,
  color: string,
  anchor: 'start' | 'middle' | 'end',
  maxWidth = 400,
): TextNode[] {
  const lines = wrapText(text, size, maxWidth);
  return lines.map((line, i) => ({
    type: 'text' as const,
    x: at[0],
    y: at[1] + i * size * LINE_HEIGHT,
    text: line,
    size,
    color,
    anchor,
    w: measureText(line, size),
  }));
}

function estimateKatex(latex: string, fontSize: number): { w: number; h: number } {
  const stripped = latex.replace(/\\[a-zA-Z]+/g, 'M').replace(/[{}^_]/g, '');
  const tall = /\\(frac|dfrac|sum|int|prod|sqrt|binom)/.test(latex);
  return {
    w: Math.max(30, stripped.length * fontSize * 0.62),
    h: fontSize * (tall ? 2.6 : 1.5),
  };
}

// ---------------------------------------------------------------------------
// Axes mapping shared between axes and plot items
// ---------------------------------------------------------------------------

export interface AxesMap {
  spec: AxesSpec;
  toX: (x: number) => number;
  toY: (y: number) => number;
}

function axesMap(spec: AxesSpec): AxesMap {
  const [x0, x1] = spec.xRange;
  const [y0, y1] = spec.yRange;
  return {
    spec,
    toX: (x) => spec.at[0] + ((x - x0) / (x1 - x0)) * spec.w,
    toY: (y) => spec.at[1] + spec.h - ((y - y0) / (y1 - y0)) * spec.h,
  };
}

// ---------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------

interface CompileContext {
  bboxes: Map<string, BBox>;
  axes: Map<string, AxesMap>;
  /** All occupied boxes so far, for label collision avoidance. */
  occupied: BBox[];
}

const SIZE = (name: 'small' | 'normal' | 'big' | undefined) => TEXT_SIZES[name ?? 'normal'];

function compileSpec(
  item: SceneItem,
  ctx: CompileContext,
): RenderNode[] {
  const spec = item.spec;
  const color = item.color ?? defaultColor(spec);
  const nodes: RenderNode[] = [];

  switch (spec.kind) {
    case 'line': {
      nodes.push({
        type: 'path',
        d: polylinePath([spec.from, spec.to]),
        color,
        width: spec.width ?? 3,
        ...(spec.dash ? { dash: true } : {}),
        length: dist(spec.from, spec.to),
      });
      if (spec.arrow === 'end' || spec.arrow === 'both') {
        const head = arrowHead(spec.to, spec.from);
        nodes.push({ type: 'path', d: head.d, color, width: spec.width ?? 3, length: head.length });
      }
      if (spec.arrow === 'both') {
        const head = arrowHead(spec.from, spec.to);
        nodes.push({ type: 'path', d: head.d, color, width: spec.width ?? 3, length: head.length });
      }
      break;
    }

    case 'polygon': {
      nodes.push({
        type: 'path',
        d: polylinePath(spec.points, spec.closed !== false),
        color,
        width: 3,
        ...(spec.fill ? { fill: wash(color) } : {}),
        length: polylineLength(
          spec.closed !== false ? [...spec.points, spec.points[0]] : spec.points,
        ),
      });
      break;
    }

    case 'circle': {
      const [cx, cy] = spec.center;
      nodes.push({
        type: 'path',
        ...circlePath(cx, cy, spec.r),
        color,
        width: 3,
        ...(spec.fill ? { fill: wash(color) } : {}),
      });
      break;
    }

    case 'ellipse': {
      const [cx, cy] = spec.center;
      const { rx, ry } = spec;
      const h = ((rx - ry) ** 2) / ((rx + ry) ** 2);
      const perimeter = Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
      nodes.push({
        type: 'path',
        d: `M ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy}`,
        color,
        width: 3,
        ...(spec.fill ? { fill: wash(color) } : {}),
        length: perimeter,
        bbox: { x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry },
      });
      break;
    }

    case 'point': {
      const [x, y] = spec.at;
      nodes.push({
        type: 'path',
        ...circlePath(x, y, 4.5),
        color,
        width: 2,
        fill: color,
      });
      if (spec.label) {
        const size = TEXT_SIZES.small;
        const w = measureText(spec.label, size);
        const placed = placeNear(
          { x: x + 9, y: y - size - 4, w, h: size * 1.25 },
          [x, y],
          ctx.occupied,
        );
        nodes.push({
          type: 'text',
          x: placed.x,
          y: placed.y + size,
          text: spec.label,
          size,
          color,
          anchor: 'start',
          w,
        });
      }
      break;
    }

    case 'angle': {
      const radius = spec.radius ?? 34;
      const a1 = Math.atan2(spec.from[1] - spec.vertex[1], spec.from[0] - spec.vertex[0]);
      const a2 = Math.atan2(spec.to[1] - spec.vertex[1], spec.to[0] - spec.vertex[0]);
      let sweep = a2 - a1;
      while (sweep <= -Math.PI) sweep += 2 * Math.PI;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      const degrees = Math.abs((sweep * 180) / Math.PI);
      const [vx, vy] = spec.vertex;

      if (Math.abs(degrees - 90) < 3.5) {
        // A right angle gets the square mark every geometry teacher draws.
        const s = Math.min(radius * 0.55, 20);
        const p1: Vec = [vx + s * Math.cos(a1), vy + s * Math.sin(a1)];
        const p2: Vec = [vx + s * Math.cos(a2), vy + s * Math.sin(a2)];
        const corner: Vec = [p1[0] + p2[0] - vx, p1[1] + p2[1] - vy];
        nodes.push({
          type: 'path',
          d: polylinePath([p1, corner, p2]),
          color,
          width: 2.5,
          length: dist(p1, corner) + dist(corner, p2),
        });
      } else {
        const start: Vec = [vx + radius * Math.cos(a1), vy + radius * Math.sin(a1)];
        const end: Vec = [vx + radius * Math.cos(a2), vy + radius * Math.sin(a2)];
        const large = Math.abs(sweep) > Math.PI ? 1 : 0;
        const sweepFlag = sweep > 0 ? 1 : 0;
        nodes.push({
          type: 'path',
          d: `M ${start[0].toFixed(1)} ${start[1].toFixed(1)} A ${radius} ${radius} 0 ${large} ${sweepFlag} ${end[0].toFixed(1)} ${end[1].toFixed(1)}`,
          color,
          width: 2.5,
          length: radius * Math.abs(sweep),
          bbox: { x: vx - radius, y: vy - radius, w: 2 * radius, h: 2 * radius },
        });
      }

      if (spec.label) {
        const mid = a1 + sweep / 2;
        const size = TEXT_SIZES.small;
        const labelR = radius + 15;
        nodes.push({
          type: 'text',
          x: vx + labelR * Math.cos(mid) * 1.15,
          y: vy + labelR * Math.sin(mid) + size * 0.35,
          text: spec.label,
          size,
          color,
          anchor: 'middle',
          w: measureText(spec.label, size),
        });
      }
      break;
    }

    case 'text': {
      nodes.push(
        ...textNodes(spec.at, spec.text, SIZE(spec.size), color, spec.align ?? 'start'),
      );
      break;
    }

    case 'equation': {
      const fontSize = spec.size === 'small' ? 16 : spec.size === 'big' ? 26 : 20;
      const { w, h } = estimateKatex(spec.latex, fontSize);
      nodes.push({
        type: 'katex',
        x: spec.at[0],
        y: spec.at[1],
        latex: spec.latex,
        fontSize,
        color,
        w,
        h,
      });
      break;
    }

    case 'label': {
      const target = ctx.bboxes.get(spec.target);
      const size = TEXT_SIZES.small;
      const w = Math.min(measureText(spec.text, size), 260);
      const lines = wrapText(spec.text, size, 260);
      const h = lines.length * size * LINE_HEIGHT;
      const anchorBox = target ?? { x: BOARD_W / 2, y: BOARD_H / 2, w: 0, h: 0 };
      const box = placeAround(anchorBox, w, h, spec.side ?? 'below', ctx.occupied);
      lines.forEach((line, i) => {
        nodes.push({
          type: 'text',
          x: box.x + w / 2,
          y: box.y + size + i * size * LINE_HEIGHT,
          text: line,
          size,
          color,
          anchor: 'middle',
          w: measureText(line, size),
        });
      });
      break;
    }

    case 'axes': {
      const map = axesMap(spec);
      ctx.axes.set(item.id, map);
      const { at, w, h, xRange, yRange } = spec;
      const [x0, x1] = xRange;
      const [y0, y1] = yRange;
      const originY = y0 <= 0 && y1 >= 0 ? map.toY(0) : at[1] + h;
      const originX = x0 <= 0 && x1 >= 0 ? map.toX(0) : at[0];

      // Axis lines with arrowheads.
      nodes.push({
        type: 'path',
        d: polylinePath([[at[0] - 6, originY], [at[0] + w + 10, originY]]),
        color,
        width: 2.5,
        length: w + 16,
      });
      const xHead = arrowHead([at[0] + w + 10, originY], [at[0], originY], 9);
      nodes.push({ type: 'path', d: xHead.d, color, width: 2.5, length: xHead.length });
      nodes.push({
        type: 'path',
        d: polylinePath([[originX, at[1] + h + 6], [originX, at[1] - 10]]),
        color,
        width: 2.5,
        length: h + 16,
      });
      const yHead = arrowHead([originX, at[1] - 10], [originX, at[1] + h], 9);
      nodes.push({ type: 'path', d: yHead.d, color, width: 2.5, length: yHead.length });

      if (spec.ticks !== false) {
        const tickSize = 13;
        const xStep = niceStep((x1 - x0) / 5);
        for (let vx = Math.ceil(x0 / xStep) * xStep; vx <= x1 + 1e-9; vx += xStep) {
          if (Math.abs(vx) < 1e-9 && x0 <= 0 && x1 >= 0) continue;
          const px = map.toX(vx);
          nodes.push({
            type: 'path',
            d: polylinePath([[px, originY - 4], [px, originY + 4]]),
            color: INK_SOFT,
            width: 1.6,
            length: 8,
          });
          const text = formatTick(vx);
          nodes.push({
            type: 'text',
            x: px,
            y: originY + 20,
            text,
            size: tickSize,
            color: INK_SOFT,
            anchor: 'middle',
            w: measureText(text, tickSize),
          });
        }
        const yStep = niceStep((y1 - y0) / 5);
        for (let vy = Math.ceil(y0 / yStep) * yStep; vy <= y1 + 1e-9; vy += yStep) {
          if (Math.abs(vy) < 1e-9 && y0 <= 0 && y1 >= 0) continue;
          const py = map.toY(vy);
          nodes.push({
            type: 'path',
            d: polylinePath([[originX - 4, py], [originX + 4, py]]),
            color: INK_SOFT,
            width: 1.6,
            length: 8,
          });
          const text = formatTick(vy);
          nodes.push({
            type: 'text',
            x: originX - 8,
            y: py + 4,
            text,
            size: tickSize,
            color: INK_SOFT,
            anchor: 'end',
            w: measureText(text, tickSize),
          });
        }
      }

      if (spec.xLabel) {
        const size = TEXT_SIZES.small;
        nodes.push({
          type: 'text',
          x: at[0] + w + 8,
          y: originY + size + 14,
          text: spec.xLabel,
          size,
          color,
          anchor: 'end',
          w: measureText(spec.xLabel, size),
        });
      }
      if (spec.yLabel) {
        const size = TEXT_SIZES.small;
        nodes.push({
          type: 'text',
          x: originX + 10,
          y: at[1] - 14,
          text: spec.yLabel,
          size,
          color,
          anchor: 'start',
          w: measureText(spec.yLabel, size),
        });
      }
      break;
    }

    case 'plot': {
      const map = ctx.axes.get(spec.axes);
      if (!map) break;
      const { xRange, yRange } = map.spec;
      let dataPoints: Vec[] | null = null;

      if (spec.points && spec.points.length >= 2) {
        dataPoints = spec.points;
      } else if (spec.expr) {
        const fn = compileExpression(spec.expr);
        if (fn) {
          dataPoints = [];
          const steps = 160;
          for (let i = 0; i <= steps; i++) {
            const x = xRange[0] + ((xRange[1] - xRange[0]) * i) / steps;
            const y = fn(x);
            dataPoints.push([x, Number.isFinite(y) ? y : NaN]);
          }
        }
      }
      if (!dataPoints) break;

      // Split into visible segments, clipping at the y-range.
      const yPad = (yRange[1] - yRange[0]) * 0.02;
      const segments: Vec[][] = [];
      let current: Vec[] = [];
      for (const [x, y] of dataPoints) {
        const visible =
          Number.isFinite(y) && y >= yRange[0] - yPad && y <= yRange[1] + yPad;
        if (visible) {
          current.push([map.toX(x), map.toY(Math.max(yRange[0], Math.min(yRange[1], y)))]);
        } else if (current.length > 1) {
          segments.push(current);
          current = [];
        } else {
          current = [];
        }
      }
      if (current.length > 1) segments.push(current);

      for (const segment of segments) {
        nodes.push({
          type: 'path',
          d: polylinePath(segment),
          color,
          width: 3,
          length: polylineLength(segment),
        });
      }
      // Discrete datasets get visible dots.
      if (spec.points && spec.points.length <= 24) {
        for (const [x, y] of spec.points) {
          if (y < yRange[0] || y > yRange[1] || x < xRange[0] || x > xRange[1]) continue;
          const px = map.toX(x);
          const py = map.toY(y);
          nodes.push({
            type: 'path',
            ...circlePath(px, py, 3.5),
            color,
            width: 2,
            fill: color,
          });
        }
      }
      if (spec.label && segments.length > 0) {
        const lastSegment = segments[segments.length - 1];
        const tail = lastSegment[lastSegment.length - 1];
        const size = TEXT_SIZES.small;
        const w = measureText(spec.label, size);
        const placed = placeNear(
          { x: tail[0] + 8, y: tail[1] - size, w, h: size * 1.25 },
          tail,
          ctx.occupied,
        );
        nodes.push({
          type: 'text',
          x: placed.x,
          y: placed.y + size,
          text: spec.label,
          size,
          color,
          anchor: 'start',
          w,
        });
      }
      break;
    }

    case 'bars': {
      const { at, w, h, items } = spec;
      const maxValue = Math.max(...items.map((b) => b.value), 0.001);
      const yMax = niceStep(maxValue / 4) * Math.ceil(maxValue / niceStep(maxValue / 4));
      const baseline = at[1] + h;
      const size = TEXT_SIZES.small;

      // Frame: baseline and value axis.
      nodes.push({
        type: 'path',
        d: polylinePath([[at[0] - 4, baseline], [at[0] + w + 6, baseline]]),
        color: INK,
        width: 2.5,
        length: w + 10,
      });
      nodes.push({
        type: 'path',
        d: polylinePath([[at[0], baseline + 4], [at[0], at[1] - 8]]),
        color: INK,
        width: 2.5,
        length: h + 12,
      });

      const slot = w / items.length;
      const barWidth = Math.min(slot * 0.62, 90);
      items.forEach((bar, i) => {
        const barH = Math.max(2, (Math.max(0, bar.value) / yMax) * (h - 18));
        const x = at[0] + slot * i + (slot - barWidth) / 2;
        const y = baseline - barH;
        nodes.push({
          type: 'path',
          d: `M ${x} ${baseline} L ${x} ${y} L ${x + barWidth} ${y} L ${x + barWidth} ${baseline}`,
          color,
          width: 2.5,
          fill: wash(color),
          length: barH * 2 + barWidth,
        });
        const valueText = formatTick(bar.value);
        nodes.push({
          type: 'text',
          x: x + barWidth / 2,
          y: y - 7,
          text: valueText,
          size,
          color: INK,
          anchor: 'middle',
          w: measureText(valueText, size),
        });
        nodes.push({
          type: 'text',
          x: x + barWidth / 2,
          y: baseline + size + 6,
          text: bar.label,
          size,
          color: INK,
          anchor: 'middle',
          w: measureText(bar.label, size),
        });
      });
      if (spec.yLabel) {
        nodes.push({
          type: 'text',
          x: at[0],
          y: at[1] - 14,
          text: spec.yLabel,
          size,
          color: INK_SOFT,
          anchor: 'start',
          w: measureText(spec.yLabel, size),
        });
      }
      break;
    }

    case 'numberline': {
      const { at, w, min, max } = spec;
      const y = at[1];
      const step = spec.step && spec.step > 0 ? spec.step : niceStep((max - min) / 8);
      const toX = (v: number) => at[0] + ((v - min) / (max - min)) * w;
      const size = TEXT_SIZES.small;

      nodes.push({
        type: 'path',
        d: polylinePath([[at[0] - 8, y], [at[0] + w + 8, y]]),
        color,
        width: 2.5,
        length: w + 16,
      });
      const rightHead = arrowHead([at[0] + w + 8, y], [at[0], y], 9);
      nodes.push({ type: 'path', d: rightHead.d, color, width: 2.5, length: rightHead.length });
      const leftHead = arrowHead([at[0] - 8, y], [at[0] + w, y], 9);
      nodes.push({ type: 'path', d: leftHead.d, color, width: 2.5, length: leftHead.length });

      const epsilon = step / 1e6;
      for (let v = Math.ceil(min / step) * step; v <= max + epsilon; v += step) {
        const px = toX(v);
        nodes.push({
          type: 'path',
          d: polylinePath([[px, y - 6], [px, y + 6]]),
          color: INK_SOFT,
          width: 1.8,
          length: 12,
        });
        const text = formatTick(v);
        nodes.push({
          type: 'text',
          x: px,
          y: y + size + 12,
          text,
          size,
          color: INK_SOFT,
          anchor: 'middle',
          w: measureText(text, size),
        });
      }

      for (const mark of spec.marks ?? []) {
        if (mark.value < min || mark.value > max) continue;
        const px = toX(mark.value);
        const markColor = mark.color ?? PALETTE.red;
        nodes.push({
          type: 'path',
          ...circlePath(px, y - 14, 5),
          color: markColor,
          width: 2,
          fill: markColor,
        });
        if (mark.label) {
          nodes.push({
            type: 'text',
            x: px,
            y: y - 26,
            text: mark.label,
            size,
            color: markColor,
            anchor: 'middle',
            w: measureText(mark.label, size),
          });
        }
      }
      break;
    }

    case 'box': {
      const size = TEXT_SIZES.small;
      const innerWidth = (spec.w ?? Math.min(measureText(spec.text, size) + 36, 240)) - 28;
      const lines = wrapText(spec.text, size, innerWidth);
      const w = spec.w ?? Math.min(Math.max(...lines.map((l) => measureText(l, size))) + 36, 240);
      const h = spec.h ?? Math.max(44, lines.length * size * LINE_HEIGHT + 24);
      const [cx, cy] = spec.at;
      const x = cx - w / 2;
      const y = cy - h / 2;
      const r = 10;
      nodes.push({
        type: 'path',
        d: `M ${x + r} ${y} L ${x + w - r} ${y} Q ${x + w} ${y} ${x + w} ${y + r} L ${x + w} ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} L ${x + r} ${y + h} Q ${x} ${y + h} ${x} ${y + h - r} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} Z`,
        color,
        width: 2.5,
        fill: wash(color),
        length: 2 * (w + h),
      });
      const textBlockH = lines.length * size * LINE_HEIGHT;
      lines.forEach((line, i) => {
        nodes.push({
          type: 'text',
          x: cx,
          y: cy - textBlockH / 2 + size * 0.85 + i * size * LINE_HEIGHT,
          text: line,
          size,
          color: INK,
          anchor: 'middle',
          w: measureText(line, size),
        });
      });
      break;
    }

    case 'connector': {
      const from = resolveEndpoint(spec.from, ctx);
      const to = resolveEndpoint(spec.to, ctx);
      if (!from || !to) break;
      const [start, end] = trimToBoxes(from, to, spec.from, spec.to, ctx);
      // A gentle curve reads as hand-drawn; straight lines read as CAD.
      const mx = (start[0] + end[0]) / 2;
      const my = (start[1] + end[1]) / 2;
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const norm = Math.hypot(dx, dy) || 1;
      const bend = Math.min(20, norm * 0.12);
      const cxp = mx - (dy / norm) * bend;
      const cyp = my + (dx / norm) * bend;
      nodes.push({
        type: 'path',
        d: `M ${start[0].toFixed(1)} ${start[1].toFixed(1)} Q ${cxp.toFixed(1)} ${cyp.toFixed(1)} ${end[0].toFixed(1)} ${end[1].toFixed(1)}`,
        color,
        width: 2.5,
        ...(spec.dash ? { dash: true } : {}),
        length: norm * 1.05,
      });
      const head = arrowHead(end, [cxp, cyp]);
      nodes.push({ type: 'path', d: head.d, color, width: 2.5, length: head.length });
      if (spec.label) {
        const size = TEXT_SIZES.small;
        const w = measureText(spec.label, size);
        // The curve bulges toward its control point, so the label sits a
        // little further out along the same perpendicular — clear of the
        // stroke instead of on top of it.
        const lx = cxp - (dy / norm) * (bend * 0.5 + 16);
        const ly = cyp + (dx / norm) * (bend * 0.5 + 16);
        const placed = placeNear(
          { x: lx - w / 2, y: ly - size * 0.6, w, h: size * 1.25 },
          [lx, ly],
          ctx.occupied,
        );
        nodes.push({
          type: 'text',
          x: placed.x + w / 2,
          y: placed.y + size,
          text: spec.label,
          size,
          color,
          anchor: 'middle',
          w,
        });
      }
      break;
    }

    case 'table': {
      const size = TEXT_SIZES.small;
      const rows = spec.rows;
      const cols = rows[0].length;
      const colWidths = Array.from({ length: cols }, (_, c) =>
        Math.min(
          200,
          Math.max(64, ...rows.map((row) => measureText(row[c] ?? '', size) + 24)),
        ),
      );
      const rowH = size * LINE_HEIGHT + 16;
      const totalW = colWidths.reduce((a, b) => a + b, 0);
      const totalH = rows.length * rowH;
      const [x, y] = spec.at;

      nodes.push({
        type: 'path',
        d: `M ${x} ${y} L ${x + totalW} ${y} L ${x + totalW} ${y + totalH} L ${x} ${y + totalH} Z`,
        color,
        width: 2.5,
        length: 2 * (totalW + totalH),
      });
      for (let rIndex = 1; rIndex < rows.length; rIndex++) {
        nodes.push({
          type: 'path',
          d: polylinePath([[x, y + rIndex * rowH], [x + totalW, y + rIndex * rowH]]),
          color,
          width: rIndex === 1 && spec.headerRow ? 2.5 : 1.4,
          length: totalW,
        });
      }
      let cx = x;
      for (let cIndex = 0; cIndex < cols - 1; cIndex++) {
        cx += colWidths[cIndex];
        nodes.push({
          type: 'path',
          d: polylinePath([[cx, y], [cx, y + totalH]]),
          color,
          width: 1.4,
          length: totalH,
        });
      }
      rows.forEach((row, rIndex) => {
        let cellX = x;
        row.forEach((cell, cIndex) => {
          if (cell) {
            nodes.push({
              type: 'text',
              x: cellX + 12,
              y: y + rIndex * rowH + size + 7,
              text: cell,
              size,
              color: INK,
              anchor: 'start',
              w: measureText(cell, size),
            });
          }
          cellX += colWidths[cIndex];
        });
      });
      break;
    }

    case 'path': {
      const points = spec.points;
      nodes.push({
        type: 'path',
        d: smoothPath(points),
        color,
        width: spec.width ?? 4,
        length: polylineLength(points),
      });
      break;
    }
  }

  return nodes;
}

/** Catmull-Rom style smoothing for learner freehand strokes. */
function smoothPath(points: Vec[]): string {
  if (points.length < 3) return polylinePath(points);
  let d = `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i][0] + points[i + 1][0]) / 2;
    const midY = (points[i][1] + points[i + 1][1]) / 2;
    d += ` Q ${points[i][0].toFixed(1)} ${points[i][1].toFixed(1)} ${midX.toFixed(1)} ${midY.toFixed(1)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last[0].toFixed(1)} ${last[1].toFixed(1)}`;
  return d;
}

function defaultColor(spec: ShapeSpec): string {
  switch (spec.kind) {
    case 'plot':
    case 'bars':
    case 'box':
      return PALETTE.blue;
    case 'connector':
      return PALETTE.amber;
    case 'label':
      return INK_SOFT;
    default:
      return INK;
  }
}

/** 14% tint of a marker color for fills, computed without CSS support. */
function wash(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 'rgba(0,0,0,0.06)';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.14)`;
}

function formatTick(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

function resolveEndpoint(end: string | Vec, ctx: CompileContext): Vec | null {
  if (Array.isArray(end)) return end;
  const box = ctx.bboxes.get(end);
  if (!box) return null;
  return [box.x + box.w / 2, box.y + box.h / 2];
}

/** Pulls connector endpoints back to the edges of boxed targets. */
function trimToBoxes(
  from: Vec,
  to: Vec,
  fromRef: string | Vec,
  toRef: string | Vec,
  ctx: CompileContext,
): [Vec, Vec] {
  const trim = (point: Vec, other: Vec, ref: string | Vec): Vec => {
    if (Array.isArray(ref)) return point;
    const box = ctx.bboxes.get(ref);
    if (!box || box.w === 0) return point;
    const dx = other[0] - point[0];
    const dy = other[1] - point[1];
    const scaleX = dx !== 0 ? (box.w / 2 + 8) / Math.abs(dx) : Infinity;
    const scaleY = dy !== 0 ? (box.h / 2 + 8) / Math.abs(dy) : Infinity;
    const t = Math.min(scaleX, scaleY, 0.45);
    return [point[0] + dx * t, point[1] + dy * t];
  };
  return [trim(from, to, fromRef), trim(to, from, toRef)];
}

/**
 * Finds a clear spot for a floating label near its preferred position:
 * try the preference, then nudge through alternatives. Always clamps to
 * the board.
 */
function placeNear(preferred: BBox, anchor: Vec, occupied: BBox[]): BBox {
  const candidates: BBox[] = [
    preferred,
    { ...preferred, y: anchor[1] + 10 },
    { ...preferred, x: anchor[0] - preferred.w - 12, y: preferred.y },
    { ...preferred, y: preferred.y - preferred.h - 14 },
    { ...preferred, x: anchor[0] - preferred.w / 2, y: anchor[1] + 16 },
  ];
  for (const candidate of candidates) {
    const clamped = clampBox(candidate);
    if (!occupied.some((box) => boxesIntersect(clamped, box))) return clamped;
  }
  return clampBox(preferred);
}

function placeAround(
  target: BBox,
  w: number,
  h: number,
  side: 'above' | 'below' | 'left' | 'right',
  occupied: BBox[],
): BBox {
  const gap = 10;
  const make = (s: typeof side, extraGap = 0): BBox => {
    switch (s) {
      case 'above':
        return { x: target.x + target.w / 2 - w / 2, y: target.y - h - gap - extraGap, w, h };
      case 'below':
        return { x: target.x + target.w / 2 - w / 2, y: target.y + target.h + gap + extraGap, w, h };
      case 'left':
        return { x: target.x - w - gap - extraGap, y: target.y + target.h / 2 - h / 2, w, h };
      case 'right':
        return { x: target.x + target.w + gap + extraGap, y: target.y + target.h / 2 - h / 2, w, h };
    }
  };
  const order: (typeof side)[] = [side, 'below', 'above', 'right', 'left'];
  for (const s of order) {
    for (const extra of [0, 18, 36]) {
      const candidate = clampBox(make(s, extra));
      if (!occupied.some((box) => boxesIntersect(candidate, box))) return candidate;
    }
  }
  return clampBox(make(side));
}

function clampBox(box: BBox): BBox {
  return {
    ...box,
    x: Math.max(4, Math.min(BOARD_W - box.w - 4, box.x)),
    y: Math.max(4, Math.min(BOARD_H - box.h - 4, box.y)),
  };
}

/**
 * Compiles the whole scene in order. Labels and connectors see the bboxes
 * of everything before them; text placement avoids everything placed so
 * far (render-inspect-repair, done eagerly at compile time).
 */
export function compileScene(items: SceneItem[]): CompiledItem[] {
  const ctx: CompileContext = { bboxes: new Map(), axes: new Map(), occupied: [] };
  const compiled: CompiledItem[] = [];
  for (const item of items) {
    const nodes = compileSpec(item, ctx);
    const bbox = unionBBox(nodes.map(nodeBBox));
    ctx.bboxes.set(item.id, bbox);
    // Text-bearing nodes claim their space so later labels avoid them.
    for (const node of nodes) {
      if (node.type !== 'path') ctx.occupied.push(nodeBBox(node));
    }
    compiled.push({ id: item.id, owner: item.owner, revision: item.revision, nodes, bbox });
  }
  return compiled;
}
