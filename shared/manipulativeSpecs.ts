/**
 * Director/compiler-tier interactive manipulatives. The voice model's fast-tier
 * `board_ops` path never accepts these kinds.
 */

const BOARD_W = 1000;
const BOARD_H = 600;
type Vec = [number, number];

export const MANIPULATIVE_KINDS = ['draggable', 'snapZone', 'tappable'] as const;
export type ManipulativeKind = (typeof MANIPULATIVE_KINDS)[number];

/** Minimum logical hit target (mapped through the camera). */
export const MIN_MANIPULATIVE_HIT_PX = 44;

export interface DraggableSpec {
  kind: 'draggable';
  at: Vec;
  handle: 'point' | 'token' | 'piece';
  label?: string;
  size?: number;
}

export interface SnapZoneSpec {
  kind: 'snapZone';
  shape: 'box' | 'interval' | 'point';
  at: Vec;
  w?: number;
  h?: number;
  numberlineId?: string;
  from?: number;
  to?: number;
  tolerance?: number;
}

export interface TappableSpec {
  kind: 'tappable';
  at: Vec;
  shape: 'circle' | 'box';
  r?: number;
  w?: number;
  h?: number;
  label?: string;
  selected?: boolean;
}

export type ManipulativeSpec = DraggableSpec | SnapZoneSpec | TappableSpec;

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

function id(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const cleaned = v.trim().slice(0, 40);
  return /^[\w-]+$/.test(cleaned) ? cleaned : null;
}

export function validateDraggableSpec(raw: Record<string, unknown>): DraggableSpec | null {
  const at = vec(raw.at);
  const handle = raw.handle === 'token' || raw.handle === 'piece' ? raw.handle : raw.handle === 'point' ? 'point' : null;
  if (!at || !handle) return null;
  const label = str(raw.label, 40);
  const size = num(raw.size);
  return {
    kind: 'draggable',
    at,
    handle,
    ...(label ? { label } : {}),
    ...(size ? { size: clamp(size, MIN_MANIPULATIVE_HIT_PX, 120) } : {}),
  };
}

export function validateSnapZoneSpec(raw: Record<string, unknown>): SnapZoneSpec | null {
  const shape = raw.shape === 'box' || raw.shape === 'interval' || raw.shape === 'point' ? raw.shape : null;
  const at = vec(raw.at);
  if (!shape || !at) return null;
  const w = num(raw.w);
  const h = num(raw.h);
  const from = num(raw.from);
  const to = num(raw.to);
  const tolerance = num(raw.tolerance);
  const numberlineId = id(raw.numberlineId) ?? undefined;
  if (shape === 'interval' && (from === null || to === null || from >= to)) return null;
  if (shape === 'box' && (w === null || h === null || w < MIN_MANIPULATIVE_HIT_PX || h < MIN_MANIPULATIVE_HIT_PX)) return null;
  return {
    kind: 'snapZone',
    shape,
    at,
    ...(w ? { w: clamp(w, MIN_MANIPULATIVE_HIT_PX, BOARD_W) } : {}),
    ...(h ? { h: clamp(h, MIN_MANIPULATIVE_HIT_PX, BOARD_H) } : {}),
    ...(numberlineId ? { numberlineId } : {}),
    ...(from !== null ? { from } : {}),
    ...(to !== null ? { to } : {}),
    ...(tolerance ? { tolerance: clamp(tolerance, 4, 120) } : {}),
  };
}

export function validateTappableSpec(raw: Record<string, unknown>): TappableSpec | null {
  const at = vec(raw.at);
  const shape = raw.shape === 'circle' || raw.shape === 'box' ? raw.shape : null;
  if (!at || !shape) return null;
  const r = num(raw.r);
  const w = num(raw.w);
  const h = num(raw.h);
  const label = str(raw.label, 60);
  if (shape === 'circle' && r !== null && r * 2 < MIN_MANIPULATIVE_HIT_PX) return null;
  if (shape === 'box' && (w === null || h === null || w < MIN_MANIPULATIVE_HIT_PX || h < MIN_MANIPULATIVE_HIT_PX)) {
    return null;
  }
  return {
    kind: 'tappable',
    at,
    shape,
    ...(r ? { r: clamp(r, MIN_MANIPULATIVE_HIT_PX / 2, 80) } : {}),
    ...(w ? { w: clamp(w, MIN_MANIPULATIVE_HIT_PX, 240) } : {}),
    ...(h ? { h: clamp(h, MIN_MANIPULATIVE_HIT_PX, 180) } : {}),
    ...(label ? { label } : {}),
    ...(raw.selected === true ? { selected: true } : {}),
  };
}

export function validateManipulativeKind(raw: Record<string, unknown>): ManipulativeSpec | null {
  switch (raw.kind) {
    case 'draggable':
      return validateDraggableSpec(raw);
    case 'snapZone':
      return validateSnapZoneSpec(raw);
    case 'tappable':
      return validateTappableSpec(raw);
    default:
      return null;
  }
}

export function isManipulativeSpec(spec: { kind: string }): spec is ManipulativeSpec {
  return (MANIPULATIVE_KINDS as readonly string[]).includes(spec.kind);
}

export function isManipulativeOnlyKind(kind: unknown): boolean {
  return typeof kind === 'string' && (MANIPULATIVE_KINDS as readonly string[]).includes(kind);
}

/** Learner draft updates may only move/select manipulatives. */
export function manipulativeLearnerProps(props: Record<string, unknown>): boolean {
  const keys = Object.keys(props);
  if (keys.length === 0) return false;
  return keys.every((key) => key === 'at' || key === 'selected');
}

export function manipulativeRejectionReason(kind: unknown, raw: Record<string, unknown>): string {
  if (kind === 'draggable' && !raw.handle) return 'draggable requires handle "point", "token", or "piece"';
  if (kind === 'snapZone' && raw.shape === 'interval' && raw.from === undefined) return 'interval snapZone requires from and to';
  if (kind === 'tappable' && raw.shape === 'circle') return 'tappable circle below 44px minimum hit target';
  return `invalid or unsupported manipulative spec for kind "${String(kind)}"`;
}

/** Apply learner draft position/selection updates onto an existing manipulative spec. */
export function applyManipulativeProps(
  spec: ManipulativeSpec,
  props: Record<string, unknown>,
): ManipulativeSpec {
  if (!manipulativeLearnerProps(props)) return spec;
  if (spec.kind === 'tappable' && typeof props.selected === 'boolean') {
    return { ...spec, selected: props.selected };
  }
  if (spec.kind === 'draggable' && Array.isArray(props.at) && props.at.length >= 2) {
    const x = typeof props.at[0] === 'number' ? props.at[0] : spec.at[0];
    const y = typeof props.at[1] === 'number' ? props.at[1] : spec.at[1];
    return { ...spec, at: [x, y] as Vec };
  }
  return spec;
}
