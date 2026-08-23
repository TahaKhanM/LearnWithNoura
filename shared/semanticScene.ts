import { z } from 'zod';
import { validateOps, type BoardOp, type Vec } from './boardOps.js';

export const VISUAL_PLAN_VERSION = '1.0.0' as const;
export const VisualTemplateSchema = z.enum([
  'pythagorean_area_proof', 'triangle_angle_sum', 'unit_circle_projection', 'fraction_comparison',
  'slope_comparison', 'causal_cycle', 'argument_structure', 'cause_effect',
  'grammar_structure', 'table', 'timeline', 'no_board',
]);

export const SemanticGroupSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/i),
  label: z.string().min(1).max(160),
  revealOrder: z.array(z.enum(['outline', 'relation', 'label', 'connector', 'emphasis'])).min(1),
  template: VisualTemplateSchema,
  parameters: z.record(z.string(), z.unknown()).default({}),
});

export const SemanticScenePlanSchema = z.object({
  schemaVersion: z.literal(VISUAL_PLAN_VERSION),
  planId: z.string().min(1).max(120),
  intent: z.object({
    objective: z.string().min(1).max(300),
    domain: z.enum(['geometry', 'quantitative', 'process', 'argument', 'history', 'grammar', 'table', 'timeline', 'none']),
    noBoardReason: z.string().max(300).optional(),
  }),
  groups: z.array(SemanticGroupSchema).max(6),
});

export type SemanticScenePlan = z.infer<typeof SemanticScenePlanSchema>;

export type SemanticReveal = SemanticScenePlan['groups'][number]['revealOrder'][number];
export interface SemanticCheckpoint {
  id: string;
  semanticObjectId: string;
  groupLabel: string;
  reveal: SemanticReveal;
  ops: BoardOp[];
}

export function adaptSemanticScene(input: unknown): { plan: SemanticScenePlan; ops: BoardOp[]; checkpoints: SemanticCheckpoint[] } {
  const plan = SemanticScenePlanSchema.parse(input);
  const ops: BoardOp[] = [];
  const checkpoints: SemanticCheckpoint[] = [];
  for (const group of plan.groups) {
    if (group.template === 'no_board') continue;
    const groupOps = opsForGroup(group);
    const finalized = finalizePlan(plan, groupOps).ops;
    ops.push(...finalized);
    const buckets = new Map<SemanticReveal, BoardOp[]>();
    for (const reveal of group.revealOrder) buckets.set(reveal, []);
    for (const op of finalized) {
      const requested = revealForOp(op);
      const reveal = buckets.has(requested) ? requested : group.revealOrder[group.revealOrder.length - 1];
      buckets.get(reveal)?.push(op);
    }
    for (const [index, reveal] of group.revealOrder.entries()) {
      const checkpointOps = buckets.get(reveal) ?? [];
      if (checkpointOps.length === 0) continue;
      checkpoints.push({
        id: `${plan.planId}:${group.id}:${index}:${reveal}`,
        semanticObjectId: group.id,
        groupLabel: group.label,
        reveal,
        ops: checkpointOps,
      });
    }
  }
  return { plan, ops, checkpoints };
}

function opsForGroup(group: SemanticScenePlan['groups'][number]): BoardOp[] {
  const prefix = group.id;
  switch (group.template) {
    case 'pythagorean_area_proof': return pythagoreanProof(prefix);
    case 'triangle_angle_sum': return triangleAngleSum(prefix);
    case 'unit_circle_projection': return unitCircle(prefix, numberParam(group.parameters, 'angleDegrees', 60));
    case 'fraction_comparison': return fractionComparison(prefix, numberArray(group.parameters.values, [2 / 3, 3 / 5]), stringArray(group.parameters.labels, ['2/3', '3/5']));
    case 'slope_comparison': return slopeComparison(prefix, numberArray(group.parameters.slopes, [1, 2, -1]));
    case 'causal_cycle': return layeredGraph(prefix, stringArray(group.parameters.labels, ['Stage 1', 'Stage 2', 'Stage 3', 'Stage 4']), true);
    case 'argument_structure': return layeredGraph(prefix, stringArray(group.parameters.labels, ['Claim', 'Evidence', 'Reasoning']), false);
    case 'cause_effect': return layeredGraph(prefix, stringArray(group.parameters.labels, ['Cause', 'Event', 'Effect']), false);
    case 'grammar_structure': return layeredGraph(prefix, stringArray(group.parameters.labels, ['Subject', 'Verb', 'Object']), false);
    case 'table': return [{ op: 'add', id: `${prefix}-table`, spec: { kind: 'table', at: [160, 130], rows: tableRows(group.parameters.rows), headerRow: true } }];
    case 'timeline': return timeline(prefix, stringArray(group.parameters.labels, ['Earlier', 'Middle', 'Later']));
    case 'no_board': return [];
  }
}

function revealForOp(op: BoardOp): SemanticReveal {
  if (op.op === 'highlight' || op.op === 'update') return 'emphasis';
  if (op.op !== 'add') return 'outline';
  if (['text', 'equation', 'label'].includes(op.spec.kind)) return 'label';
  if (op.spec.kind === 'connector') return 'connector';
  if (['plot', 'angle', 'point'].includes(op.spec.kind)) return 'relation';
  if (op.spec.kind === 'line' && op.spec.arrow) return 'connector';
  return 'outline';
}

function finalizePlan(plan: SemanticScenePlan, rawOps: BoardOp[]): { plan: SemanticScenePlan; ops: BoardOp[] } {
  const validated = validateOps(rawOps);
  if (validated.rejected.length > 0 || validated.ops.length !== rawOps.length) throw new Error(`Domain adapter produced invalid operations: ${validated.rejected.map((entry) => entry.reason).join('; ')}`);
  return { plan, ops: validated.ops };
}

function pythagoreanProof(prefix: string): BoardOp[] {
  const ops: BoardOp[] = [];
  const y = 120;
  const side = 300;
  const a = 180;
  const b = 120;
  const left = 80;
  const right = 620;
  for (const [index, x] of [left, right].entries()) {
    ops.push({ op: 'add', id: `${prefix}-frame-${index}`, color: index ? 'green' : 'blue', spec: { kind: 'polygon', points: [[x, y], [x + side, y], [x + side, y + side], [x, y + side]], closed: true } });
  }
  const cArrangement: Vec[][] = [
    [[left, y], [left + b, y], [left, y + a]],
    [[left + b, y], [left + side, y], [left + side, y + b]],
    [[left + side, y + b], [left + side, y + side], [left + a, y + side]],
    [[left + a, y + side], [left, y + side], [left, y + a]],
  ];
  const abArrangement: Vec[][] = [
    [[right + a, y], [right + side, y], [right + a, y + a]],
    [[right + side, y], [right + side, y + a], [right + a, y + a]],
    [[right, y + a], [right + a, y + a], [right, y + side]],
    [[right + a, y + a], [right + a, y + side], [right, y + side]],
  ];
  cArrangement.forEach((points, index) => ops.push({ op: 'add', id: `${prefix}-tri-c-${index}`, color: 'amber', spec: { kind: 'polygon', points, closed: true, fill: true } }));
  abArrangement.forEach((points, index) => ops.push({ op: 'add', id: `${prefix}-tri-ab-${index}`, color: 'amber', spec: { kind: 'polygon', points, closed: true, fill: true } }));
  ops.push({ op: 'add', id: `${prefix}-c-square`, color: 'green', spec: { kind: 'polygon', points: [[left + b, y], [left + side, y + b], [left + a, y + side], [left, y + a]], closed: true } });
  ops.push({ op: 'add', id: `${prefix}-a-square`, color: 'blue', spec: { kind: 'polygon', points: [[right, y], [right + a, y], [right + a, y + a], [right, y + a]], closed: true } });
  ops.push({ op: 'add', id: `${prefix}-b-square`, color: 'red', spec: { kind: 'polygon', points: [[right + a, y + a], [right + side, y + a], [right + side, y + side], [right + a, y + side]], closed: true } });
  ops.push({ op: 'add', id: `${prefix}-label-c`, color: 'green', spec: { kind: 'text', at: [left + 150, 470], text: 'c² square', size: 'big' } });
  ops.push({ op: 'add', id: `${prefix}-label-ab`, color: 'blue', spec: { kind: 'text', at: [right, 470], text: 'a² + b² squares' } });
  ops.push({ op: 'add', id: `${prefix}-equivalence`, color: 'ink', spec: { kind: 'connector', from: [420, 270], to: [580, 270], label: 'same 4 triangles' } });
  // The equation occupies the measured centre gutter between both frames.
  ops.push({ op: 'add', id: `${prefix}-equation`, color: 'green', spec: { kind: 'equation', at: [393, 330], latex: 'c^2=a^2+b^2', size: 'small' } });
  return ops;
}

/** A code-owned straight-line proof layout for the angle sum of a triangle. */
function triangleAngleSum(prefix: string): BoardOp[] {
  const left: Vec = [230, 430];
  const apex: Vec = [500, 135];
  const right: Vec = [770, 430];
  return [
    { op: 'add', id: `${prefix}-triangle`, color: 'ink', spec: { kind: 'polygon', points: [left, apex, right], closed: true } },
    { op: 'add', id: `${prefix}-straight-line`, color: 'ink', spec: { kind: 'line', from: [165, apex[1]], to: [835, apex[1]], dash: true } },
    { op: 'add', id: `${prefix}-angle-a`, color: 'blue', spec: { kind: 'angle', vertex: left, from: right, to: apex, radius: 48, label: 'A' } },
    { op: 'add', id: `${prefix}-angle-c`, color: 'amber', spec: { kind: 'angle', vertex: apex, from: left, to: right, radius: 54, label: 'C' } },
    { op: 'add', id: `${prefix}-angle-b`, color: 'red', spec: { kind: 'angle', vertex: right, from: apex, to: left, radius: 48, label: 'B' } },
    { op: 'add', id: `${prefix}-straight-label`, color: 'ink', spec: { kind: 'label', target: `${prefix}-straight-line`, side: 'above', text: 'straight line = 180°' } },
    { op: 'add', id: `${prefix}-sum`, color: 'green', spec: { kind: 'equation', at: [390, 480], latex: 'A+B+C=180^\\circ', size: 'big' } },
  ];
}

function unitCircle(prefix: string, degrees: number): BoardOp[] {
  const angle = (degrees * Math.PI) / 180;
  const center: Vec = [500, 315];
  const radius = 210;
  const point: Vec = [center[0] + radius * Math.cos(angle), center[1] - radius * Math.sin(angle)];
  return [
    { op: 'add', id: `${prefix}-circle`, color: 'blue', spec: { kind: 'circle', center, r: radius } },
    { op: 'add', id: `${prefix}-x-axis`, spec: { kind: 'line', from: [230, center[1]], to: [770, center[1]], arrow: 'both' } },
    { op: 'add', id: `${prefix}-y-axis`, spec: { kind: 'line', from: [center[0], 65], to: [center[0], 565], arrow: 'both' } },
    { op: 'add', id: `${prefix}-radius`, color: 'red', spec: { kind: 'line', from: center, to: point } },
    { op: 'add', id: `${prefix}-angle`, color: 'amber', spec: { kind: 'angle', vertex: center, from: [center[0] + 100, center[1]], to: point, label: `${degrees}°` } },
    { op: 'add', id: `${prefix}-point`, color: 'green', spec: { kind: 'point', at: point, label: degrees === 60 ? '(1/2, √3/2)' : `(${Math.cos(angle).toFixed(2)}, ${Math.sin(angle).toFixed(2)})` } },
    { op: 'add', id: `${prefix}-x-projection`, color: 'green', spec: { kind: 'line', from: point, to: [point[0], center[1]], dash: true } },
    { op: 'add', id: `${prefix}-y-projection`, color: 'green', spec: { kind: 'line', from: point, to: [center[0], point[1]], dash: true } },
  ];
}

function fractionComparison(prefix: string, values: number[], labels: string[]): BoardOp[] {
  return [{ op: 'add', id: `${prefix}-scale`, spec: { kind: 'numberline', at: [130, 300], w: 740, min: 0, max: 1, step: 0.1, marks: values.slice(0, 4).map((value, index) => ({ value, label: labels[index] ?? String(value), color: index === 0 ? 'blue' : index === 1 ? 'red' : 'green' })) } }];
}

function slopeComparison(prefix: string, slopes: number[]): BoardOp[] {
  const colors = ['blue', 'red', 'green'] as const;
  const ops: BoardOp[] = [{ op: 'add', id: `${prefix}-axes`, spec: { kind: 'axes', at: [190, 70], w: 620, h: 470, xRange: [-5, 5], yRange: [-5, 5], xLabel: 'x', yLabel: 'y' } }];
  slopes.slice(0, 3).forEach((slope, index) => ops.push({ op: 'add', id: `${prefix}-line-${index}`, color: colors[index], spec: { kind: 'plot', axes: `${prefix}-axes`, expr: `${slope}*x`, label: `y = ${slope}x` } }));
  return ops;
}

function layeredGraph(prefix: string, labels: string[], cycle: boolean): BoardOp[] {
  const safe = labels.slice(0, 6);
  const positions: Vec[] = safe.map((_, index) => {
    if (cycle) {
      const angle = -Math.PI / 2 + (index / safe.length) * Math.PI * 2;
      return [500 + Math.cos(angle) * 300, 300 + Math.sin(angle) * 190];
    }
    return [180 + index * (640 / Math.max(1, safe.length - 1)), 300];
  });
  const ops: BoardOp[] = safe.map((label, index) => ({ op: 'add', id: `${prefix}-node-${index}`, color: index === 0 ? 'blue' : index === safe.length - 1 ? 'green' : 'amber', spec: { kind: 'box', at: positions[index], text: label } }));
  for (let index = 1; index < safe.length; index += 1) {
    const [from, to] = edgePoints(positions[index - 1], positions[index]);
    ops.push({ op: 'add', id: `${prefix}-edge-${index - 1}`, color: 'ink', spec: { kind: 'line', from, to, arrow: 'end' } });
  }
  if (cycle && safe.length > 2) ops.push({ op: 'add', id: `${prefix}-edge-loop`, color: 'blue', spec: { kind: 'connector', from: `${prefix}-node-${safe.length - 1}`, to: `${prefix}-node-0`, label: 'continues' } });
  return ops;
}

function timeline(prefix: string, labels: string[]): BoardOp[] {
  const ops: BoardOp[] = [{ op: 'add', id: `${prefix}-line`, spec: { kind: 'line', from: [130, 300], to: [870, 300], arrow: 'end' } }];
  labels.slice(0, 6).forEach((label, index, all) => {
    const x = 160 + index * (680 / Math.max(1, all.length - 1));
    ops.push({ op: 'add', id: `${prefix}-point-${index}`, color: index === all.length - 1 ? 'green' : 'blue', spec: { kind: 'point', at: [x, 300], label } });
  });
  return ops;
}

function numberParam(parameters: Record<string, unknown>, key: string, fallback: number): number { const value = parameters[key]; return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function numberArray(value: unknown, fallback: number[]): number[] { return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)).slice(0, 6) : fallback; }
function stringArray(value: unknown, fallback: string[]): string[] { return Array.isArray(value) ? value.map(String).filter(Boolean).map((item) => item.slice(0, 80)).slice(0, 6) : fallback; }
function tableRows(value: unknown): string[][] { return Array.isArray(value) ? value.slice(0, 8).map((row) => Array.isArray(row) ? row.slice(0, 6).map((cell) => String(cell).slice(0, 60)) : []).filter((row) => row.length > 0) : [['Idea', 'Evidence'], ['—', '—']]; }
function edgePoints(from: Vec, to: Vec): [Vec, Vec] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / length;
  const uy = dy / length;
  const inset = Math.abs(ux) > Math.abs(uy) ? 95 : 54;
  return [[from[0] + ux * inset, from[1] + uy * inset], [to[0] - ux * inset, to[1] - uy * inset]];
}
