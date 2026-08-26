/**
 * Compile curated local educational icons into stroke/fill path nodes.
 * Extracted from compile.ts so the core compiler does not grow further.
 */

import { PALETTE, type Vec } from '../../shared/boardOps';
import type { AssetSpec } from '../../shared/authoredSpecs';
import { BOARD_ASSET_VIEWBOX, getBoardAsset } from '../../shared/boardAssets';
import { measureText, TEXT_SIZES } from './measure';
import type { PathNode, TextNode } from './compile';

const INK = PALETTE.ink;

function wash(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return 'rgba(0,0,0,0.06)';
  const n = parseInt(match[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.14)`;
}

function pathLengthEstimate(d: string): number {
  const coords = d.match(/-?\d+(\.\d+)?/g) ?? [];
  let total = 0;
  let previous: Vec | null = null;
  for (let i = 0; i + 1 < coords.length; i += 2) {
    const point: Vec = [Number(coords[i]), Number(coords[i + 1])];
    if (previous) total += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    previous = point;
  }
  return Math.max(24, total);
}

export function compileAsset(
  spec: AssetSpec,
  color: string,
): Array<PathNode | TextNode> {
  const asset = getBoardAsset(spec.assetId);
  if (!asset) return [];
  const size = spec.size ?? 72;
  const [cx, cy] = spec.at;
  const x = cx - size / 2;
  const y = cy - size / 2;
  const scale = size / BOARD_ASSET_VIEWBOX;
  const nodes: Array<PathNode | TextNode> = asset.paths.map((d) => ({
    type: 'path' as const,
    d,
    color,
    width: 2.2,
    fill: wash(color),
    length: pathLengthEstimate(d) * scale,
    transform: `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${scale.toFixed(3)})`,
    bbox: { x, y, w: size, h: size },
  }));
  if (spec.label) {
    const fontSize = TEXT_SIZES.small;
    const w = measureText(spec.label, fontSize);
    nodes.push({
      type: 'text',
      x: cx,
      y: y + size + fontSize + 4,
      text: spec.label,
      size: fontSize,
      color: INK,
      anchor: 'middle',
      w,
    });
  }
  return nodes;
}
