import { z } from 'zod';
import { BOARD_ASSET_IDS } from '../../../shared/boardAssets.js';
import { validateOps, type AddOp } from '../../../shared/boardOps.js';

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
  'label', 'axes', 'plot', 'bars', 'numberline', 'box', 'connector', 'table',
  'arc', 'curve', 'asset', 'draggable', 'snapZone', 'tappable',
] as const;

export const DIRECTOR_EVAL_ADD_OP_JSON_SCHEMA: JsonSchema = strictObject({
  op: { type: 'string', const: 'add' },
  id: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[A-Za-z0-9_-]+$' },
  color: nullable(enumSchema(PALETTE_NAMES)),
  spec: {
    anyOf: [
      line, polygon, circle, ellipse, point, angle, text, equation, label, axes,
      plot, bars, numberline, box, connector, table, centerArc, throughArc, curve,
      asset, draggable, snapZone, tappable,
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
  if (!matchesJsonSchema(value, DIRECTOR_EVAL_ADD_OP_JSON_SCHEMA)) {
    throw new Error('Board add operation does not match the strict evaluation schema.');
  }
  const validated = validateOps([value], { tier: 'authored' });
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
