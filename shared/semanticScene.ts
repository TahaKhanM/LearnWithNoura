import { z } from 'zod';
import { validateOps, type BoardOp, type Vec } from './boardOps.js';

export const VISUAL_PLAN_VERSION = '2.0.0' as const;
export const VisualTemplateSchema = z.enum([
  'pythagorean_area_proof', 'triangle_angle_sum', 'unit_circle_projection', 'fraction_comparison',
  'slope_comparison', 'causal_cycle', 'argument_structure', 'cause_effect',
  'grammar_structure', 'relationship_map', 'worked_steps', 'comparison', 'part_whole',
  'table', 'timeline', 'no_board',
]);

export const VisualRelevanceSchema = z.enum(['essential', 'supportive', 'none']);
export const VisualActionSchema = z.enum(['create', 'reuse', 'replace', 'skip']);

export const SemanticGroupSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/i),
  label: z.string().min(1).max(160),
  revealOrder: z.array(z.enum(['outline', 'relation', 'label', 'connector', 'emphasis'])).min(1),
  template: VisualTemplateSchema,
  parameters: z.record(z.string(), z.unknown()).default({}),
});

export const SemanticScenePlanSchema = z.object({
  schemaVersion: z.enum(['1.0.0', VISUAL_PLAN_VERSION]),
  planId: z.string().min(1).max(120),
  intent: z.object({
    objective: z.string().min(1).max(300),
    domain: z.enum(['geometry', 'quantitative', 'algebra', 'comparison', 'process', 'argument', 'history', 'grammar', 'table', 'timeline', 'none']),
    relevance: VisualRelevanceSchema.default('essential'),
    questionAnswered: z.string().min(1).max(300).default('Show the current idea spatially.'),
    rationale: z.string().min(1).max(400).default('A visual representation supports the current teaching move.'),
    action: VisualActionSchema.default('create'),
    targetGroupId: z.string().min(1).max(160).optional(),
    density: z.enum(['minimal', 'standard']).default('minimal'),
    noBoardReason: z.string().max(300).optional(),
  }),
  groups: z.array(SemanticGroupSchema).max(1),
}).superRefine((plan, context) => {
  const noBoard = plan.groups.length === 0 || plan.groups.every((group) => group.template === 'no_board');
  if (plan.intent.relevance === 'none' && !noBoard) context.addIssue({ code: 'custom', path: ['groups'], message: 'A non-relevant visual must not create a board group.' });
  if (['skip', 'reuse'].includes(plan.intent.action) && !noBoard) context.addIssue({ code: 'custom', path: ['groups'], message: 'Skip/reuse decisions do not create a new visual group.' });
  if (plan.intent.action === 'reuse' && !plan.intent.targetGroupId) context.addIssue({ code: 'custom', path: ['intent', 'targetGroupId'], message: 'Reuse requires a visible target group id.' });
  if (plan.intent.action === 'replace' && (!plan.intent.targetGroupId || plan.groups[0]?.id !== plan.intent.targetGroupId)) context.addIssue({ code: 'custom', path: ['intent', 'targetGroupId'], message: 'Replace requires the visible target group id and a group with that same id.' });
  if (['create', 'replace'].includes(plan.intent.action) && plan.intent.relevance !== 'none' && noBoard) context.addIssue({ code: 'custom', path: ['groups'], message: 'A create/replace decision requires one non-empty visual group.' });
});

export type SemanticScenePlan = z.infer<typeof SemanticScenePlanSchema>;

export type SemanticReveal = SemanticScenePlan['groups'][number]['revealOrder'][number];
export interface SemanticCheckpoint {
  id: string;
  semanticObjectId: string;
  groupLabel: string;
  reveal: SemanticReveal;
  ops: BoardOp[];
  /**
   * When set, this checkpoint atomically replaces the named section: the
   * client clears that section and applies these ops in one visible commit,
   * with no intermediate blank frame and no draw-on animation gap.
   */
  replacesGroup?: string;
}

/** Dependency rank owned by code: targets always reveal before their labels,
 * relations, and connectors, regardless of the order the model requested. */
const CANONICAL_REVEAL_ORDER: SemanticReveal[] = ['outline', 'relation', 'label', 'connector', 'emphasis'];

export function adaptSemanticScene(input: unknown): { plan: SemanticScenePlan; ops: BoardOp[]; checkpoints: SemanticCheckpoint[] } {
  const plan = SemanticScenePlanSchema.parse(input);
  const ops: BoardOp[] = [];
  const checkpoints: SemanticCheckpoint[] = [];
  for (const group of plan.groups) {
    if (group.template === 'no_board') continue;
    const finalized = finalizePlan(plan, opsForGroup(group)).ops;
    ops.push(...finalized);
    if (plan.intent.action === 'replace') {
      // A replacement is one atomic checkpoint. A standalone clear must
      // never reach the board ahead of the content that replaces it.
      checkpoints.push({
        id: `${plan.planId}:${group.id}:0:replace`,
        semanticObjectId: group.id,
        groupLabel: group.label,
        reveal: 'outline',
        ops: finalized,
        replacesGroup: group.id,
      });
      continue;
    }
    const buckets = new Map<SemanticReveal, BoardOp[]>();
    for (const op of finalized) {
      const reveal = revealForOp(op);
      buckets.set(reveal, [...(buckets.get(reveal) ?? []), op]);
    }
    for (const [index, reveal] of CANONICAL_REVEAL_ORDER.entries()) {
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
    case 'relationship_map': return relationshipMap(prefix, group.parameters);
    case 'worked_steps': return workedSteps(prefix, stringArray(group.parameters.steps, ['First step', 'Next step', 'Result']));
    case 'comparison': return comparisonTable(prefix, group.parameters);
    case 'part_whole': return partWhole(prefix, group.parameters);
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

function relationshipMap(prefix: string, parameters: Record<string, unknown>): BoardOp[] {
  const nodes = nodeRecords(parameters.nodes);
  const edges = edgeRecords(parameters.edges, nodes);
  const layout = ['hierarchy', 'flow', 'cycle'].includes(String(parameters.layout)) ? String(parameters.layout) : 'flow';
  const positions = layout === 'cycle'
    ? radialPositions(nodes.length)
    : layout === 'hierarchy'
      ? hierarchyPositions(nodes, edges)
      : flowPositions(nodes.length);
  const ops: BoardOp[] = nodes.map((node, index) => ({
    op: 'add', id: `${prefix}-node-${node.id}`, color: index === 0 ? 'blue' : index === nodes.length - 1 ? 'green' : 'amber',
    spec: { kind: 'box', at: positions[index], text: node.label },
  }));
  for (const [index, edge] of edges.entries()) ops.push({
    op: 'add', id: `${prefix}-edge-${index}`, color: 'ink',
    spec: {
      kind: 'connector',
      from: `${prefix}-node-${edge.from}`,
      to: `${prefix}-node-${edge.to}`,
      ...(edge.label ? { label: edge.label } : {}),
    },
  });
  return ops;
}

function workedSteps(prefix: string, steps: string[]): BoardOp[] {
  const safe = steps.slice(0, 6);
  const twoColumns = safe.length > 4;
  const positions: Vec[] = safe.map((_, index) => twoColumns
    ? [index % 2 === 0 ? 285 : 715, 135 + Math.floor(index / 2) * 180]
    : [500, 115 + index * (390 / Math.max(1, safe.length - 1))]);
  const ops: BoardOp[] = safe.map((step, index) => ({ op: 'add', id: `${prefix}-step-${index}`, color: index === safe.length - 1 ? 'green' : 'blue', spec: { kind: 'box', at: positions[index], w: twoColumns ? 300 : 420, text: step } }));
  for (let index = 1; index < safe.length; index += 1) ops.push({ op: 'add', id: `${prefix}-flow-${index - 1}`, color: 'amber', spec: { kind: 'connector', from: `${prefix}-step-${index - 1}`, to: `${prefix}-step-${index}` } });
  return ops;
}

function comparisonTable(prefix: string, parameters: Record<string, unknown>): BoardOp[] {
  const leftTitle = stringParam(parameters, 'leftTitle', 'Option A');
  const rightTitle = stringParam(parameters, 'rightTitle', 'Option B');
  const left = stringArray(parameters.leftItems, ['First feature', 'Second feature']);
  const right = stringArray(parameters.rightItems, ['First feature', 'Second feature']);
  const rows = [[leftTitle, rightTitle]];
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) rows.push([left[index] ?? '—', right[index] ?? '—']);
  return [{ op: 'add', id: `${prefix}-comparison`, color: 'blue', spec: { kind: 'table', at: [300, 165], rows, headerRow: true } }];
}

function partWhole(prefix: string, parameters: Record<string, unknown>): BoardOp[] {
  const labels = stringArray(parameters.labels, ['Part A', 'Part B']);
  const values = numberArray(parameters.values, [1, 1]);
  const parts = labels.slice(0, 6).map((label, index) => ({ label, value: Math.max(0.01, values[index] ?? 0.01) }));
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  const colors = ['blue', 'amber', 'green', 'red', 'violet'] as const;
  const ops: BoardOp[] = [{ op: 'add', id: `${prefix}-whole-label`, color: 'ink', spec: { kind: 'text', at: [500, 175], text: stringParam(parameters, 'wholeLabel', 'The whole'), size: 'big', align: 'middle' } }];
  let x = 150;
  parts.forEach((part, index) => {
    const width = (part.value / total) * 700;
    const compact = width < 140;
    ops.push({
      op: 'add', id: `${prefix}-part-${index}`, color: colors[index % colors.length],
      spec: { kind: 'box', at: [x + width / 2, 310], w: width, h: 150, text: compact ? formatPartValue(part.value) : `${part.label}: ${formatPartValue(part.value)}` },
    });
    if (compact) ops.push({
      op: 'add', id: `${prefix}-part-label-${index}`, color: colors[index % colors.length],
      spec: { kind: 'label', target: `${prefix}-part-${index}`, side: 'below', text: `${part.label}: ${formatPartValue(part.value)}` },
    });
    x += width;
  });
  ops.push({ op: 'add', id: `${prefix}-total`, color: 'green', spec: { kind: 'equation', at: [400, 430], latex: `${parts.map((part) => formatPartValue(part.value)).join('+')}=${formatPartValue(total)}`, size: 'big' } });
  return ops;
}

interface RelationshipNode { id: string; label: string }
interface RelationshipEdge { from: string; to: string; label?: string }

function nodeRecords(value: unknown): RelationshipNode[] {
  if (!Array.isArray(value)) return [{ id: 'start', label: 'Start' }, { id: 'result', label: 'Result' }];
  const nodes: RelationshipNode[] = [];
  for (const [index, raw] of value.slice(0, 8).entries()) {
    if (typeof raw !== 'object' || raw === null) continue;
    const candidate = raw as { id?: unknown; label?: unknown };
    const id = String(candidate.id ?? `node-${index}`).replace(/[^a-z0-9_-]/gi, '-').slice(0, 40) || `node-${index}`;
    const label = String(candidate.label ?? id).trim().slice(0, 90);
    if (label && !nodes.some((node) => node.id === id)) nodes.push({ id, label });
  }
  return nodes.length > 0 ? nodes : [{ id: 'start', label: 'Start' }, { id: 'result', label: 'Result' }];
}

function edgeRecords(value: unknown, nodes: RelationshipNode[]): RelationshipEdge[] {
  const ids = new Set(nodes.map((node) => node.id));
  if (!Array.isArray(value)) return nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));
  return value.slice(0, 12).flatMap((raw): RelationshipEdge[] => {
    if (typeof raw !== 'object' || raw === null) return [];
    const candidate = raw as { from?: unknown; to?: unknown; label?: unknown };
    const from = String(candidate.from ?? ''); const to = String(candidate.to ?? '');
    if (!ids.has(from) || !ids.has(to) || from === to) return [];
    const label = String(candidate.label ?? '').trim().slice(0, 70);
    return [{ from, to, ...(label ? { label } : {}) }];
  });
}

function radialPositions(count: number): Vec[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (index / Math.max(1, count)) * Math.PI * 2;
    return [500 + Math.cos(angle) * 300, 300 + Math.sin(angle) * 195];
  });
}

function flowPositions(count: number): Vec[] {
  if (count <= 4) return Array.from({ length: count }, (_, index) => [160 + index * (680 / Math.max(1, count - 1)), 300]);
  return Array.from({ length: count }, (_, index) => [180 + (index % 4) * 215, index < 4 ? 190 : 420]);
}

function hierarchyPositions(nodes: RelationshipNode[], edges: RelationshipEdge[]): Vec[] {
  const rank = new Map(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass += 1) for (const edge of edges) {
    const next = Math.min(3, (rank.get(edge.from) ?? 0) + 1);
    if (next > (rank.get(edge.to) ?? 0)) rank.set(edge.to, next);
  }
  const maxRank = Math.max(...rank.values(), 0);
  return nodes.map((node) => {
    const level = rank.get(node.id) ?? 0;
    const peers = nodes.filter((candidate) => (rank.get(candidate.id) ?? 0) === level);
    const index = peers.findIndex((candidate) => candidate.id === node.id);
    return [180 + (index + 0.5) * (640 / peers.length), 120 + level * (360 / Math.max(1, maxRank))];
  });
}

function numberParam(parameters: Record<string, unknown>, key: string, fallback: number): number { const value = parameters[key]; return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function numberArray(value: unknown, fallback: number[]): number[] { return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)).slice(0, 6) : fallback; }
function stringArray(value: unknown, fallback: string[]): string[] { return Array.isArray(value) ? value.map(String).filter(Boolean).map((item) => item.slice(0, 80)).slice(0, 6) : fallback; }
function stringParam(parameters: Record<string, unknown>, key: string, fallback: string): string { const value = String(parameters[key] ?? '').trim(); return value ? value.slice(0, 90) : fallback; }
function formatPartValue(value: number): string { return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100); }
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
