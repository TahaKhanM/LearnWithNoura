/**
 * The semantic board language. The tutor model emits these operations; the
 * server validates them; the client compiles them into exact geometry. The
 * model supplies intent and rough placement — code owns precision, so an
 * angle arc, an axis, or a plotted curve is always mathematically right.
 *
 * This file is shared verbatim between server and client so there is a
 * single definition of what may reach the board.
 */

import {
  AUTHORED_ONLY_KINDS,
  authoredRejectionReason,
  isAuthoredOnlySpec,
  updatePropsYieldAuthored,
  validateAuthoredKind,
  type ArcSpec,
  type AssetSpec,
  type CurveSpec,
  type DraggableSpec,
  type ImageSpec,
  type SnapZoneSpec,
  type TappableSpec,
} from './authoredSpecs.js';

export type { ArcSpec, AssetSpec, CurveSpec, DraggableSpec, ImageSpec, SnapZoneSpec, TappableSpec } from './authoredSpecs.js';
export { AUTHORED_ONLY_KINDS } from './authoredSpecs.js';
export { MIN_MANIPULATIVE_HIT_PX } from './manipulativeSpecs.js';

export const BOARD_W = 1000;
export const BOARD_H = 600;

export type Vec = [number, number];

/** Marker palette. Free-form colors are coerced to the nearest of these. */
export const PALETTE = {
  blue: '#2C5BE0',
  red: '#E14B3C',
  green: '#14A07A',
  amber: '#F0A227',
  ink: '#26231F',
  violet: '#7A4DD8',
} as const;

export type TextSize = 'small' | 'normal' | 'big';

export interface LineSpec {
  kind: 'line';
  from: Vec;
  to: Vec;
  arrow?: 'none' | 'end' | 'both';
  dash?: boolean;
  width?: number;
}

export interface PolygonSpec {
  kind: 'polygon';
  points: Vec[];
  closed?: boolean;
  fill?: boolean;
}

export interface CircleSpec {
  kind: 'circle';
  center: Vec;
  r: number;
  fill?: boolean;
}

export interface EllipseSpec {
  kind: 'ellipse';
  center: Vec;
  rx: number;
  ry: number;
  fill?: boolean;
}

export interface PointSpec {
  kind: 'point';
  at: Vec;
  label?: string;
}

/**
 * An angle mark at `vertex`, between the rays toward `from` and `to`.
 * The renderer draws the exact arc (or a square for right angles) and
 * places the label on the bisector.
 */
export interface AngleSpec {
  kind: 'angle';
  vertex: Vec;
  from: Vec;
  to: Vec;
  label?: string;
  radius?: number;
}

export interface TextSpec {
  kind: 'text';
  at: Vec;
  text: string;
  size?: TextSize;
  align?: 'start' | 'middle' | 'end';
  /** Director/compiler-only margin-note style. Fast-tier board_ops reject it. */
  style?: 'handwritten';
}

/** LaTeX rendered deterministically with KaTeX, never hand-drawn glyphs. */
export interface EquationSpec {
  kind: 'equation';
  at: Vec;
  latex: string;
  size?: TextSize;
}

/** Text anchored to another object; the renderer finds a clear spot. */
export interface LabelSpec {
  kind: 'label';
  target: string;
  side?: 'above' | 'below' | 'left' | 'right';
  text: string;
}

export interface AxesSpec {
  kind: 'axes';
  /** Top-left corner of the plot region on the board. */
  at: Vec;
  w: number;
  h: number;
  xRange: Vec;
  yRange: Vec;
  xLabel?: string;
  yLabel?: string;
  ticks?: boolean;
}

/** A curve inside an axes object: an expression in x, or data points. */
export interface PlotSpec {
  kind: 'plot';
  axes: string;
  expr?: string;
  points?: Vec[];
  label?: string;
}

export interface BarsSpec {
  kind: 'bars';
  at: Vec;
  w: number;
  h: number;
  items: { label: string; value: number }[];
  yLabel?: string;
}

export interface NumberlineSpec {
  kind: 'numberline';
  at: Vec;
  w: number;
  min: number;
  max: number;
  step?: number;
  marks?: { value: number; label?: string; color?: string }[];
}

/** A rounded box with centred, wrapped text: process and concept nodes. */
export interface BoxSpec {
  kind: 'box';
  at: Vec;
  w?: number;
  h?: number;
  text: string;
}

/** An arrow between two objects (by id) or points, routed edge-to-edge. */
export interface ConnectorSpec {
  kind: 'connector';
  from: string | Vec;
  to: string | Vec;
  label?: string;
  dash?: boolean;
}

export interface TableSpec {
  kind: 'table';
  at: Vec;
  rows: string[][];
  headerRow?: boolean;
}

/** A learner freehand stroke. Never produced by the model. */
export interface PathSpec {
  kind: 'path';
  points: Vec[];
  width?: number;
}

export type ShapeSpec =
  | LineSpec
  | PolygonSpec
  | CircleSpec
  | EllipseSpec
  | PointSpec
  | AngleSpec
  | TextSpec
  | EquationSpec
  | LabelSpec
  | AxesSpec
  | PlotSpec
  | BarsSpec
  | NumberlineSpec
  | BoxSpec
  | ConnectorSpec
  | TableSpec
  | PathSpec
  | ArcSpec
  | CurveSpec
  | AssetSpec
  | ImageSpec
  | DraggableSpec
  | SnapZoneSpec
  | TappableSpec;

export type SpecKind = ShapeSpec['kind'];

export interface AddOp {
  op: 'add';
  id: string;
  color?: string;
  spec: ShapeSpec;
  /** Region membership for current-board rasters. Not accepted from the voice model. */
  semanticGroupId?: string;
}

export interface UpdateOp {
  op: 'update';
  id: string;
  /** Validated against the same rules as the original spec's fields. */
  props: Record<string, unknown>;
}

export interface HighlightOp {
  op: 'highlight';
  id: string;
}

export interface EraseOp {
  op: 'erase';
  id: string;
}

export interface ClearOp {
  op: 'clear';
}

export type BoardOp = AddOp | UpdateOp | HighlightOp | EraseOp | ClearOp;

// ---------------------------------------------------------------------------
// Validation. Model output is untrusted: clamp, coerce, or reject.
// ---------------------------------------------------------------------------

const MAX_OPS_PER_CALL = 40;
const MAX_TEXT = 120;
const MAX_LATEX = 200;
const MAX_POINTS = 400;
const MAX_TABLE_ROWS = 8;
const MAX_TABLE_COLS = 6;
const MAX_BAR_ITEMS = 10;
const MAX_MARKS = 15;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clamp(v: number, lo: number, hi: number): number {
  const clamped = Math.min(hi, Math.max(lo, v));
  // Normalize -0 so clamped coordinates compare cleanly.
  return clamped === 0 ? 0 : clamped;
}

function vec(v: unknown, pad = 0): Vec | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const x = num(v[0]);
  const y = num(v[1]);
  if (x === null || y === null) return null;
  return [clamp(x, -pad, BOARD_W + pad), clamp(y, -pad, BOARD_H + pad)];
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const NAMED: Record<string, string> = {
  blue: PALETTE.blue,
  red: PALETTE.red,
  green: PALETTE.green,
  amber: PALETTE.amber,
  orange: PALETTE.amber,
  yellow: PALETTE.amber,
  black: PALETTE.ink,
  ink: PALETTE.ink,
  gray: PALETTE.ink,
  grey: PALETTE.ink,
  purple: PALETTE.violet,
  violet: PALETTE.violet,
};

/** Any color the model asks for becomes the nearest marker in the tray. */
export function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const named = NAMED[value.trim().toLowerCase()];
  if (named) return named;
  const rgb = hexToRgb(value);
  if (!rgb) return undefined;
  let best: string | undefined;
  let bestDist = Infinity;
  for (const hex of Object.values(PALETTE)) {
    const p = hexToRgb(hex) as [number, number, number];
    const d = (p[0] - rgb[0]) ** 2 + (p[1] - rgb[1]) ** 2 + (p[2] - rgb[2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = hex;
    }
  }
  return best;
}

interface RawOp {
  op?: unknown;
  id?: unknown;
  kind?: unknown;
  color?: unknown;
  props?: unknown;
  [key: string]: unknown;
}

function id(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const cleaned = v.trim().slice(0, 40);
  return /^[\w-]+$/.test(cleaned) ? cleaned : null;
}

function pointsList(v: unknown, min: number, pad = 0): Vec[] | null {
  if (!Array.isArray(v)) return null;
  const pts: Vec[] = [];
  for (const p of v.slice(0, MAX_POINTS)) {
    const parsed = vec(p, pad);
    if (parsed) pts.push(parsed);
  }
  return pts.length >= min ? pts : null;
}

/**
 * Validates one raw spec-shaped object (flattened: kind + fields at the top
 * level, as the model sends them). Returns null when unusable.
 */
export function validateSpec(raw: RawOp): ShapeSpec | null {
  switch (raw.kind) {
    case 'line': {
      const from = vec(raw.from);
      const to = vec(raw.to);
      if (!from || !to) return null;
      const arrow = raw.arrow === 'end' || raw.arrow === 'both' ? raw.arrow : undefined;
      return {
        kind: 'line',
        from,
        to,
        ...(arrow ? { arrow } : {}),
        ...(raw.dash === true ? { dash: true } : {}),
        ...(num(raw.width) ? { width: clamp(num(raw.width) as number, 1, 12) } : {}),
      };
    }
    case 'polygon': {
      const points = pointsList(raw.points, 3);
      if (!points) return null;
      return {
        kind: 'polygon',
        points,
        ...(raw.closed === false ? { closed: false } : {}),
        ...(raw.fill === true ? { fill: true } : {}),
      };
    }
    case 'circle': {
      const center = vec(raw.center);
      const r = num(raw.r);
      if (!center || r === null || r <= 0) return null;
      return {
        kind: 'circle',
        center,
        r: clamp(r, 2, 300),
        ...(raw.fill === true ? { fill: true } : {}),
      };
    }
    case 'ellipse': {
      const center = vec(raw.center);
      const rx = num(raw.rx);
      const ry = num(raw.ry);
      if (!center || rx === null || ry === null || rx <= 0 || ry <= 0) return null;
      return {
        kind: 'ellipse',
        center,
        rx: clamp(rx, 2, 480),
        ry: clamp(ry, 2, 300),
        ...(raw.fill === true ? { fill: true } : {}),
      };
    }
    case 'point': {
      const at = vec(raw.at);
      if (!at) return null;
      const label = str(raw.label, 40);
      return { kind: 'point', at, ...(label ? { label } : {}) };
    }
    case 'angle': {
      const vertex = vec(raw.vertex);
      const from = vec(raw.from, 200);
      const to = vec(raw.to, 200);
      if (!vertex || !from || !to) return null;
      const label = str(raw.label, 20);
      const radius = num(raw.radius);
      return {
        kind: 'angle',
        vertex,
        from,
        to,
        ...(label ? { label } : {}),
        ...(radius ? { radius: clamp(radius, 12, 90) } : {}),
      };
    }
    case 'text': {
      const at = vec(raw.at);
      const text = str(raw.text, MAX_TEXT);
      if (!at || !text) return null;
      const size =
        raw.size === 'small' || raw.size === 'big' ? raw.size : undefined;
      const align =
        raw.align === 'middle' || raw.align === 'end' ? raw.align : undefined;
      const style = raw.style === 'handwritten' ? 'handwritten' as const : undefined;
      return { kind: 'text', at, text, ...(size ? { size } : {}), ...(align ? { align } : {}), ...(style ? { style } : {}) };
    }
    case 'equation': {
      const at = vec(raw.at);
      const latex = str(raw.latex, MAX_LATEX);
      if (!at || !latex) return null;
      const size = raw.size === 'small' || raw.size === 'big' ? raw.size : undefined;
      return { kind: 'equation', at, latex, ...(size ? { size } : {}) };
    }
    case 'label': {
      const target = id(raw.target);
      const text = str(raw.text, MAX_TEXT);
      if (!target || !text) return null;
      const side =
        raw.side === 'above' || raw.side === 'below' || raw.side === 'left' || raw.side === 'right'
          ? raw.side
          : undefined;
      return { kind: 'label', target, text, ...(side ? { side } : {}) };
    }
    case 'axes': {
      const at = vec(raw.at);
      const w = num(raw.w);
      const h = num(raw.h);
      const xRange = vec(raw.xRange, 1e6);
      const yRange = vec(raw.yRange, 1e6);
      if (!at || w === null || h === null || !xRange || !yRange) return null;
      if (xRange[1] <= xRange[0] || yRange[1] <= yRange[0]) return null;
      const xLabel = str(raw.xLabel, 30);
      const yLabel = str(raw.yLabel, 30);
      return {
        kind: 'axes',
        at,
        w: clamp(w, 120, BOARD_W),
        h: clamp(h, 90, BOARD_H),
        xRange,
        yRange,
        ...(xLabel ? { xLabel } : {}),
        ...(yLabel ? { yLabel } : {}),
        ...(raw.ticks === false ? { ticks: false } : {}),
      };
    }
    case 'plot': {
      const axes = id(raw.axes);
      if (!axes) return null;
      const expr = str(raw.expr, 120);
      const points = Array.isArray(raw.points)
        ? (raw.points
            .slice(0, MAX_POINTS)
            .map((p) => {
              if (!Array.isArray(p) || p.length < 2) return null;
              const x = num(p[0]);
              const y = num(p[1]);
              return x === null || y === null ? null : ([x, y] as Vec);
            })
            .filter(Boolean) as Vec[])
        : null;
      if (!expr && (!points || points.length < 2)) return null;
      const label = str(raw.label, 40);
      return {
        kind: 'plot',
        axes,
        ...(expr ? { expr } : {}),
        ...(points && points.length >= 2 ? { points } : {}),
        ...(label ? { label } : {}),
      };
    }
    case 'bars': {
      const at = vec(raw.at);
      const w = num(raw.w);
      const h = num(raw.h);
      if (!at || w === null || h === null || !Array.isArray(raw.items)) return null;
      const items = raw.items
        .slice(0, MAX_BAR_ITEMS)
        .map((item: unknown) => {
          if (typeof item !== 'object' || item === null) return null;
          const it = item as { label?: unknown; value?: unknown };
          const label = str(it.label, 24);
          const value = num(it.value);
          return label !== null && value !== null ? { label, value } : null;
        })
        .filter(Boolean) as { label: string; value: number }[];
      if (items.length === 0) return null;
      const yLabel = str(raw.yLabel, 30);
      return {
        kind: 'bars',
        at,
        w: clamp(w, 160, BOARD_W),
        h: clamp(h, 100, BOARD_H),
        items,
        ...(yLabel ? { yLabel } : {}),
      };
    }
    case 'numberline': {
      const at = vec(raw.at);
      const w = num(raw.w);
      const min = num(raw.min);
      const max = num(raw.max);
      if (!at || w === null || min === null || max === null || max <= min) return null;
      const step = num(raw.step);
      const marks = Array.isArray(raw.marks)
        ? (raw.marks
            .slice(0, MAX_MARKS)
            .map((m: unknown) => {
              if (typeof m !== 'object' || m === null) return null;
              const mark = m as { value?: unknown; label?: unknown; color?: unknown };
              const value = num(mark.value);
              if (value === null) return null;
              const label = str(mark.label, 20);
              const color = normalizeColor(mark.color);
              return { value, ...(label ? { label } : {}), ...(color ? { color } : {}) };
            })
            .filter(Boolean) as NumberlineSpec['marks'])
        : undefined;
      return {
        kind: 'numberline',
        at,
        w: clamp(w, 160, BOARD_W),
        min,
        max,
        ...(step && step > 0 ? { step } : {}),
        ...(marks && marks.length > 0 ? { marks } : {}),
      };
    }
    case 'box': {
      const at = vec(raw.at);
      const text = str(raw.text, MAX_TEXT);
      if (!at || !text) return null;
      const w = num(raw.w);
      const h = num(raw.h);
      return {
        kind: 'box',
        at,
        text,
        ...(w ? { w: clamp(w, 60, 500) } : {}),
        ...(h ? { h: clamp(h, 36, 300) } : {}),
      };
    }
    case 'connector': {
      const from = id(raw.from) ?? vec(raw.from);
      const to = id(raw.to) ?? vec(raw.to);
      if (from === null || to === null) return null;
      const label = str(raw.label, 40);
      return {
        kind: 'connector',
        from,
        to,
        ...(label ? { label } : {}),
        ...(raw.dash === true ? { dash: true } : {}),
      };
    }
    case 'table': {
      const at = vec(raw.at);
      if (!at || !Array.isArray(raw.rows)) return null;
      const rows = raw.rows
        .slice(0, MAX_TABLE_ROWS)
        .map((row: unknown) =>
          Array.isArray(row)
            ? row.slice(0, MAX_TABLE_COLS).map((cell) => str(cell, 40) ?? '')
            : null,
        )
        .filter((row): row is string[] => row !== null && row.length > 0);
      if (rows.length === 0) return null;
      const cols = Math.max(...rows.map((r) => r.length));
      const padded = rows.map((r) => [...r, ...Array(cols - r.length).fill('')]);
      return {
        kind: 'table',
        at,
        rows: padded,
        ...(raw.headerRow === true ? { headerRow: true } : {}),
      };
    }
    case 'path': {
      const points = pointsList(raw.points, 2);
      if (!points) return null;
      return {
        kind: 'path',
        points,
        ...(num(raw.width) ? { width: clamp(num(raw.width) as number, 1, 12) } : {}),
      };
    }
    default:
      return validateAuthoredKind(raw);
  }
}

export type OpsValidationTier = 'fast' | 'authored';

export interface ValidatedOps {
  ops: BoardOp[];
  rejected: { reason: string; raw: unknown }[];
}

/**
 * Validates a raw `ops` array from the model. Invalid entries are dropped
 * (and reported back to the model as tool output) rather than failing the
 * whole call: a lesson should survive one bad mark.
 */
export function validateOps(rawOps: unknown, options?: { tier?: OpsValidationTier }): ValidatedOps {
  const tier = options?.tier ?? 'fast';
  const out: ValidatedOps = { ops: [], rejected: [] };
  if (!Array.isArray(rawOps)) {
    out.rejected.push({ reason: 'ops must be an array', raw: rawOps });
    return out;
  }
  for (const raw of rawOps.slice(0, MAX_OPS_PER_CALL)) {
    if (typeof raw !== 'object' || raw === null) {
      out.rejected.push({ reason: 'op must be an object', raw });
      continue;
    }
    const op = raw as RawOp;
    switch (op.op) {
      case 'add': {
        const opId = id(op.id);
        if (!opId) {
          out.rejected.push({ reason: 'add requires a short alphanumeric id', raw });
          break;
        }
        const normalizedSpec = typeof (op as unknown as { spec?: unknown }).spec === 'object' && (op as unknown as { spec?: unknown }).spec !== null
          ? { ...((op as unknown as { spec: Record<string, unknown> }).spec), op: 'add', id: op.id, color: op.color }
          : op;
        const spec = validateSpec(normalizedSpec as RawOp);
        if (!spec) {
          const kind = (normalizedSpec as RawOp).kind ?? op.kind;
          out.rejected.push({
            reason: authoredRejectionReason(kind, normalizedSpec as Record<string, unknown>),
            raw,
          });
          break;
        }
        if (spec.kind === 'path') {
          out.rejected.push({ reason: 'path is learner-only', raw });
          break;
        }
        if (tier === 'fast' && isAuthoredOnlySpec(spec)) {
          out.rejected.push({
            reason: `${spec.kind === 'text' ? 'handwritten style' : spec.kind} is director/compiler-only`,
            raw,
          });
          break;
        }
        const color = normalizeColor(op.color);
        out.ops.push({ op: 'add', id: opId, spec, ...(color ? { color } : {}) });
        break;
      }
      case 'update': {
        const opId = id(op.id);
        if (!opId || typeof op.props !== 'object' || op.props === null) {
          out.rejected.push({ reason: 'update requires id and props', raw });
          break;
        }
        const props = op.props as Record<string, unknown>;
        if (tier === 'fast' && updatePropsYieldAuthored(props)) {
          out.rejected.push({
            reason: props.style === 'handwritten'
              ? 'handwritten style is director/compiler-only'
              : typeof props.kind === 'string' && (AUTHORED_ONLY_KINDS as readonly string[]).includes(props.kind)
                ? `${String(props.kind)} is director/compiler-only`
                : 'manipulative or authored update props are director/compiler-only',
            raw,
          });
          break;
        }
        out.ops.push({ op: 'update', id: opId, props });
        break;
      }
      case 'highlight': {
        const opId = id(op.id);
        if (!opId) {
          out.rejected.push({ reason: 'highlight requires id', raw });
          break;
        }
        out.ops.push({ op: 'highlight', id: opId });
        break;
      }
      case 'erase': {
        const opId = id(op.id);
        if (!opId) {
          out.rejected.push({ reason: 'erase requires id', raw });
          break;
        }
        out.ops.push({ op: 'erase', id: opId });
        break;
      }
      case 'clear':
        out.ops.push({ op: 'clear' });
        break;
      default:
        out.rejected.push({ reason: `unknown op "${String(op.op)}"`, raw });
    }
  }
  return out;
}

/**
 * Applies an update's props onto an existing spec by re-validating the
 * merged flat object. An update that would corrupt the spec is ignored.
 * Fast tier (the default) cannot introduce authored-only vocabulary.
 */
export function applyUpdate(
  spec: ShapeSpec,
  props: Record<string, unknown>,
  options?: { tier?: OpsValidationTier },
): ShapeSpec {
  const tier = options?.tier ?? 'fast';
  if (tier === 'fast' && isAuthoredOnlySpec(spec)) return spec;
  const merged = { ...(spec as unknown as Record<string, unknown>), ...props, kind: spec.kind };
  const next = validateSpec(merged as RawOp) ?? spec;
  if (tier === 'fast' && isAuthoredOnlySpec(next) && !isAuthoredOnlySpec(spec)) return spec;
  return next;
}
