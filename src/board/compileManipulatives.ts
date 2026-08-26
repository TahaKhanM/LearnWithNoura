/**
 * Compile interactive manipulatives into render nodes and hit-target metadata.
 */

import { PALETTE, type Vec } from '../../shared/boardOps';
import type { DraggableSpec, SnapZoneSpec, TappableSpec } from '../../shared/manipulativeSpecs';
import { MIN_MANIPULATIVE_HIT_PX } from '../../shared/manipulativeSpecs';
import { measureText, TEXT_SIZES } from './measure';
import type { PathNode, TextNode } from './compile';

const INK_SOFT = '#5C574F';

function circlePath(cx: number, cy: number, r: number): { d: string; length: number } {
  const d = `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
  return { d, length: 2 * Math.PI * r };
}

function wash(hex: string, alpha = 0.14): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return `rgba(0,0,0,${alpha})`;
  const n = parseInt(match[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export interface ManipulativeHitTarget {
  itemId: string;
  kind: 'draggable' | 'tappable';
  cx: number;
  cy: number;
  r: number;
  label?: string;
}

export function compileDraggable(spec: DraggableSpec, color: string): { nodes: Array<PathNode | TextNode>; hit: ManipulativeHitTarget } {
  const size = Math.max(spec.size ?? MIN_MANIPULATIVE_HIT_PX, MIN_MANIPULATIVE_HIT_PX);
  const r = size / 2;
  const [cx, cy] = spec.at;
  const nodes: Array<PathNode | TextNode> = [];
  if (spec.handle === 'piece') {
    nodes.push({
      type: 'path',
      ...circlePath(cx, cy, r),
      color,
      width: 2.5,
      fill: wash(color, 0.35),
      length: 2 * Math.PI * r,
    });
  } else if (spec.handle === 'token') {
    const w = size * 0.9;
    const h = size * 1.1;
    const x = cx - w / 2;
    const y = cy - h / 2;
    nodes.push({
      type: 'path',
      d: `M ${x + 8} ${y} L ${x + w - 8} ${y} Q ${x + w} ${y} ${x + w} ${y + 8} L ${x + w} ${y + h - 8} Q ${x + w} ${y + h} ${x + w - 8} ${y + h} L ${x + 8} ${y + h} Q ${x} ${y + h} ${x} ${y + h - 8} L ${x} ${y + 8} Q ${x} ${y} ${x + 8} ${y} Z`,
      color,
      width: 2.5,
      fill: wash(color, 0.35),
      length: 2 * (w + h),
      bbox: { x, y, w, h },
    });
  } else {
    nodes.push({
      type: 'path',
      ...circlePath(cx, cy, r),
      color,
      width: 3,
      fill: color,
      length: 2 * Math.PI * r,
    });
  }
  if (spec.label) {
    const fontSize = TEXT_SIZES.small;
    nodes.push({
      type: 'text',
      x: cx,
      y: cy - r - 8,
      text: spec.label,
      size: fontSize,
      color: INK_SOFT,
      anchor: 'middle',
      w: measureText(spec.label, fontSize),
    });
  }
  return { nodes, hit: { itemId: '', kind: 'draggable', cx, cy, r, ...(spec.label ? { label: spec.label } : {}) } };
}

export function compileSnapZone(spec: SnapZoneSpec): Array<PathNode> {
  const color = PALETTE.violet;
  if (spec.shape === 'box') {
    const w = spec.w ?? MIN_MANIPULATIVE_HIT_PX;
    const h = spec.h ?? MIN_MANIPULATIVE_HIT_PX;
    const x = spec.at[0] - w / 2;
    const y = spec.at[1] - h / 2;
    return [{
      type: 'path',
      d: `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`,
      color,
      width: 2,
      dash: true,
      fill: wash(color, 0.08),
      length: 2 * (w + h),
      bbox: { x, y, w, h },
    }];
  }
  if (spec.shape === 'interval') {
    const w = spec.w ?? 80;
    const x = spec.at[0];
    const y = spec.at[1] - 22;
    const h = 44;
    return [{
      type: 'path',
      d: `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`,
      color,
      width: 2,
      dash: true,
      fill: wash(color, 0.1),
      length: 2 * (w + h),
      bbox: { x, y, w, h },
    }];
  }
  const r = spec.tolerance ?? 22;
  return [{
    type: 'path',
    ...circlePath(spec.at[0], spec.at[1], r),
    color,
    width: 2,
    dash: true,
    fill: wash(color, 0.08),
    length: 2 * Math.PI * r,
  }];
}

export function compileTappable(
  spec: TappableSpec,
  color: string,
): { nodes: Array<PathNode | TextNode>; hit: ManipulativeHitTarget } {
  const selected = spec.selected === true;
  const stroke = selected ? PALETTE.green : color;
  const [cx, cy] = spec.at;
  const nodes: Array<PathNode | TextNode> = [];
  let r = MIN_MANIPULATIVE_HIT_PX / 2;
  if (spec.shape === 'circle') {
    r = Math.max(spec.r ?? r, MIN_MANIPULATIVE_HIT_PX / 2);
    nodes.push({
      type: 'path',
      ...circlePath(cx, cy, r),
      color: stroke,
      width: selected ? 3.5 : 2.5,
      fill: selected ? wash(PALETTE.green, 0.25) : wash(color, 0.12),
      length: 2 * Math.PI * r,
    });
  } else {
    const w = spec.w ?? MIN_MANIPULATIVE_HIT_PX;
    const h = spec.h ?? MIN_MANIPULATIVE_HIT_PX;
    r = Math.max(w, h) / 2;
    const x = cx - w / 2;
    const y = cy - h / 2;
    nodes.push({
      type: 'path',
      d: `M ${x + 10} ${y} L ${x + w - 10} ${y} Q ${x + w} ${y} ${x + w} ${y + 10} L ${x + w} ${y + h - 10} Q ${x + w} ${y + h} ${x + w - 10} ${y + h} L ${x + 10} ${y + h} Q ${x} ${y + h} ${x} ${y + h - 10} L ${x} ${y + 10} Q ${x} ${y} ${x + 10} ${y} Z`,
      color: stroke,
      width: selected ? 3.5 : 2.5,
      fill: selected ? wash(PALETTE.green, 0.25) : wash(color, 0.12),
      length: 2 * (w + h),
      bbox: { x, y, w, h },
    });
  }
  if (spec.label) {
    const fontSize = TEXT_SIZES.small;
    nodes.push({
      type: 'text',
      x: cx,
      y: cy + 4,
      text: spec.label,
      size: fontSize,
      color: INK_SOFT,
      anchor: 'middle',
      w: measureText(spec.label, fontSize),
    });
  }
  return { nodes, hit: { itemId: '', kind: 'tappable', cx, cy, r, ...(spec.label ? { label: spec.label } : {}) } };
}

export function snapPointToZone(point: Vec, zone: SnapZoneSpec, numberlineAt?: (value: number) => number): Vec {
  if (zone.shape === 'point') {
    return zone.at;
  }
  if (zone.shape === 'box') {
    const w = zone.w ?? MIN_MANIPULATIVE_HIT_PX;
    const h = zone.h ?? MIN_MANIPULATIVE_HIT_PX;
    return [
      Math.max(zone.at[0] - w / 2, Math.min(zone.at[0] + w / 2, point[0])),
      Math.max(zone.at[1] - h / 2, Math.min(zone.at[1] + h / 2, point[1])),
    ];
  }
  if (zone.from !== undefined && zone.to !== undefined && numberlineAt) {
    const mid = (zone.from + zone.to) / 2;
    return [numberlineAt(mid), zone.at[1]];
  }
  return point;
}
