/**
 * Director/compiler-tier board vocabulary. The voice model's fast-tier
 * `board_ops` path never accepts these kinds; validateOps({ tier: 'authored' })
 * is the only intake that does.
 */

import { isBoardAssetId } from './boardAssets';
import { validateManipulativeKind } from './manipulativeSpecs';
import type { DraggableSpec, SnapZoneSpec, TappableSpec } from './manipulativeSpecs';

/** Local copies so this module does not import boardOps (cycle: boardOps → here). */
const BOARD_W = 1000;
const BOARD_H = 600;
type Vec = [number, number];

export const AUTHORED_ONLY_KINDS = ['arc', 'curve', 'asset', 'draggable', 'snapZone', 'tappable', 'image'] as const;
export type AuthoredOnlyKind = (typeof AUTHORED_ONLY_KINDS)[number];

export type { DraggableSpec, SnapZoneSpec, TappableSpec } from './manipulativeSpecs';

export interface CenterArcSpec {
  kind: 'arc';
  center: Vec;
  r: number;
  startDeg: number;
  endDeg: number;
}

export interface ThroughArcSpec {
  kind: 'arc';
  from: Vec;
  through: Vec;
  to: Vec;
}

export type ArcSpec = CenterArcSpec | ThroughArcSpec;

export interface CurveSpec {
  kind: 'curve';
  points: Vec[];
  width?: number;
}

export interface AssetSpec {
  kind: 'asset';
  assetId: string;
  at: Vec;
  size?: number;
  label?: string;
}

/** Generated illustration background. assetId is server-issued, never a data-URL. */
export interface ImageCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageSpec {
  kind: 'image';
  assetId: string;
  at: Vec;
  w: number;
  h: number;
  crop?: ImageCrop;
  alt: string;
}

const MAX_CURVE_POINTS = 31;
const MAX_ASSET_LABEL = 40;
const MAX_IMAGE_ALT = 200;
const IMAGE_ASSET_ID = /^img-[a-z0-9]{8,40}$/;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clamp(v: number, lo: number, hi: number): number {
  const clamped = Math.min(hi, Math.max(lo, v));
  return clamped === 0 ? 0 : clamped;
}

function vec(v: unknown): Vec | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const x = num(v[0]);
  const y = num(v[1]);
  if (x === null || y === null) return null;
  return [clamp(x, 0, BOARD_W), clamp(y, 0, BOARD_H)];
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function collinear(a: Vec, b: Vec, c: Vec): boolean {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 0.75;
}

export function isCenterArc(spec: ArcSpec): spec is CenterArcSpec {
  return 'center' in spec && spec.center !== undefined;
}

export function validateArcSpec(raw: Record<string, unknown>): ArcSpec | null {
  const from = vec(raw.from);
  const through = vec(raw.through);
  const to = vec(raw.to);
  if (from && through && to) {
    if (collinear(from, through, to)) return null;
    return { kind: 'arc', from, through, to };
  }
  const center = vec(raw.center);
  const r = num(raw.r);
  const startDeg = num(raw.startDeg);
  const endDeg = num(raw.endDeg);
  if (!center || r === null || r <= 0 || startDeg === null || endDeg === null) return null;
  if (startDeg === endDeg) return null;
  return {
    kind: 'arc',
    center,
    r: clamp(r, 2, 300),
    startDeg,
    endDeg,
  };
}

export function validateCurveSpec(raw: Record<string, unknown>): CurveSpec | null {
  if (!Array.isArray(raw.points)) return null;
  const points: Vec[] = [];
  for (const point of raw.points.slice(0, MAX_CURVE_POINTS)) {
    const parsed = vec(point);
    if (parsed) points.push(parsed);
  }
  if (points.length < 4 || (points.length - 1) % 3 !== 0) return null;
  const width = num(raw.width);
  return {
    kind: 'curve',
    points,
    ...(width ? { width: clamp(width, 1, 12) } : {}),
  };
}

export function validateAssetSpec(raw: Record<string, unknown>): AssetSpec | null {
  const assetId = str(raw.assetId, 40);
  const at = vec(raw.at);
  if (!assetId || !at || !isBoardAssetId(assetId)) return null;
  const size = num(raw.size);
  const label = str(raw.label, MAX_ASSET_LABEL);
  return {
    kind: 'asset',
    assetId,
    at,
    ...(size ? { size: clamp(size, 24, 180) } : {}),
    ...(label ? { label } : {}),
  };
}

export function validateImageSpec(raw: Record<string, unknown>): ImageSpec | null {
  const assetId = str(raw.assetId, 48);
  const at = vec(raw.at);
  const w = num(raw.w);
  const h = num(raw.h);
  const alt = str(raw.alt, MAX_IMAGE_ALT);
  if (!assetId || !at || w === null || h === null || !alt) return null;
  if (!IMAGE_ASSET_ID.test(assetId)) return null;
  const spec: ImageSpec = {
    kind: 'image',
    assetId,
    at,
    w: clamp(w, 80, BOARD_W),
    h: clamp(h, 40, BOARD_H),
    alt,
  };
  if (raw.crop && typeof raw.crop === 'object') {
    const cropRaw = raw.crop as Record<string, unknown>;
    const cx = num(cropRaw.x);
    const cy = num(cropRaw.y);
    const cw = num(cropRaw.w);
    const ch = num(cropRaw.h);
    if (cx !== null && cy !== null && cw !== null && ch !== null && cw > 0 && ch > 0) {
      spec.crop = {
        x: clamp(cx, 0, BOARD_W),
        y: clamp(cy, 0, BOARD_H),
        w: clamp(cw, 8, BOARD_W),
        h: clamp(ch, 8, BOARD_H),
      };
    }
  }
  return spec;
}

export function validateAuthoredKind(
  raw: Record<string, unknown>,
): ArcSpec | CurveSpec | AssetSpec | ImageSpec | DraggableSpec | SnapZoneSpec | TappableSpec | null {
  const manipulative = validateManipulativeKind(raw);
  if (manipulative) return manipulative;
  switch (raw.kind) {
    case 'arc':
      return validateArcSpec(raw);
    case 'curve':
      return validateCurveSpec(raw);
    case 'asset':
      return validateAssetSpec(raw);
    case 'image':
      return validateImageSpec(raw);
    default:
      return null;
  }
}

export function isAuthoredOnlySpec(spec: { kind: string; style?: string }): boolean {
  return (AUTHORED_ONLY_KINDS as readonly string[]).includes(spec.kind)
    || (spec.kind === 'text' && spec.style === 'handwritten');
}

const FAST_TIER_AUTHORED_UPDATE_PROPS = new Set([
  'handle', 'selected', 'tolerance', 'numberlineId', 'shape',
  'assetId', 'alt', 'crop',
]);

/** Fast-tier update props that would introduce authored-only vocabulary. */
export function updatePropsYieldAuthored(props: Record<string, unknown>): boolean {
  if (props.style === 'handwritten') return true;
  if (typeof props.kind === 'string' && (AUTHORED_ONLY_KINDS as readonly string[]).includes(props.kind)) return true;
  return Object.keys(props).some((key) => FAST_TIER_AUTHORED_UPDATE_PROPS.has(key));
}

export function authoredRejectionReason(kind: unknown, raw: Record<string, unknown>): string {
  if (kind === 'arc' && raw.from && raw.through && raw.to) return 'invalid or collinear three-point arc';
  if (kind === 'asset' && typeof raw.assetId === 'string' && !isBoardAssetId(raw.assetId)) {
    return `unknown asset "${raw.assetId}"`;
  }
  if (kind === 'image') {
    if (typeof raw.assetId === 'string' && !IMAGE_ASSET_ID.test(raw.assetId.trim())) {
      return 'image assetId must be a server-issued img-… id, never a URL or data-URL';
    }
    if (typeof raw.alt !== 'string' || !raw.alt.trim()) return 'image requires a non-empty alt description';
    return 'invalid image spec';
  }
  return `invalid or unsupported spec for kind "${String(kind)}"`;
}
