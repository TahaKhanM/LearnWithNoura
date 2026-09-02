import { z } from 'zod';
import { BOARD_ASSET_IDS } from '../../shared/boardAssets.js';
import { validateOps, type AddOp } from '../../shared/boardOps.js';

export type JsonSchema = Record<string, unknown>;

const PALETTE_NAMES = ['blue', 'red', 'green', 'amber', 'ink', 'violet'] as const;
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] });
const stringSchema = (maxLength: number): JsonSchema => ({ type: 'string', minLength: 1, maxLength });
const enumSchema = (values: readonly string[]): JsonSchema => ({ type: 'string', enum: [...values] });
const numberSchema = (minimum?: number): JsonSchema => ({
  type: 'number',
  ...(minimum === undefined ? {} : { minimum }),
});
const arraySchema = (items: JsonSchema, minItems: number, maxItems: number): JsonSchema => ({
  type: 'array', items, minItems, maxItems,
});
const strictObject = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const vec = arraySchema(numberSchema(), 2, 2);
const nullableString = (maxLength: number): JsonSchema => nullable(stringSchema(maxLength));
const nullableNumber = (minimum?: number): JsonSchema => nullable(numberSchema(minimum));
const nullableBoolean = nullable({ type: 'boolean' });

function spec(kind: string, properties: Record<string, JsonSchema>): JsonSchema {
  return strictObject({ kind: { type: 'string', const: kind }, ...properties });
}

const line = spec('line', {
  from: vec, to: vec, arrow: nullable(enumSchema(['none', 'end', 'both'])),
  dash: nullableBoolean, width: nullableNumber(1),
});
const polygon = spec('polygon', {
  points: arraySchema(vec, 3, 40), closed: nullableBoolean, fill: nullableBoolean,
});
const circle = spec('circle', { center: vec, r: numberSchema(1), fill: nullableBoolean });
const ellipse = spec('ellipse', {
  center: vec, rx: numberSchema(1), ry: numberSchema(1), fill: nullableBoolean,
});
const point = spec('point', { at: vec, label: nullableString(40) });
const angle = spec('angle', {
  vertex: vec, from: vec, to: vec, label: nullableString(20), radius: nullableNumber(1),
});
const text = spec('text', {
  at: vec, text: stringSchema(120), size: nullable(enumSchema(['small', 'normal', 'big'])),
  align: nullable(enumSchema(['start', 'middle', 'end'])),
  style: nullable(enumSchema(['handwritten'])),
});
const equation = spec('equation', {
  at: vec, latex: stringSchema(200), size: nullable(enumSchema(['small', 'normal', 'big'])),
});
const label = spec('label', {
  target: stringSchema(40), side: nullable(enumSchema(['above', 'below', 'left', 'right'])),
  text: stringSchema(120),
});
const axes = spec('axes', {
  at: vec, w: numberSchema(1), h: numberSchema(1), xRange: vec, yRange: vec,
  xLabel: nullableString(30), yLabel: nullableString(30), ticks: nullableBoolean,
});
const plot = spec('plot', {
  axes: stringSchema(40), expr: nullableString(120),
  points: nullable(arraySchema(vec, 2, 80)), label: nullableString(40),
});
const barItem = strictObject({ label: stringSchema(24), value: numberSchema() });
const bars = spec('bars', {
  at: vec, w: numberSchema(1), h: numberSchema(1),
  items: arraySchema(barItem, 1, 10), yLabel: nullableString(30),
});
const mark = strictObject({
  value: numberSchema(), label: nullableString(20), color: nullable(enumSchema(PALETTE_NAMES)),
});
const numberline = spec('numberline', {
  at: vec, w: numberSchema(1), min: numberSchema(), max: numberSchema(),
  step: nullableNumber(0), marks: nullable(arraySchema(mark, 1, 15)),
});
const box = spec('box', {
  at: vec, w: nullableNumber(1), h: nullableNumber(1), text: stringSchema(120),
});
const endpoint = { anyOf: [stringSchema(40), vec] };
const connector = spec('connector', {
  from: endpoint, to: endpoint, label: nullableString(40), dash: nullableBoolean,
});
const fragmentSelector = strictObject({
  type: { type: 'string', const: 'FragmentSelector' }, unit: { type: 'string', const: 'percent' },
  x: numberSchema(0), y: numberSchema(0), w: numberSchema(0), h: numberSchema(0),
});
const svgSelector = strictObject({
  type: { type: 'string', const: 'SvgSelector' }, points: arraySchema(vec, 3, 32),
});
const pointSelector = strictObject({
  type: { type: 'string', const: 'PointSelector' }, x: numberSchema(0), y: numberSchema(0),
});
const anchorRef = {
  anyOf: [
    strictObject({ type: { type: 'string', const: 'semantic' }, objectId: stringSchema(40), anchor: nullableString(60) }),
    strictObject({ type: { type: 'string', const: 'learner_stroke' }, strokeId: stringSchema(40), anchor: nullable(enumSchema(['start', 'middle', 'end'])) }),
    strictObject({ type: { type: 'string', const: 'image_region' }, imageId: stringSchema(40), selector: { anyOf: [fragmentSelector, svgSelector, pointSelector] } }),
    strictObject({ type: { type: 'string', const: 'point' }, at: vec }),
  ],
};
const annotate = spec('annotate', {
  style: enumSchema(['circle', 'underline', 'arrow', 'tick', 'cross', 'bracket', 'callout', 'highlighter']),
  target: { anyOf: [anchorRef, arraySchema(anchorRef, 1, 8)] },
  note: nullableString(120),
});
const transformOperation = {
  anyOf: [
    strictObject({ type: { type: 'string', const: 'rotate' }, angleDeg: numberSchema(), center: nullable(vec) }),
    strictObject({ type: { type: 'string', const: 'reflect' }, axis: strictObject({ from: vec, to: vec }) }),
    strictObject({ type: { type: 'string', const: 'translate' }, vector: vec }),
    strictObject({ type: { type: 'string', const: 'enlarge' }, scale: numberSchema(0), center: nullable(vec) }),
  ],
};
const transform = spec('transform', { target: stringSchema(40), operation: transformOperation, label: nullableString(40) });
const panelMark = strictObject({
  shape: enumSchema(['circle', 'square', 'triangle', 'line']), x: numberSchema(0), y: numberSchema(0),
  size: nullableNumber(1), rotationDeg: nullableNumber(), fill: nullableBoolean,
});
const panelCell = strictObject({
  row: numberSchema(0), col: numberSchema(0), label: nullableString(30), marks: arraySchema(panelMark, 0, 16),
});
const panelGrid = spec('panelGrid', {
  at: vec, w: numberSchema(1), h: numberSchema(1), rows: numberSchema(1), cols: numberSchema(1), panels: arraySchema(panelCell, 0, 36),
});
const vennRegion = spec('regionFill', {
  mode: { type: 'string', const: 'venn' }, at: vec, w: numberSchema(1), h: numberSchema(1),
  operation: enumSchema(['union', 'intersection']), labels: arraySchema(stringSchema(24), 2, 2),
});
const fractionRegion = spec('regionFill', {
  mode: { type: 'string', const: 'fraction' }, at: vec, w: numberSchema(1), h: numberSchema(1), numerator: numberSchema(0), denominator: numberSchema(1),
});
const halfPlaneRegion = spec('regionFill', {
  mode: { type: 'string', const: 'half_plane' }, axes: stringSchema(40), slope: numberSchema(), intercept: numberSchema(), side: enumSchema(['above', 'below']), inclusive: { type: 'boolean' },
});
const polygonRegion = spec('regionFill', {
  mode: { type: 'string', const: 'polygon' }, points: arraySchema(vec, 3, 40),
});
const scatter = spec('scatter', {
  at: vec, w: numberSchema(1), h: numberSchema(1), xRange: vec, yRange: vec,
  points: arraySchema(vec, 1, 100), xLabel: nullableString(30), yLabel: nullableString(30),
});
const boxplot = spec('boxplot', {
  at: vec, w: numberSchema(1), min: numberSchema(), q1: numberSchema(), median: numberSchema(), q3: numberSchema(), max: numberSchema(), label: nullableString(40),
});
const histogramBin = strictObject({ from: numberSchema(), to: numberSchema(), frequency: numberSchema(0) });
const histogram = spec('histogram', {
  at: vec, w: numberSchema(1), h: numberSchema(1), bins: arraySchema(histogramBin, 1, 20), xLabel: nullableString(30), yLabel: nullableString(30),
});
const voxel = arraySchema(numberSchema(0), 3, 3);
const isometricSolid = spec('isometricSolid', { at: vec, unit: numberSchema(1), voxels: arraySchema(voxel, 1, 32) });
const cubeFace = strictObject({ id: stringSchema(40), row: numberSchema(0), col: numberSchema(0), label: nullableString(12) });
const cubeNet = spec('cubeNet', { at: vec, cell: numberSchema(1), faces: arraySchema(cubeFace, 6, 6) });
const planView = spec('planView', { at: vec, cell: numberSchema(1), heights: arraySchema(arraySchema(numberSchema(0), 1, 6), 1, 6) });
const paperFoldHolePunch = spec('paperFoldHolePunch', {
  at: vec, w: numberSchema(1), h: numberSchema(1), folds: arraySchema(enumSchema(['left', 'right', 'up', 'down', 'diagonal']), 1, 3), holes: arraySchema(vec, 1, 12),
});
const gridPaper = spec('gridPaper', {
  at: vec, w: numberSchema(1), h: numberSchema(1), spacing: numberSchema(1), style: enumSchema(['grid', 'dot']), majorEvery: nullableNumber(2),
});
const clock = spec('clock', { center: vec, r: numberSchema(1), hour: numberSchema(0), minute: numberSchema(0), second: nullableNumber(0) });
const protractor = spec('protractor', { center: vec, r: numberSchema(1), angleDeg: nullableNumber(0), label: nullableString(20) });
const table = spec('table', {
  at: vec,
  rows: arraySchema(arraySchema({ type: 'string', maxLength: 40 }, 1, 6), 1, 8),
  headerRow: nullableBoolean,
});
const centerArc = spec('arc', {
  center: vec, r: numberSchema(1), startDeg: numberSchema(), endDeg: numberSchema(),
});
const throughArc = spec('arc', { from: vec, through: vec, to: vec });
const curve = spec('curve', {
  points: arraySchema(vec, 4, 31), width: nullableNumber(1),
});
const asset = spec('asset', {
  assetId: enumSchema(BOARD_ASSET_IDS), at: vec, size: nullableNumber(1), label: nullableString(40),
});
const draggable = spec('draggable', {
  at: vec, handle: enumSchema(['point', 'token', 'piece']), label: nullableString(40),
  size: nullableNumber(1),
});
const snapZone = spec('snapZone', {
  shape: enumSchema(['box', 'interval', 'point']), at: vec, w: nullableNumber(1),
  h: nullableNumber(1), numberlineId: nullableString(40), from: nullableNumber(),
  to: nullableNumber(), tolerance: nullableNumber(1),
});
const tappable = spec('tappable', {
  at: vec, shape: enumSchema(['circle', 'box']), r: nullableNumber(1), w: nullableNumber(1),
  h: nullableNumber(1), label: nullableString(60), selected: nullableBoolean,
});

export const DIRECTOR_EVAL_SPEC_KINDS = [
  'line', 'polygon', 'circle', 'ellipse', 'point', 'angle', 'text', 'equation',
  'label', 'axes', 'plot', 'bars', 'numberline', 'box', 'connector', 'annotate', 'table',
  'arc', 'curve', 'asset', 'draggable', 'snapZone', 'tappable',
  'transform', 'panelGrid', 'regionFill', 'scatter', 'boxplot', 'histogram',
  'isometricSolid', 'cubeNet', 'planView', 'paperFoldHolePunch', 'gridPaper', 'clock', 'protractor',
] as const;

const relationalPlace = strictObject({
  anchor: stringSchema(40), side: enumSchema(['above', 'below', 'left', 'right', 'inside', 'on']),
  gap: numberSchema(0), align: enumSchema(['start', 'center', 'end']),
});

export const DIRECTOR_EVAL_ADD_OP_JSON_SCHEMA: JsonSchema = strictObject({
  op: { type: 'string', const: 'add' },
  id: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[A-Za-z0-9_-]+$' },
  color: nullable(enumSchema(PALETTE_NAMES)),
  place: nullable(relationalPlace),
  spec: {
    anyOf: [
      line, polygon, circle, ellipse, point, angle, text, equation, label, axes,
      plot, bars, numberline, box, connector, annotate, table, centerArc, throughArc, curve,
      asset, draggable, snapZone, tappable, transform, panelGrid, vennRegion,
      fractionRegion, halfPlaneRegion, polygonRegion, scatter, boxplot, histogram,
      isometricSolid, cubeNet, planView, paperFoldHolePunch, gridPaper, clock, protractor,
    ],
  },
});

export const StrictEvalAddOpSchema = z.unknown().superRefine((value, context) => {
  try {
    parseStrictEvalAddOp(value);
  } catch (error) {
    context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid Board add operation.' });
  }
});

export function parseStrictEvalAddOp(value: unknown): AddOp {
  const normalized = value && typeof value === 'object' && !Array.isArray(value) && !('place' in value)
    ? { ...value, place: null }
    : value;
  if (!matchesJsonSchema(normalized, DIRECTOR_EVAL_ADD_OP_JSON_SCHEMA)) {
    throw new Error('Board add operation does not match the strict evaluation schema.');
  }
  const validated = validateOps([normalized], { tier: 'authored' });
  const op = validated.ops[0];
  if (validated.rejected.length > 0 || validated.ops.length !== 1 || op?.op !== 'add') {
    throw new Error(validated.rejected[0]?.reason ?? 'Board add operation failed authored validation.');
  }
  return op;
}

function matchesJsonSchema(value: unknown, schema: JsonSchema): boolean {
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) return anyOf.some((candidate) => matchesJsonSchema(value, candidate as JsonSchema));
  if ('const' in schema && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value) &&
      (typeof schema.minimum !== 'number' || value >= schema.minimum);
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false;
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return false;
    return typeof schema.pattern !== 'string' || new RegExp(schema.pattern).test(value);
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return false;
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
    return !schema.items || value.every((item) => matchesJsonSchema(item, schema.items as JsonSchema));
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const properties = schema.properties as Record<string, JsonSchema> | undefined;
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some((key) => typeof key !== 'string' || !(key in record))) return false;
    if (schema.additionalProperties === false && properties && Object.keys(record).some((key) => !(key in properties))) return false;
    return !properties || Object.entries(record).every(([key, item]) =>
      !properties[key] || matchesJsonSchema(item, properties[key]));
  }
  return false;
}
