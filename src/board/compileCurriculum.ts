import type { CurriculumSpec } from '../../shared/curriculumSpecs';
import type { Vec } from '../../shared/boardOps';
import type { AxesMap, BBox, PathNode, RenderNode, TextNode } from './compile';
import { measureText, TEXT_SIZES } from './measure';

export function compileCurriculumSpec(
  spec: Exclude<CurriculumSpec, { kind: 'transform' }>,
  color: string,
  axes: ReadonlyMap<string, AxesMap>,
): RenderNode[] {
  switch (spec.kind) {
    case 'panelGrid': return panelGrid(spec, color);
    case 'regionFill': return regionFill(spec, color, axes);
    case 'scatter': return scatter(spec, color);
    case 'boxplot': return boxplot(spec, color);
    case 'histogram': return histogram(spec, color);
    case 'isometricSolid': return isometricSolid(spec, color);
    case 'cubeNet': return cubeNet(spec, color);
    case 'planView': return planView(spec, color);
    case 'paperFoldHolePunch': return paperFold(spec, color);
    case 'gridPaper': return gridPaper(spec, color);
    case 'clock': return clock(spec, color);
    case 'protractor': return protractor(spec, color);
  }
}

function panelGrid(spec: Extract<CurriculumSpec, { kind: 'panelGrid' }>, color: string): RenderNode[] {
  const nodes: RenderNode[] = [];
  const cellW = spec.w / spec.cols; const cellH = spec.h / spec.rows;
  nodes.push(rect(spec.at[0], spec.at[1], spec.w, spec.h, color));
  for (let col = 1; col < spec.cols; col += 1) nodes.push(line([spec.at[0] + col * cellW, spec.at[1]], [spec.at[0] + col * cellW, spec.at[1] + spec.h], color, 2));
  for (let row = 1; row < spec.rows; row += 1) nodes.push(line([spec.at[0], spec.at[1] + row * cellH], [spec.at[0] + spec.w, spec.at[1] + row * cellH], color, 2));
  for (const panel of spec.panels) {
    const x = spec.at[0] + panel.col * cellW; const y = spec.at[1] + panel.row * cellH;
    if (panel.label) nodes.push(text([x + 12, y + 28], panel.label, TEXT_SIZES.small, color));
    for (const mark of panel.marks) {
      const center: Vec = [x + mark.x * cellW, y + mark.y * cellH]; const size = mark.size ?? Math.min(cellW, cellH) * 0.14;
      if (mark.shape === 'circle') nodes.push(circle(center, size / 2, color, mark.fill ? wash(color) : undefined));
      else if (mark.shape === 'line') {
        const angle = ((mark.rotationDeg ?? 0) * Math.PI) / 180;
        nodes.push(line([center[0] - Math.cos(angle) * size / 2, center[1] - Math.sin(angle) * size / 2], [center[0] + Math.cos(angle) * size / 2, center[1] + Math.sin(angle) * size / 2], color, 3));
      } else {
        const count = mark.shape === 'triangle' ? 3 : 4;
        const offset = mark.shape === 'square' ? Math.PI / 4 : -Math.PI / 2;
        const rotation = ((mark.rotationDeg ?? 0) * Math.PI) / 180;
        const points = Array.from({ length: count }, (_, index): Vec => [center[0] + Math.cos(offset + rotation + index * Math.PI * 2 / count) * size / 2, center[1] + Math.sin(offset + rotation + index * Math.PI * 2 / count) * size / 2]);
        nodes.push(poly(points, color, true, mark.fill ? wash(color) : undefined));
      }
    }
  }
  return nodes;
}

function regionFill(spec: Extract<CurriculumSpec, { kind: 'regionFill' }>, color: string, axes: ReadonlyMap<string, AxesMap>): RenderNode[] {
  if (spec.mode === 'fraction') {
    const nodes: RenderNode[] = [rect(spec.at[0], spec.at[1], spec.w, spec.h, color)];
    const part = spec.w / spec.denominator;
    for (let index = 0; index < spec.denominator; index += 1) {
      if (index < spec.numerator) nodes.push(rect(spec.at[0] + index * part, spec.at[1], part, spec.h, color, 1.5, wash(color)));
      if (index > 0) nodes.push(line([spec.at[0] + index * part, spec.at[1]], [spec.at[0] + index * part, spec.at[1] + spec.h], color, 1.5));
    }
    return nodes;
  }
  if (spec.mode === 'polygon') return [poly(spec.points, color, true, wash(color))];
  if (spec.mode === 'half_plane') {
    const map = axes.get(spec.axes); if (!map) return [];
    const [x0, x1] = map.spec.xRange; const [y0, y1] = map.spec.yRange;
    const clipped = clipHalfPlane([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], spec.slope, spec.intercept, spec.side);
    const nodes: RenderNode[] = clipped.length >= 3 ? [{ ...poly(clipped.map(([x, y]) => [map.toX(x), map.toY(y)]), color, true, wash(color)), width: 0 }] : [];
    const boundary = boundarySegment(x0, x1, y0, y1, spec.slope, spec.intercept);
    if (boundary) nodes.push(line([map.toX(boundary[0][0]), map.toY(boundary[0][1])], [map.toX(boundary[1][0]), map.toY(boundary[1][1])], color, 3, !spec.inclusive));
    const relation = spec.side === 'above' ? (spec.inclusive ? '≥' : '>') : spec.inclusive ? '≤' : '<';
    const sign = spec.intercept < 0 ? '−' : '+';
    nodes.push(text([map.spec.at[0] + 18, map.spec.at[1] + 32], `y ${relation} ${formatNumber(spec.slope)}x ${sign} ${formatNumber(Math.abs(spec.intercept))}`, TEXT_SIZES.small, color));
    return nodes;
  }
  const [x, y] = spec.at; const r = Math.min(spec.w * 0.27, spec.h * 0.42); const cy = y + spec.h / 2; const left: Vec = [x + spec.w * 0.39, cy]; const right: Vec = [x + spec.w * 0.61, cy];
  const nodes: RenderNode[] = [];
  if (spec.operation === 'union') nodes.push(circle(left, r, color, wash(color)), circle(right, r, color, wash(color)));
  if (spec.operation === 'intersection') {
    const d = right[0] - left[0]; const half = d / 2; const dy = Math.sqrt(Math.max(0, r * r - half * half)); const mid = (left[0] + right[0]) / 2;
    const top: Vec = [mid, cy - dy]; const bottom: Vec = [mid, cy + dy];
    nodes.push({ type: 'path', d: `M ${top[0]} ${top[1]} A ${r} ${r} 0 0 1 ${bottom[0]} ${bottom[1]} A ${r} ${r} 0 0 1 ${top[0]} ${top[1]} Z`, color, width: 2, fill: wash(color), length: Math.PI * r * 1.2, bbox: { x: right[0] - r, y: top[1], w: 2 * r - d, h: dy * 2 } });
  }
  nodes.push(circle(left, r, color), circle(right, r, color));
  nodes.push(text([left[0] - r * 0.55, cy - r - 12], spec.labels[0], TEXT_SIZES.small, color), text([right[0] + r * 0.35, cy - r - 12], spec.labels[1], TEXT_SIZES.small, color));
  return nodes;
}

function scatter(spec: Extract<CurriculumSpec, { kind: 'scatter' }>, color: string): RenderNode[] {
  const nodes = chartAxes(spec.at, spec.w, spec.h, color, spec.xLabel, spec.yLabel);
  const toX = (x: number) => spec.at[0] + ((x - spec.xRange[0]) / (spec.xRange[1] - spec.xRange[0])) * spec.w;
  const toY = (y: number) => spec.at[1] + spec.h - ((y - spec.yRange[0]) / (spec.yRange[1] - spec.yRange[0])) * spec.h;
  for (let index = 0; index <= 2; index += 1) {
    const xValue = spec.xRange[0] + (spec.xRange[1] - spec.xRange[0]) * index / 2;
    const yValue = spec.yRange[0] + (spec.yRange[1] - spec.yRange[0]) * index / 2;
    nodes.push(text([toX(xValue), spec.at[1] + spec.h + 22], formatNumber(xValue), 16, color, 'middle'));
    nodes.push(text([spec.at[0] - 10, toY(yValue) + 5], formatNumber(yValue), 16, color, 'end'));
  }
  for (const [x, y] of spec.points) if (x >= spec.xRange[0] && x <= spec.xRange[1] && y >= spec.yRange[0] && y <= spec.yRange[1]) nodes.push(circle([toX(x), toY(y)], 5, color, color));
  return nodes;
}

function boxplot(spec: Extract<CurriculumSpec, { kind: 'boxplot' }>, color: string): RenderNode[] {
  const [x, y] = spec.at; const map = (value: number) => x + ((value - spec.min) / (spec.max - spec.min)) * spec.w; const top = y - 42; const bottom = y + 42;
  const nodes: RenderNode[] = [line([map(spec.min), y], [map(spec.max), y], color), line([map(spec.min), y - 22], [map(spec.min), y + 22], color), line([map(spec.max), y - 22], [map(spec.max), y + 22], color), rect(map(spec.q1), top, map(spec.q3) - map(spec.q1), bottom - top, color, 3, wash(color)), line([map(spec.median), top], [map(spec.median), bottom], color, 4)];
  [spec.min, spec.q1, spec.median, spec.q3, spec.max].forEach((value) => nodes.push(text([map(value), y + 66], formatNumber(value), 16, color, 'middle')));
  if (spec.label) nodes.push(text([x, y - 66], spec.label, TEXT_SIZES.small, color));
  return nodes;
}

function histogram(spec: Extract<CurriculumSpec, { kind: 'histogram' }>, color: string): RenderNode[] {
  const nodes = chartAxes(spec.at, spec.w, spec.h, color, spec.xLabel, spec.yLabel); const min = spec.bins[0].from; const max = spec.bins.at(-1)!.to; const maxFrequency = Math.max(1, ...spec.bins.map((bin) => bin.frequency));
  for (const bin of spec.bins) {
    const x = spec.at[0] + ((bin.from - min) / (max - min)) * spec.w; const width = ((bin.to - bin.from) / (max - min)) * spec.w; const height = (bin.frequency / maxFrequency) * spec.h;
    nodes.push(rect(x, spec.at[1] + spec.h - height, width, height, color, 2, wash(color)));
    nodes.push(text([x, spec.at[1] + spec.h + 22], formatNumber(bin.from), 16, color, 'middle'));
  }
  nodes.push(text([spec.at[0] + spec.w, spec.at[1] + spec.h + 22], formatNumber(max), 16, color, 'middle'));
  nodes.push(text([spec.at[0] - 10, spec.at[1] + 5], formatNumber(maxFrequency), 16, color, 'end'));
  return nodes;
}

function isometricSolid(spec: Extract<CurriculumSpec, { kind: 'isometricSolid' }>, color: string): RenderNode[] {
  const u = spec.unit; const project = (x: number, y: number, z: number): Vec => [spec.at[0] + (x - y) * u * 0.72, spec.at[1] - (x + y) * u * 0.42 - z * u]; const nodes: RenderNode[] = [];
  const voxels = [...spec.voxels].sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  for (const [x, y, z] of voxels) {
    const p100 = project(x + 1, y, z); const p010 = project(x, y + 1, z); const p110 = project(x + 1, y + 1, z);
    const p001 = project(x, y, z + 1); const p101 = project(x + 1, y, z + 1); const p011 = project(x, y + 1, z + 1); const p111 = project(x + 1, y + 1, z + 1);
    nodes.push(poly([p001, p101, p111, p011], color, true, wash(color)));
    nodes.push(poly([p100, p110, p111, p101], color, true, '#d9e2ff'));
    nodes.push(poly([p010, p011, p111, p110], color, true, '#c8f0e5'));
  }
  return nodes;
}

function cubeNet(spec: Extract<CurriculumSpec, { kind: 'cubeNet' }>, color: string): RenderNode[] {
  const nodes: RenderNode[] = [];
  for (const face of spec.faces) {
    const x = spec.at[0] + face.col * spec.cell; const y = spec.at[1] + face.row * spec.cell;
    nodes.push(rect(x, y, spec.cell, spec.cell, color, 3, wash(color)));
    nodes.push(text([x + spec.cell / 2, y + spec.cell / 2 + TEXT_SIZES.small / 3], face.label ?? face.id, TEXT_SIZES.small, color, 'middle'));
  }
  return nodes;
}

function planView(spec: Extract<CurriculumSpec, { kind: 'planView' }>, color: string): RenderNode[] {
  const nodes: RenderNode[] = [];
  spec.heights.forEach((row, rowIndex) => row.forEach((height, columnIndex) => {
    const x = spec.at[0] + columnIndex * spec.cell; const y = spec.at[1] + rowIndex * spec.cell;
    nodes.push(rect(x, y, spec.cell, spec.cell, color, 2, height > 0 ? wash(color) : undefined));
    if (height > 0) nodes.push(text([x + spec.cell / 2, y + spec.cell / 2 + 7], String(height), TEXT_SIZES.small, color, 'middle'));
  }));
  return nodes;
}

function paperFold(spec: Extract<CurriculumSpec, { kind: 'paperFoldHolePunch' }>, color: string): RenderNode[] {
  const stages = spec.folds.length + 3; const gap = 22; const panelW = (spec.w - gap * (stages - 1)) / stages; const panelH = Math.min(spec.h, panelW * 0.85); const nodes: RenderNode[] = []; const unfolded = unfoldHoles(spec.holes, spec.folds);
  for (let index = 0; index < stages; index += 1) {
    const x = spec.at[0] + index * (panelW + gap); const y = spec.at[1] + (spec.h - panelH) / 2;
    nodes.push(rect(x, y, panelW, panelH, color, 2, '#ffffff'));
    const label = index === 0 ? 'Start' : index <= spec.folds.length ? `Fold ${index}` : index === stages - 2 ? 'Punch' : 'Unfold';
    nodes.push(text([x + panelW / 2, y - 16], label, 16, color, 'middle'));
    if (index > 0 && index <= spec.folds.length) {
      const fold = spec.folds[index - 1];
      if (fold === 'left') nodes.push(rect(x, y, panelW / 2, panelH, color, 0, wash(color)));
      if (fold === 'right') nodes.push(rect(x + panelW / 2, y, panelW / 2, panelH, color, 0, wash(color)));
      if (fold === 'up') nodes.push(rect(x, y, panelW, panelH / 2, color, 0, wash(color)));
      if (fold === 'down') nodes.push(rect(x, y + panelH / 2, panelW, panelH / 2, color, 0, wash(color)));
      const horizontal = fold === 'left' || fold === 'right'; const from: Vec = horizontal ? [x + panelW * 0.3, y + panelH * 0.5] : [x + panelW * 0.5, y + panelH * 0.3]; const to: Vec = horizontal ? [x + panelW * 0.7, y + panelH * 0.5] : [x + panelW * 0.5, y + panelH * 0.7];
      nodes.push(...arrowLine(fold === 'left' || fold === 'up' ? to : from, fold === 'left' || fold === 'up' ? from : to, color));
      if (fold === 'diagonal') nodes.push(line([x, y], [x + panelW, y + panelH], color, 2, true));
    }
    const holes = index === stages - 2 ? spec.holes : index === stages - 1 ? unfolded : [];
    for (const [hx, hy] of holes) nodes.push(circle([x + hx * panelW, y + hy * panelH], Math.max(4, panelW * 0.035), color, '#ffffff'));
  }
  return nodes;
}

function unfoldHoles(holes: Vec[], folds: Array<'left' | 'right' | 'up' | 'down' | 'diagonal'>): Vec[] {
  let points = holes.map((point): Vec => [...point]);
  for (const fold of [...folds].reverse()) {
    const reflected = points.map(([x, y]): Vec => fold === 'left' || fold === 'right' ? [1 - x, y] : fold === 'up' || fold === 'down' ? [x, 1 - y] : [y, x]);
    points = [...points, ...reflected].filter((point, index, all) => all.findIndex((other) => distance(point, other) < 1e-6) === index);
  }
  return points;
}

function gridPaper(spec: Extract<CurriculumSpec, { kind: 'gridPaper' }>, color: string): RenderNode[] {
  const nodes: RenderNode[] = [rect(spec.at[0], spec.at[1], spec.w, spec.h, color, 2)];
  for (let x = 0; x <= spec.w + 0.1; x += spec.spacing) for (let y = 0; y <= spec.h + 0.1; y += spec.spacing) {
    if (spec.style === 'dot') nodes.push(circle([spec.at[0] + x, spec.at[1] + y], 1.8, color, color));
  }
  if (spec.style === 'grid') {
    for (let x = spec.spacing; x < spec.w; x += spec.spacing) nodes.push(line([spec.at[0] + x, spec.at[1]], [spec.at[0] + x, spec.at[1] + spec.h], color, Math.round(x / spec.spacing) % (spec.majorEvery ?? 5) === 0 ? 2 : 0.8));
    for (let y = spec.spacing; y < spec.h; y += spec.spacing) nodes.push(line([spec.at[0], spec.at[1] + y], [spec.at[0] + spec.w, spec.at[1] + y], color, Math.round(y / spec.spacing) % (spec.majorEvery ?? 5) === 0 ? 2 : 0.8));
  }
  return nodes;
}

function clock(spec: Extract<CurriculumSpec, { kind: 'clock' }>, color: string): RenderNode[] {
  const nodes: RenderNode[] = [circle(spec.center, spec.r, color)];
  for (let index = 0; index < 12; index += 1) {
    const angle = index * Math.PI / 6 - Math.PI / 2; const outer: Vec = [spec.center[0] + Math.cos(angle) * spec.r * 0.9, spec.center[1] + Math.sin(angle) * spec.r * 0.9]; const inner: Vec = [spec.center[0] + Math.cos(angle) * spec.r * 0.82, spec.center[1] + Math.sin(angle) * spec.r * 0.82]; nodes.push(line(inner, outer, color, 2));
    const label = endpoint(spec.center, angle, spec.r * 0.7); nodes.push(text([label[0], label[1] + 6], String(index === 0 ? 12 : index), 16, color, 'middle'));
  }
  const minuteAngle = (spec.minute / 60) * Math.PI * 2 - Math.PI / 2; const hourAngle = ((spec.hour % 12 + spec.minute / 60) / 12) * Math.PI * 2 - Math.PI / 2;
  nodes.push(line(spec.center, endpoint(spec.center, minuteAngle, spec.r * 0.8), color, 4), line(spec.center, endpoint(spec.center, hourAngle, spec.r * 0.58), color, 7), circle(spec.center, 6, color, color));
  if (spec.second !== undefined) { const secondAngle = (spec.second / 60) * Math.PI * 2 - Math.PI / 2; nodes.push(line(spec.center, endpoint(spec.center, secondAngle, spec.r * 0.84), '#E14B3C', 2)); }
  return nodes;
}

function protractor(spec: Extract<CurriculumSpec, { kind: 'protractor' }>, color: string): RenderNode[] {
  const [cx, cy] = spec.center; const nodes: RenderNode[] = [{ type: 'path', d: `M ${cx - spec.r} ${cy} A ${spec.r} ${spec.r} 0 0 1 ${cx + spec.r} ${cy}`, color, width: 3, length: Math.PI * spec.r, bbox: { x: cx - spec.r, y: cy - spec.r, w: spec.r * 2, h: spec.r } }, line([cx - spec.r, cy], [cx + spec.r, cy], color, 3)];
  for (let degree = 0; degree <= 180; degree += 10) {
    const angle = -degree * Math.PI / 180; const length = degree % 30 === 0 ? 18 : 10; const outer = endpoint(spec.center, angle, spec.r); const inner = endpoint(spec.center, angle, spec.r - length); nodes.push(line(inner, outer, color, degree % 30 === 0 ? 2.5 : 1.5));
    if (degree % 30 === 0) { const labelAt = endpoint(spec.center, angle, spec.r - 38); nodes.push(text([labelAt[0], labelAt[1] + 5], String(degree), 15, color, 'middle')); }
  }
  if (spec.angleDeg !== undefined) {
    const angle = -spec.angleDeg * Math.PI / 180; const end = endpoint(spec.center, angle, spec.r * 0.78); nodes.push(line(spec.center, end, '#E14B3C', 5));
    if (spec.label) nodes.push(text([cx + 12, cy - 24], spec.label, TEXT_SIZES.small, '#E14B3C'));
  }
  return nodes;
}

function chartAxes(at: Vec, w: number, h: number, color: string, xLabel?: string, yLabel?: string): RenderNode[] {
  const nodes: RenderNode[] = [line([at[0], at[1]], [at[0], at[1] + h], color, 3), line([at[0], at[1] + h], [at[0] + w, at[1] + h], color, 3)];
  if (xLabel) nodes.push(text([at[0] + w, at[1] + h + 30], xLabel, TEXT_SIZES.small, color, 'end'));
  if (yLabel) nodes.push(text([at[0], at[1] - 12], yLabel, TEXT_SIZES.small, color));
  return nodes;
}
function line(from: Vec, to: Vec, color: string, width = 3, dash = false): PathNode { return { type: 'path', d: `M ${fmt(from[0])} ${fmt(from[1])} L ${fmt(to[0])} ${fmt(to[1])}`, color, width, ...(dash ? { dash: true } : {}), length: distance(from, to), bbox: pointsBBox([from, to]) }; }
function arrowLine(from: Vec, to: Vec, color: string): PathNode[] { const angle = Math.atan2(to[1] - from[1], to[0] - from[0]); const size = 11; const left: Vec = [to[0] - Math.cos(angle - 0.5) * size, to[1] - Math.sin(angle - 0.5) * size]; const right: Vec = [to[0] - Math.cos(angle + 0.5) * size, to[1] - Math.sin(angle + 0.5) * size]; return [line(from, to, color, 3, true), poly([left, to, right], color, false)]; }
function poly(points: Vec[], color: string, closed: boolean, fill?: string): PathNode { return { type: 'path', d: `M ${points.map((point) => `${fmt(point[0])} ${fmt(point[1])}`).join(' L ')}${closed ? ' Z' : ''}`, color, width: 2.5, ...(fill ? { fill } : {}), length: pathLength(points, closed), bbox: pointsBBox(points) }; }
function rect(x: number, y: number, w: number, h: number, color: string, width = 2.5, fill?: string): PathNode { return { ...poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], color, true, fill), width }; }
function circle(center: Vec, r: number, color: string, fill?: string): PathNode { return { type: 'path', d: `M ${fmt(center[0] + r)} ${fmt(center[1])} A ${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(center[0] - r)} ${fmt(center[1])} A ${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(center[0] + r)} ${fmt(center[1])}`, color, width: 2.5, ...(fill ? { fill } : {}), length: Math.PI * 2 * r, bbox: { x: center[0] - r, y: center[1] - r, w: r * 2, h: r * 2 } }; }
function text(at: Vec, value: string, size: number, color: string, anchor: TextNode['anchor'] = 'start'): TextNode { return { type: 'text', x: at[0], y: at[1], text: value, size, color, anchor, w: measureText(value, size) }; }
function endpoint(center: Vec, angle: number, length: number): Vec { return [center[0] + Math.cos(angle) * length, center[1] + Math.sin(angle) * length]; }
function pointsBBox(points: Vec[]): BBox { const xs = points.map((point) => point[0]); const ys = points.map((point) => point[1]); return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; }
function pathLength(points: Vec[], closed: boolean): number { const path = closed ? [...points, points[0]] : points; return path.slice(1).reduce((total, point, index) => total + distance(path[index], point), 0); }
function distance(a: Vec, b: Vec): number { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function fmt(value: number): string { return value.toFixed(1); }
function formatNumber(value: number): string { return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100); }
function wash(hex: string): string { const match = /^#([0-9a-f]{6})$/i.exec(hex); if (!match) return 'rgba(44,91,224,0.14)'; const value = parseInt(match[1], 16); return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},0.16)`; }
function boundarySegment(x0: number, x1: number, y0: number, y1: number, slope: number, intercept: number): [Vec, Vec] | null {
  const candidates: Vec[] = [];
  for (const x of [x0, x1]) { const y = slope * x + intercept; if (y >= y0 && y <= y1) candidates.push([x, y]); }
  if (Math.abs(slope) > 1e-9) for (const y of [y0, y1]) { const x = (y - intercept) / slope; if (x >= x0 && x <= x1) candidates.push([x, y]); }
  const unique = candidates.filter((point, index) => candidates.findIndex((other) => distance(point, other) < 1e-7) === index);
  return unique.length >= 2 ? [unique[0], unique[1]] : null;
}

function clipHalfPlane(points: Vec[], slope: number, intercept: number, side: 'above' | 'below'): Vec[] {
  const inside = ([x, y]: Vec) => side === 'above' ? y >= slope * x + intercept : y <= slope * x + intercept; const output: Vec[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]; const previous = points[(index + points.length - 1) % points.length]; const currentInside = inside(current); const previousInside = inside(previous);
    if (currentInside !== previousInside) {
      const dx = current[0] - previous[0]; const dy = current[1] - previous[1]; const denominator = dy - slope * dx; const t = Math.abs(denominator) < 1e-9 ? 0 : (slope * previous[0] + intercept - previous[1]) / denominator; output.push([previous[0] + t * dx, previous[1] + t * dy]);
    }
    if (currentInside) output.push(current);
  }
  return output;
}
