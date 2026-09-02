import { z } from 'zod';
import { isCenterArc } from '../../shared/authoredSpecs.js';
import type { AddOp, ShapeSpec, Vec } from '../../shared/boardOps.js';
import type { LayoutIssue } from '../../shared/layoutFeedback.js';
import { translateCurriculumSpec } from '../../shared/curriculumSpecs.js';
import type { DirectorSceneRequest } from './director.js';
import { applyDirectorBoardPolicy } from './directorSchema.js';

const PlacementPatchSchema = z.object({
  id: z.string().min(1).max(40),
  dx: z.number().finite().min(-1_000).max(1_000),
  dy: z.number().finite().min(-600).max(600),
  side: z.enum(['above', 'below', 'left', 'right']).nullable(),
}).strict();

const LayoutCorrectionResponseSchema = z.object({
  placements: z.array(PlacementPatchSchema).min(1).max(12),
}).strict();

export const LAYOUT_CORRECTION_RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'noura_director_layout_correction',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        placements: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 40 },
              dx: { type: 'number', minimum: -1_000, maximum: 1_000 },
              dy: { type: 'number', minimum: -600, maximum: 600 },
              side: { anyOf: [{ type: 'string', enum: ['above', 'below', 'left', 'right'] }, { type: 'null' }] },
            },
            required: ['id', 'dx', 'dy', 'side'],
          },
        },
      },
      required: ['placements'],
    },
  },
} as const;

export interface LayoutCorrectionRequest {
  request: DirectorSceneRequest;
  priorOps: AddOp[];
  rejectedOps: AddOp[];
  layoutIssues: LayoutIssue[];
  signal: AbortSignal;
}

export interface LayoutCorrectionPort {
  streamPlacements(input: LayoutCorrectionRequest): AsyncIterable<string>;
}

export type LayoutCorrectionResult =
  | { ok: true; ops: AddOp[] }
  | { ok: false; code: 'unavailable' | 'invalid_patch' | 'policy_rejected' };

export async function correctLayoutOnce(
  port: LayoutCorrectionPort,
  input: LayoutCorrectionRequest,
): Promise<LayoutCorrectionResult> {
  let raw = '';
  try {
    for await (const chunk of port.streamPlacements(input)) {
      if (input.signal.aborted) throw abortError();
      raw += chunk;
      if (raw.length > 20_000) return { ok: false, code: 'invalid_patch' };
    }
  } catch (error) {
    if (input.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw abortError();
    return { ok: false, code: 'unavailable' };
  }
  let parsed: z.infer<typeof LayoutCorrectionResponseSchema>;
  try {
    parsed = LayoutCorrectionResponseSchema.parse(JSON.parse(raw));
  } catch {
    return { ok: false, code: 'invalid_patch' };
  }
  const rejectedIds = new Set(input.rejectedOps.map((op) => op.id));
  const offendingIds = new Set(input.layoutIssues.flatMap((issue) =>
    [issue.itemId, issue.withItemId].filter((id): id is string => Boolean(id) && rejectedIds.has(id as string))));
  const seen = new Set<string>();
  for (const patch of parsed.placements) {
    if (!offendingIds.has(patch.id) || seen.has(patch.id)) return { ok: false, code: 'invalid_patch' };
    seen.add(patch.id);
  }
  const byId = new Map(parsed.placements.map((patch) => [patch.id, patch]));
  const corrected = input.rejectedOps.map((op) => {
    const patch = byId.get(op.id);
    return patch ? translateAddOp(op, patch.dx, patch.dy, patch.side) : op;
  });
  if (JSON.stringify(corrected) === JSON.stringify(input.rejectedOps)) {
    return { ok: false, code: 'invalid_patch' };
  }
  const policy = applyDirectorBoardPolicy([...input.priorOps, ...corrected], {
    density: input.request.density,
    visibleObjectIds: input.request.visibleObjectIds,
  });
  if (!policy.ok) return { ok: false, code: 'policy_rejected' };
  const correctedPolicyOps = policy.ops.slice(input.priorOps.length);
  if (correctedPolicyOps.length !== corrected.length ||
      correctedPolicyOps.some((op, index) => op.id !== corrected[index]?.id)) {
    return { ok: false, code: 'policy_rejected' };
  }
  return { ok: true, ops: correctedPolicyOps };
}

function translateAddOp(
  op: AddOp,
  dx: number,
  dy: number,
  side: 'above' | 'below' | 'left' | 'right' | null,
): AddOp {
  return { ...op, spec: translateSpec(op.spec, dx, dy, side) };
}

function translateSpec(
  spec: ShapeSpec,
  dx: number,
  dy: number,
  side: 'above' | 'below' | 'left' | 'right' | null,
): ShapeSpec {
  const move = ([x, y]: Vec): Vec => [x + dx, y + dy];
  switch (spec.kind) {
    case 'line': return { ...spec, from: move(spec.from), to: move(spec.to) };
    case 'polygon': return { ...spec, points: spec.points.map(move) };
    case 'circle': case 'ellipse': return { ...spec, center: move(spec.center) };
    case 'point': case 'text': case 'equation': case 'axes': case 'bars': case 'numberline': case 'box': case 'table':
    case 'asset': case 'draggable': case 'snapZone': case 'tappable': return { ...spec, at: move(spec.at) };
    case 'angle': return { ...spec, vertex: move(spec.vertex), from: move(spec.from), to: move(spec.to) };
    case 'connector': return {
      ...spec,
      ...(Array.isArray(spec.from) ? { from: move(spec.from) } : {}),
      ...(Array.isArray(spec.to) ? { to: move(spec.to) } : {}),
    };
    case 'path': case 'curve': return { ...spec, points: spec.points.map(move) };
    case 'arc': return isCenterArc(spec)
      ? { ...spec, center: move(spec.center) }
      : { ...spec, from: move(spec.from), through: move(spec.through), to: move(spec.to) };
    case 'image': return {
      ...spec,
      at: move(spec.at),
      ...(spec.crop ? { crop: { ...spec.crop, x: spec.crop.x + dx, y: spec.crop.y + dy } } : {}),
    };
    case 'label': return side ? { ...spec, side } : spec;
    case 'plot': case 'annotate': return spec;
    case 'transform': case 'panelGrid': case 'regionFill': case 'scatter': case 'boxplot': case 'histogram': case 'isometricSolid': case 'cubeNet': case 'planView': case 'paperFoldHolePunch': case 'gridPaper': case 'clock': case 'protractor':
      return translateCurriculumSpec(spec, dx, dy);
  }
}

function abortError(): Error {
  const error = new Error('Layout correction aborted by visual request epoch.');
  error.name = 'AbortError';
  return error;
}
