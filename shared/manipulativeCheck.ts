import { z } from 'zod';
import type { NumberlineSpec, ShapeSpec } from './boardOps.js';
import { isManipulativeSpec, type DraggableSpec, type SnapZoneSpec, type TappableSpec } from './manipulativeSpecs.js';

export const ManipulativeCheckBoundsSchema = z.object({
  at: z.tuple([z.number(), z.number()]).optional(),
  w: z.number().finite().positive().max(1000).optional(),
  h: z.number().finite().positive().max(600).optional(),
  from: z.number().finite().optional(),
  to: z.number().finite().optional(),
  numberlineId: z.string().min(1).max(160).optional(),
});

export const ManipulativeCheckSchema = z.object({
  targetId: z.string().min(1).max(160),
  predicate: z.enum(['within', 'selected', 'snapped']),
  snapZoneId: z.string().min(1).max(160).optional(),
  bounds: ManipulativeCheckBoundsSchema.optional(),
  tolerance: z.number().finite().positive().max(200).optional(),
}).superRefine((check, context) => {
  if (check.predicate === 'snapped' && !check.snapZoneId && !check.bounds) {
    context.addIssue({ code: 'custom', path: ['snapZoneId'], message: 'snapped checks require snapZoneId or bounds.' });
  }
});
export type ManipulativeCheck = z.infer<typeof ManipulativeCheckSchema>;

export const ManipulativeCheckResultSchema = z.object({
  passed: z.boolean(),
  predicate: z.enum(['within', 'selected', 'snapped']),
  targetId: z.string(),
  summary: z.string().max(500),
  distancePx: z.number().finite().nonnegative().optional(),
  selected: z.boolean().optional(),
});
export type ManipulativeCheckResult = z.infer<typeof ManipulativeCheckResultSchema>;

export interface ManipulativeSceneItem {
  id: string;
  spec: ShapeSpec;
}

export interface EvaluateManipulativeInput {
  check: ManipulativeCheck;
  items: ManipulativeSceneItem[];
  defaultTolerance?: number;
}

function itemById(items: ManipulativeSceneItem[], id: string): ManipulativeSceneItem | undefined {
  return items.find((entry) => entry.id === id);
}

function numberlineX(spec: NumberlineSpec, value: number): number {
  const { at, w, min, max } = spec;
  if (max === min) return at[0];
  return at[0] + ((value - min) / (max - min)) * w;
}

/** Maps a number-line domain value to board x; shared by checks and renderers. */
export function numberlineXFromSpec(spec: NumberlineSpec, value: number): number {
  return numberlineX(spec, value);
}

function resolveIntervalBounds(
  zone: SnapZoneSpec,
  items: ManipulativeSceneItem[],
): { x0: number; x1: number; y: number; tolerance: number } | null {
  if (zone.shape !== 'interval') return null;
  const from = zone.from;
  const to = zone.to;
  if (from === undefined || to === undefined) return null;
  const line = zone.numberlineId ? itemById(items, zone.numberlineId) : undefined;
  if (line?.spec.kind === 'numberline') {
    if (line.spec.min === line.spec.max) return null;
    const y = line.spec.at[1];
    return {
      x0: numberlineX(line.spec, from),
      x1: numberlineX(line.spec, to),
      y,
      tolerance: zone.tolerance ?? 18,
    };
  }
  if (zone.numberlineId) return null;
  const x0 = zone.at[0];
  const x1 = zone.at[0] + (zone.w ?? Math.abs(to - from) * 100);
  return { x0, x1, y: zone.at[1], tolerance: zone.tolerance ?? 18 };
}

function pointInBox(
  point: [number, number],
  at: [number, number],
  w: number,
  h: number,
  tolerance: number,
): boolean {
  const x0 = at[0] - w / 2;
  const y0 = at[1] - h / 2;
  return (
    point[0] >= x0 - tolerance
    && point[0] <= x0 + w + tolerance
    && point[1] >= y0 - tolerance
    && point[1] <= y0 + h + tolerance
  );
}

function distanceToInterval(point: [number, number], x0: number, x1: number, y: number): number {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const dx = point[0] < minX ? minX - point[0] : point[0] > maxX ? point[0] - maxX : 0;
  const dy = Math.abs(point[1] - y);
  return Math.hypot(dx, dy);
}

function explicitPoint(value: readonly unknown[] | undefined, fallback: [number, number]): [number, number] {
  const x = value?.[0];
  const y = value?.[1];
  return typeof x === 'number' && typeof y === 'number' ? [x, y] : fallback;
}

function withinBounds(
  point: [number, number],
  bounds: NonNullable<ManipulativeCheck['bounds']>,
  items: ManipulativeSceneItem[],
  tolerance: number,
): { passed: boolean; distancePx: number } {
  if (bounds.from !== undefined && bounds.to !== undefined) {
    const zone: SnapZoneSpec = {
      kind: 'snapZone',
      shape: 'interval',
      at: explicitPoint(bounds.at, [0, 300]),
      from: bounds.from,
      to: bounds.to,
      ...(bounds.numberlineId ? { numberlineId: bounds.numberlineId } : {}),
      tolerance,
    };
    const interval = resolveIntervalBounds(zone, items);
    if (!interval) return { passed: false, distancePx: Infinity };
    const distancePx = distanceToInterval(point, interval.x0, interval.x1, interval.y);
    return { passed: distancePx <= tolerance, distancePx };
  }
  if (bounds.at && bounds.w && bounds.h) {
    const at = explicitPoint(bounds.at, [0, 0]);
    const passed = pointInBox(point, at, bounds.w, bounds.h, tolerance);
    const cx = at[0];
    const cy = at[1];
    const distancePx = Math.hypot(point[0] - cx, point[1] - cy);
    return { passed, distancePx };
  }
  return { passed: false, distancePx: Infinity };
}

function snappedToZone(
  point: [number, number],
  zone: SnapZoneSpec,
  items: ManipulativeSceneItem[],
  tolerance: number,
): { passed: boolean; distancePx: number } {
  if (zone.shape === 'box') {
    const w = zone.w ?? MIN_BOX;
    const h = zone.h ?? MIN_BOX;
    const passed = pointInBox(point, zone.at, w, h, tolerance);
    const distancePx = Math.hypot(point[0] - zone.at[0], point[1] - zone.at[1]);
    return { passed, distancePx };
  }
  if (zone.shape === 'point') {
    const distancePx = Math.hypot(point[0] - zone.at[0], point[1] - zone.at[1]);
    return { passed: distancePx <= (zone.tolerance ?? tolerance), distancePx };
  }
  const interval = resolveIntervalBounds(zone, items);
  if (!interval) return { passed: false, distancePx: Infinity };
  const distancePx = distanceToInterval(point, interval.x0, interval.x1, interval.y);
  return { passed: distancePx <= (zone.tolerance ?? tolerance), distancePx };
}

const MIN_BOX = 44;

export function evaluateManipulativeCheck(input: EvaluateManipulativeInput): ManipulativeCheckResult {
  const tolerance = input.check.tolerance ?? input.defaultTolerance ?? 12;
  const target = itemById(input.items, input.check.targetId);
  if (!target || !isManipulativeSpec(target.spec)) {
    return {
      passed: false,
      predicate: input.check.predicate,
      targetId: input.check.targetId,
      summary: `Target ${input.check.targetId} is not an interactive object on the board.`,
    };
  }

  if (input.check.predicate === 'selected') {
    if (target.spec.kind !== 'tappable') {
      return {
        passed: false,
        predicate: 'selected',
        targetId: input.check.targetId,
        summary: `${input.check.targetId} is not a tap target.`,
      };
    }
    const selected = target.spec.selected === true;
    return {
      passed: selected,
      predicate: 'selected',
      targetId: input.check.targetId,
      summary: selected
        ? `The learner selected ${input.check.targetId}.`
        : `The learner has not selected ${input.check.targetId} yet.`,
      selected,
    };
  }

  const point: [number, number] = target.spec.kind === 'draggable'
    ? (target.spec as DraggableSpec).at
    : (target.spec as TappableSpec).at;

  if (input.check.predicate === 'within') {
    if (!input.check.bounds) {
      return {
        passed: false,
        predicate: 'within',
        targetId: input.check.targetId,
        summary: 'The check is missing bounds.',
      };
    }
    const { passed, distancePx } = withinBounds(point, input.check.bounds, input.items, tolerance);
    return {
      passed,
      predicate: 'within',
      targetId: input.check.targetId,
      summary: passed
        ? `${input.check.targetId} is within the target region (distance ${distancePx.toFixed(1)}px).`
        : `${input.check.targetId} is not yet in the target region (distance ${distancePx.toFixed(1)}px).`,
      distancePx,
    };
  }

  const zoneItem = input.check.snapZoneId ? itemById(input.items, input.check.snapZoneId) : undefined;
  const zone = zoneItem?.spec.kind === 'snapZone'
    ? zoneItem.spec
    : input.check.bounds
      ? ({
          kind: 'snapZone',
          shape: input.check.bounds.from !== undefined ? 'interval' as const : 'box' as const,
          at: explicitPoint(input.check.bounds.at, point),
          w: input.check.bounds.w,
          h: input.check.bounds.h,
          from: input.check.bounds.from,
          to: input.check.bounds.to,
          numberlineId: input.check.bounds.numberlineId,
          tolerance,
        } satisfies SnapZoneSpec)
      : null;
  if (!zone) {
    return {
      passed: false,
      predicate: 'snapped',
      targetId: input.check.targetId,
      summary: 'The check is missing a snap zone.',
    };
  }
  const { passed, distancePx } = snappedToZone(point, zone, input.items, tolerance);
  return {
    passed,
    predicate: 'snapped',
    targetId: input.check.targetId,
    summary: passed
      ? `${input.check.targetId} is snapped to the target zone (distance ${distancePx.toFixed(1)}px).`
      : `${input.check.targetId} is not snapped yet (distance ${distancePx.toFixed(1)}px).`,
    distancePx,
  };
}
