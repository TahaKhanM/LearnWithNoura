/**
 * Director/compiler-tier board vocabulary. The voice model's fast-tier
 * `board_ops` path never accepts these kinds; validateOps({ tier: 'authored' })
 * is the only intake that does.
 */

import { isBoardAssetId } from './boardAssets';

/** Local copies so this module does not import boardOps (cycle: boardOps → here). */
const BOARD_W = 1000;
const BOARD_H = 600;
type Vec = [number, number];

export const AUTHORED_ONLY_KINDS = ['arc', 'curve', 'asset'] as const;
export type AuthoredOnlyKind = (typeof AUTHORED_ONLY_KINDS)[number];

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

const MAX_CURVE_POINTS = 31;
const MAX_ASSET_LABEL = 40;

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

export function validateAuthoredKind(raw: Record<string, unknown>): ArcSpec | CurveSpec | AssetSpec | null {
  switch (raw.kind) {
    case 'arc':
      return validateArcSpec(raw);
    case 'curve':
      return validateCurveSpec(raw);
    case 'asset':
      return validateAssetSpec(raw);
    default:
      return null;
  }
}

export function isAuthoredOnlySpec(spec: { kind: string; style?: string }): boolean {
  return (AUTHORED_ONLY_KINDS as readonly string[]).includes(spec.kind)
    || (spec.kind === 'text' && spec.style === 'handwritten');
}

/** Fast-tier update props that would introduce authored-only vocabulary. */
export function updatePropsYieldAuthored(props: Record<string, unknown>): boolean {
  if (props.style === 'handwritten') return true;
  return typeof props.kind === 'string' && (AUTHORED_ONLY_KINDS as readonly string[]).includes(props.kind);
}

export function authoredRejectionReason(kind: unknown, raw: Record<string, unknown>): string {
  if (kind === 'arc' && raw.from && raw.through && raw.to) return 'invalid or collinear three-point arc';
  if (kind === 'asset' && typeof raw.assetId === 'string' && !isBoardAssetId(raw.assetId)) {
    return `unknown asset "${raw.assetId}"`;
  }
  return `invalid or unsupported spec for kind "${String(kind)}"`;
}
