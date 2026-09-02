const BOARD_W = 1000;
const BOARD_H = 600;
export type Vec = [number, number];

type TransformOperation =
  | { type: 'rotate'; angleDeg: number; center?: Vec }
  | { type: 'reflect'; axis: { from: Vec; to: Vec } }
  | { type: 'translate'; vector: Vec }
  | { type: 'enlarge'; scale: number; center?: Vec };
export interface TransformSpec { kind: 'transform'; target: string; operation: TransformOperation; label?: string }
export interface PanelMark { shape: 'circle' | 'square' | 'triangle' | 'line'; x: number; y: number; size?: number; rotationDeg?: number; fill?: boolean }
export interface PanelGridSpec { kind: 'panelGrid'; at: Vec; w: number; h: number; rows: number; cols: number; panels: Array<{ row: number; col: number; label?: string; marks: PanelMark[] }> }
export type RegionFillSpec =
  | { kind: 'regionFill'; mode: 'venn'; at: Vec; w: number; h: number; operation: 'union' | 'intersection'; labels: [string, string] }
  | { kind: 'regionFill'; mode: 'fraction'; at: Vec; w: number; h: number; numerator: number; denominator: number }
  | { kind: 'regionFill'; mode: 'half_plane'; axes: string; slope: number; intercept: number; side: 'above' | 'below'; inclusive: boolean }
  | { kind: 'regionFill'; mode: 'polygon'; points: Vec[] };
export interface ScatterSpec { kind: 'scatter'; at: Vec; w: number; h: number; xRange: Vec; yRange: Vec; points: Vec[]; xLabel?: string; yLabel?: string }
export interface BoxplotSpec { kind: 'boxplot'; at: Vec; w: number; min: number; q1: number; median: number; q3: number; max: number; label?: string }
export interface HistogramSpec { kind: 'histogram'; at: Vec; w: number; h: number; bins: Array<{ from: number; to: number; frequency: number }>; xLabel?: string; yLabel?: string }
export interface IsometricSolidSpec { kind: 'isometricSolid'; at: Vec; unit: number; voxels: Array<[number, number, number]> }
export interface CubeNetSpec { kind: 'cubeNet'; at: Vec; cell: number; faces: Array<{ id: string; row: number; col: number; label?: string }> }
export interface PlanViewSpec { kind: 'planView'; at: Vec; cell: number; heights: number[][] }
export interface PaperFoldHolePunchSpec { kind: 'paperFoldHolePunch'; at: Vec; w: number; h: number; folds: Array<'left' | 'right' | 'up' | 'down' | 'diagonal'>; holes: Vec[] }
export interface GridPaperSpec { kind: 'gridPaper'; at: Vec; w: number; h: number; spacing: number; style: 'grid' | 'dot'; majorEvery?: number }
export interface ClockSpec { kind: 'clock'; center: Vec; r: number; hour: number; minute: number; second?: number }
export interface ProtractorSpec { kind: 'protractor'; center: Vec; r: number; angleDeg?: number; label?: string }
export type CurriculumSpec = TransformSpec | PanelGridSpec | RegionFillSpec | ScatterSpec | BoxplotSpec | HistogramSpec | IsometricSolidSpec | CubeNetSpec | PlanViewSpec | PaperFoldHolePunchSpec | GridPaperSpec | ClockSpec | ProtractorSpec;

export const CURRICULUM_SPEC_KINDS = [
  'transform', 'panelGrid', 'regionFill', 'scatter', 'boxplot', 'histogram',
  'isometricSolid', 'cubeNet', 'planView', 'paperFoldHolePunch', 'gridPaper', 'clock', 'protractor',
] as const;

export function translateCurriculumSpec(spec: CurriculumSpec, dx: number, dy: number): CurriculumSpec {
  const move = ([x, y]: Vec): Vec => [x + dx, y + dy];
  switch (spec.kind) {
    case 'panelGrid': case 'scatter': case 'boxplot': case 'histogram': case 'isometricSolid': case 'cubeNet': case 'planView': case 'paperFoldHolePunch': case 'gridPaper':
      return { ...spec, at: move(spec.at) };
    case 'regionFill':
      return spec.mode === 'polygon' ? { ...spec, points: spec.points.map(move) }
        : spec.mode === 'half_plane' ? spec : { ...spec, at: move(spec.at) };
    case 'clock': case 'protractor':
      return { ...spec, center: move(spec.center) };
    case 'transform':
      return spec;
  }
}

export function validateCurriculumKind(raw: Record<string, unknown>): CurriculumSpec | null {
  switch (raw.kind) {
    case 'transform': return validateTransform(raw);
    case 'panelGrid': return validatePanelGrid(raw);
    case 'regionFill': return validateRegionFill(raw);
    case 'scatter': return validateScatter(raw);
    case 'boxplot': return validateBoxplot(raw);
    case 'histogram': return validateHistogram(raw);
    case 'isometricSolid': return validateIsometricSolid(raw);
    case 'cubeNet': return validateCubeNet(raw);
    case 'planView': return validatePlanView(raw);
    case 'paperFoldHolePunch': return validatePaperFold(raw);
    case 'gridPaper': return validateGridPaper(raw);
    case 'clock': return validateClock(raw);
    case 'protractor': return validateProtractor(raw);
    default: return null;
  }
}

function validateTransform(raw: Record<string, unknown>): TransformSpec | null {
  const target = id(raw.target); const label = str(raw.label, 40);
  if (!target || !record(raw.operation)) return null;
  const op = raw.operation;
  if (op.type === 'rotate') {
    const angleDeg = num(op.angleDeg); const center = point(op.center);
    return angleDeg === null || Math.abs(angleDeg) > 1080 ? null : { kind: 'transform', target, operation: { type: 'rotate', angleDeg, ...(center ? { center } : {}) }, ...(label ? { label } : {}) };
  }
  if (op.type === 'reflect' && record(op.axis)) {
    const from = point(op.axis.from); const to = point(op.axis.to);
    return !from || !to || distance(from, to) < 1 ? null : { kind: 'transform', target, operation: { type: 'reflect', axis: { from, to } }, ...(label ? { label } : {}) };
  }
  if (op.type === 'translate') {
    const vector = signedPoint(op.vector);
    return vector ? { kind: 'transform', target, operation: { type: 'translate', vector }, ...(label ? { label } : {}) } : null;
  }
  if (op.type === 'enlarge') {
    const scale = num(op.scale); const center = point(op.center);
    return scale === null || scale <= 0 || scale > 10 ? null : { kind: 'transform', target, operation: { type: 'enlarge', scale, ...(center ? { center } : {}) }, ...(label ? { label } : {}) };
  }
  return null;
}

function validatePanelGrid(raw: Record<string, unknown>): PanelGridSpec | null {
  const at = point(raw.at); const w = positive(raw.w); const h = positive(raw.h); const rows = integer(raw.rows, 1, 6); const cols = integer(raw.cols, 1, 6);
  if (!at || w === null || h === null || rows === null || cols === null || !Array.isArray(raw.panels)) return null;
  const panels: PanelGridSpec['panels'] = []; const cells = new Set<string>();
  for (const value of raw.panels.slice(0, rows * cols)) {
    if (!record(value)) return null;
    const row = integer(value.row, 0, rows - 1); const col = integer(value.col, 0, cols - 1);
    if (row === null || col === null || cells.has(`${row}:${col}`) || !Array.isArray(value.marks)) return null;
    const marks = value.marks.slice(0, 16).map(validatePanelMark);
    if (marks.some((mark) => !mark)) return null;
    cells.add(`${row}:${col}`);
    const label = str(value.label, 30);
    panels.push({ row, col, ...(label ? { label } : {}), marks: marks as PanelMark[] });
  }
  return { kind: 'panelGrid', at, w: clamp(w, 120, BOARD_W), h: clamp(h, 90, BOARD_H), rows, cols, panels };
}

function validatePanelMark(value: unknown): PanelMark | null {
  if (!record(value) || !['circle', 'square', 'triangle', 'line'].includes(String(value.shape))) return null;
  const x = unit(value.x); const y = unit(value.y); const size = positive(value.size); const rotationDeg = num(value.rotationDeg);
  if (x === null || y === null) return null;
  return {
    shape: value.shape as PanelMark['shape'], x, y,
    ...(size !== null ? { size: clamp(size, 8, 80) } : {}),
    ...(rotationDeg !== null ? { rotationDeg } : {}),
    ...(value.fill === true ? { fill: true } : {}),
  };
}

function validateRegionFill(raw: Record<string, unknown>): RegionFillSpec | null {
  if (raw.mode === 'venn') {
    const at = point(raw.at); const w = positive(raw.w); const h = positive(raw.h);
    const operation = ['union', 'intersection'].includes(String(raw.operation)) ? raw.operation as 'union' | 'intersection' : null;
    const labels = Array.isArray(raw.labels) && raw.labels.length === 2 ? raw.labels.map((value) => str(value, 24)) : [];
    return at && w !== null && h !== null && operation && labels.every(Boolean)
      ? { kind: 'regionFill', mode: 'venn', at, w: clamp(w, 160, BOARD_W), h: clamp(h, 100, BOARD_H), operation, labels: labels as [string, string] }
      : null;
  }
  if (raw.mode === 'fraction') {
    const at = point(raw.at); const w = positive(raw.w); const h = positive(raw.h); const numerator = integer(raw.numerator, 0, 24); const denominator = integer(raw.denominator, 1, 24);
    return at && w !== null && h !== null && numerator !== null && denominator !== null && numerator <= denominator
      ? { kind: 'regionFill', mode: 'fraction', at, w: clamp(w, 80, BOARD_W), h: clamp(h, 30, BOARD_H), numerator, denominator }
      : null;
  }
  if (raw.mode === 'half_plane') {
    const axes = id(raw.axes); const slope = num(raw.slope); const intercept = num(raw.intercept); const side = raw.side === 'above' || raw.side === 'below' ? raw.side : null;
    return axes && slope !== null && intercept !== null && side && typeof raw.inclusive === 'boolean' ? { kind: 'regionFill', mode: 'half_plane', axes, slope, intercept, side, inclusive: raw.inclusive } : null;
  }
  if (raw.mode === 'polygon') {
    const points = boardPoints(raw.points, 3, 40);
    return points ? { kind: 'regionFill', mode: 'polygon', points } : null;
  }
  return null;
}

function validateScatter(raw: Record<string, unknown>): ScatterSpec | null {
  const at = point(raw.at); const w = positive(raw.w); const h = positive(raw.h); const xRange = numericPair(raw.xRange); const yRange = numericPair(raw.yRange); const points = dataPoints(raw.points, 1, 100);
  if (!at || w === null || h === null || !xRange || !yRange || xRange[1] <= xRange[0] || yRange[1] <= yRange[0] || !points) return null;
  const xLabel = str(raw.xLabel, 30); const yLabel = str(raw.yLabel, 30);
  return { kind: 'scatter', at, w: clamp(w, 160, BOARD_W), h: clamp(h, 100, BOARD_H), xRange, yRange, points, ...(xLabel ? { xLabel } : {}), ...(yLabel ? { yLabel } : {}) };
}

function validateBoxplot(raw: Record<string, unknown>): BoxplotSpec | null {
  const at = point(raw.at); const w = positive(raw.w); const values = [num(raw.min), num(raw.q1), num(raw.median), num(raw.q3), num(raw.max)];
  if (!at || w === null || values.some((value) => value === null)) return null;
  const ordered = values as number[]; if (ordered.some((value, index) => index > 0 && value < ordered[index - 1]) || ordered[4] <= ordered[0]) return null;
  const label = str(raw.label, 40);
  return { kind: 'boxplot', at, w: clamp(w, 160, BOARD_W), min: ordered[0], q1: ordered[1], median: ordered[2], q3: ordered[3], max: ordered[4], ...(label ? { label } : {}) };
}

function validateHistogram(raw: Record<string, unknown>): HistogramSpec | null {
  const at = point(raw.at); const w = positive(raw.w); const h = positive(raw.h);
  if (!at || w === null || h === null || !Array.isArray(raw.bins) || raw.bins.length === 0) return null;
  const bins: HistogramSpec['bins'] = [];
  for (const value of raw.bins.slice(0, 20)) {
    if (!record(value)) return null;
    const from = num(value.from); const to = num(value.to); const frequency = num(value.frequency);
    if (from === null || to === null || frequency === null || to <= from || frequency < 0 || (bins.at(-1) && from < bins.at(-1)!.to)) return null;
    bins.push({ from, to, frequency });
  }
  const xLabel = str(raw.xLabel, 30); const yLabel = str(raw.yLabel, 30);
  return { kind: 'histogram', at, w: clamp(w, 160, BOARD_W), h: clamp(h, 100, BOARD_H), bins, ...(xLabel ? { xLabel } : {}), ...(yLabel ? { yLabel } : {}) };
}

function validateIsometricSolid(raw: Record<string, unknown>): IsometricSolidSpec | null {
  const at = point(raw.at); const unitSize = positive(raw.unit);
  if (!at || unitSize === null || !Array.isArray(raw.voxels)) return null;
  const voxels: Array<[number, number, number]> = []; const seen = new Set<string>();
  for (const value of raw.voxels.slice(0, 32)) {
    if (!Array.isArray(value) || value.length !== 3) return null;
    const voxel = value.map((coordinate) => integer(coordinate, 0, 8));
    if (voxel.some((coordinate) => coordinate === null) || seen.has(voxel.join(':'))) return null;
    seen.add(voxel.join(':')); voxels.push(voxel as [number, number, number]);
  }
  return voxels.length ? { kind: 'isometricSolid', at, unit: clamp(unitSize, 16, 90), voxels } : null;
}

function validateCubeNet(raw: Record<string, unknown>): CubeNetSpec | null {
  const at = point(raw.at); const cell = positive(raw.cell);
  if (!at || cell === null || !Array.isArray(raw.faces) || raw.faces.length !== 6) return null;
  const faces: CubeNetSpec['faces'] = []; const positions = new Set<string>(); const ids = new Set<string>();
  for (const value of raw.faces) {
    if (!record(value)) return null;
    const faceId = id(value.id); const row = integer(value.row, 0, 8); const col = integer(value.col, 0, 8); const label = str(value.label, 12);
    if (!faceId || row === null || col === null || positions.has(`${row}:${col}`) || ids.has(faceId)) return null;
    positions.add(`${row}:${col}`); ids.add(faceId); faces.push({ id: faceId, row, col, ...(label ? { label } : {}) });
  }
  const reached = new Set<string>([`${faces[0].row}:${faces[0].col}`]);
  for (let changed = true; changed;) {
    changed = false;
    for (const face of faces) if (!reached.has(`${face.row}:${face.col}`) && [...reached].some((position) => adjacent(position, face.row, face.col))) {
      reached.add(`${face.row}:${face.col}`); changed = true;
    }
  }
  return reached.size === 6 ? { kind: 'cubeNet', at, cell: clamp(cell, 24, 120), faces } : null;
}

function validatePlanView(raw: Record<string, unknown>): PlanViewSpec | null {
  const at = point(raw.at); const cell = positive(raw.cell);
  if (!at || cell === null || !Array.isArray(raw.heights) || raw.heights.length === 0 || raw.heights.length > 6) return null;
  const cols = Array.isArray(raw.heights[0]) ? raw.heights[0].length : 0;
  if (cols < 1 || cols > 6) return null;
  const heights = raw.heights.map((row) => Array.isArray(row) && row.length === cols ? row.map((value) => integer(value, 0, 9)) : []);
  if (heights.some((row) => row.length !== cols || row.some((value) => value === null))) return null;
  return { kind: 'planView', at, cell: clamp(cell, 24, 100), heights: heights as number[][] };
}

function validatePaperFold(raw: Record<string, unknown>): PaperFoldHolePunchSpec | null {
  const at = point(raw.at); const w = positive(raw.w); const h = positive(raw.h);
  const folds = Array.isArray(raw.folds) ? raw.folds.slice(0, 3).filter((fold): fold is PaperFoldHolePunchSpec['folds'][number] => ['left', 'right', 'up', 'down', 'diagonal'].includes(String(fold))) : [];
  const holes = normalizedPoints(raw.holes, 1, 12);
  return at && w !== null && h !== null && folds.length > 0 && folds.length === (raw.folds as unknown[]).length && holes
    ? { kind: 'paperFoldHolePunch', at, w: clamp(w, 240, BOARD_W), h: clamp(h, 120, BOARD_H), folds, holes }
    : null;
}

function validateGridPaper(raw: Record<string, unknown>): GridPaperSpec | null {
  const at = point(raw.at); const w = positive(raw.w); const h = positive(raw.h); const spacing = positive(raw.spacing); const style = raw.style === 'grid' || raw.style === 'dot' ? raw.style : null; const majorEvery = integer(raw.majorEvery, 2, 10);
  return at && w !== null && h !== null && spacing !== null && style
    ? { kind: 'gridPaper', at, w: clamp(w, 100, BOARD_W), h: clamp(h, 100, BOARD_H), spacing: clamp(spacing, 12, 80), style, ...(majorEvery ? { majorEvery } : {}) }
    : null;
}

function validateClock(raw: Record<string, unknown>): ClockSpec | null {
  const center = point(raw.center); const r = positive(raw.r); const hour = integer(raw.hour, 0, 23); const minute = integer(raw.minute, 0, 59); const second = integer(raw.second, 0, 59);
  return center && r !== null && hour !== null && minute !== null
    ? { kind: 'clock', center, r: clamp(r, 40, 280), hour, minute, ...(second !== null ? { second } : {}) }
    : null;
}

function validateProtractor(raw: Record<string, unknown>): ProtractorSpec | null {
  const center = point(raw.center); const r = positive(raw.r); const angleDeg = num(raw.angleDeg); const label = str(raw.label, 20);
  return center && r !== null && (angleDeg === null || (angleDeg >= 0 && angleDeg <= 180))
    ? { kind: 'protractor', center, r: clamp(r, 80, 400), ...(angleDeg !== null ? { angleDeg } : {}), ...(label ? { label } : {}) }
    : null;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function num(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function positive(value: unknown): number | null { const parsed = num(value); return parsed !== null && parsed > 0 ? parsed : null; }
function integer(value: unknown, min: number, max: number): number | null { return Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : null; }
function unit(value: unknown): number | null { const parsed = num(value); return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : null; }
function point(value: unknown): Vec | null { const pair = numericPair(value); return pair ? [clamp(pair[0], 0, BOARD_W), clamp(pair[1], 0, BOARD_H)] : null; }
function signedPoint(value: unknown): Vec | null { const pair = numericPair(value); return pair ? [clamp(pair[0], -BOARD_W, BOARD_W), clamp(pair[1], -BOARD_H, BOARD_H)] : null; }
function numericPair(value: unknown): Vec | null { if (!Array.isArray(value) || value.length !== 2) return null; const x = num(value[0]); const y = num(value[1]); return x === null || y === null ? null : [x, y]; }
function boardPoints(value: unknown, min: number, max: number): Vec[] | null { if (!Array.isArray(value) || value.length < min || value.length > max) return null; const points = value.map(point); return points.every(Boolean) ? points as Vec[] : null; }
function dataPoints(value: unknown, min: number, max: number): Vec[] | null { if (!Array.isArray(value) || value.length < min || value.length > max) return null; const points = value.map(numericPair); return points.every(Boolean) ? points as Vec[] : null; }
function normalizedPoints(value: unknown, min: number, max: number): Vec[] | null { if (!Array.isArray(value) || value.length < min || value.length > max) return null; const points = value.map((entry) => { const pair = numericPair(entry); return pair && unit(pair[0]) !== null && unit(pair[1]) !== null ? pair : null; }); return points.every(Boolean) ? points as Vec[] : null; }
function str(value: unknown, max: number): string | null { if (typeof value !== 'string') return null; const text = value.trim().slice(0, max); return text || null; }
function id(value: unknown): string | null { const valueString = str(value, 40); return valueString && /^[\w-]+$/.test(valueString) ? valueString : null; }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function distance(a: Vec, b: Vec): number { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function adjacent(position: string, row: number, col: number): boolean { const [r, c] = position.split(':').map(Number); return Math.abs(r - row) + Math.abs(c - col) === 1; }
