import type OpenAI from 'openai';
import type { BoardOp } from '../../../shared/boardOps.js';
import { DirectorVisionVerdictSchema } from '../directorSchema.js';
import type { HeadlessSceneValidatorHandle } from '../../lesson/headlessSceneValidator.js';
import { loadSeededDefects, materializeSketchCorpus, type SyntheticSketch } from './corpus.js';
import type { SeededDefect } from './types.js';
import { estimateTextCost } from './streamingProbe.js';

export interface LiveStudySpend {
  beforeCall(estimatedMaxUsd: number): void;
  add(costUsd: number): void;
  noteCall(): void;
}

interface VisionAuditTrial {
  defectId: string;
  defectKind: SeededDefect['defectKind'];
  conditionId: string;
  latencyMs: number;
  caught: boolean;
  validReply: boolean;
  costUsd: number;
}

interface SketchStudyRow {
  sketchId: string;
  conditionId: string;
  interpretation: string;
  confidence: number;
  validReply: boolean;
  correct: boolean;
  costUsd: number;
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    approved: { type: 'boolean' },
    issues: { type: 'array', maxItems: 8, items: { type: 'string' } },
  },
  required: ['approved', 'issues'],
} as const;

const SKETCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    interpretation: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['interpretation', 'confidence'],
} as const;

export async function runLiveVisionAudit(input: {
  client: OpenAI;
  harness: HeadlessSceneValidatorHandle;
  spend: LiveStudySpend;
}) {
  const defects = loadSeededDefects();
  const conditions = [
    { id: 'terra-low', model: 'gpt-5.6-terra' as const },
    { id: 'luna-low', model: 'gpt-5.6-luna' as const },
  ];
  const trials: VisionAuditTrial[] = [];
  for (const defect of defects) {
    const raster = await input.harness.render(seededDefectOps(defect), `audit-${defect.id}`);
    if (!raster) throw new Error(`Could not render seeded defect ${defect.id}.`);
    for (const condition of conditions) {
      const startedAt = performance.now();
      input.spend.beforeCall(0.04);
      input.spend.noteCall();
      const response = await input.client.chat.completions.create({
        model: condition.model,
        reasoning_effort: 'low',
        max_completion_tokens: 800,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'noura_vision_audit', strict: true, schema: VERDICT_SCHEMA },
        },
        messages: [
          {
            role: 'system',
            content: 'Audit a synthetic educational board raster against its stated intent. Reject semantic mismatches including wrong shading, incorrect values, and reversed arrows. Return JSON only. Deterministic geometry checks have already passed.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Intent: ${defect.intent}` },
              { type: 'image_url', image_url: { url: raster, detail: 'high' } },
            ],
          },
        ],
      });
      const text = response.choices[0]?.message?.content ?? '';
      const parsed = parseVision(text);
      const costUsd = completionCost(condition.model, response.usage, text);
      input.spend.add(costUsd);
      trials.push({
        defectId: defect.id,
        defectKind: defect.defectKind,
        conditionId: condition.id,
        latencyMs: Math.round(performance.now() - startedAt),
        caught: !parsed.approved,
        validReply: parsed.valid,
        costUsd,
      });
    }
  }
  const candidates = conditions.map((condition) => {
    const rows = trials.filter((trial) => trial.conditionId === condition.id);
    return {
      conditionId: condition.id,
      model: condition.model,
      catchRate: ratio(rows.filter((row) => row.caught).length, rows.length),
      invalidReplyRate: ratio(rows.filter((row) => !row.validReply).length, rows.length),
      p50LatencyMs: percentile(rows.map((row) => row.latencyMs), 0.5),
      p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 0.95),
      costUsd: sum(rows.map((row) => row.costUsd)),
    };
  });
  return {
    seededDefectCount: defects.length,
    deterministicCatchRate: 0,
    candidates,
    trials,
    auditBudgetMs: 3_500,
  };
}

export async function runLiveSketchStudy(input: { client: OpenAI; spend: LiveStudySpend }) {
  const sketches = materializeSketchCorpus();
  const conditions = [
    { id: 'terra-low', model: 'gpt-5.6-terra' as const },
    { id: 'luna-low', model: 'gpt-5.6-luna' as const },
  ];
  const allowed = [...new Set(sketches.map((entry) => entry.expectedInterpretation))];
  const rows: SketchStudyRow[] = [];
  for (const sketch of sketches) {
    for (const condition of conditions) {
      input.spend.beforeCall(0.025);
      input.spend.noteCall();
      const response = await input.client.chat.completions.create({
        model: condition.model,
        reasoning_effort: 'low',
        max_completion_tokens: 500,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'noura_sketch_interpretation', strict: true, schema: SKETCH_SCHEMA },
        },
        messages: [
          {
            role: 'system',
            content: `Interpret one synthetic rough board sketch. Choose exactly one label from: ${allowed.join(', ')}. Confidence is calibrated probability, not certainty. Return JSON only.`,
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'No child data is present. Interpret this synthetic jittered sketch.' },
              { type: 'image_url', image_url: { url: sketchSvgDataUrl(sketch), detail: 'high' } },
            ],
          },
        ],
      });
      const text = response.choices[0]?.message?.content ?? '';
      const parsed = parseSketch(text);
      const correct = normalize(parsed.interpretation) === normalize(sketch.expectedInterpretation);
      const costUsd = completionCost(condition.model, response.usage, text);
      input.spend.add(costUsd);
      rows.push({
        sketchId: sketch.id,
        conditionId: condition.id,
        interpretation: parsed.interpretation,
        confidence: parsed.confidence,
        validReply: parsed.valid,
        correct,
        costUsd,
      });
    }
  }
  const candidates = conditions.map((condition) => summarizeSketchRows(
    condition.id,
    rows.filter((row) => row.conditionId === condition.id),
  ));
  const assisted = sketches.map((sketch) => {
    const terra = rows.find((row) => row.sketchId === sketch.id && row.conditionId === 'terra-low');
    const luna = rows.find((row) => row.sketchId === sketch.id && row.conditionId === 'luna-low');
    if (!terra || !luna) return false;
    const selected = luna.confidence >= terra.confidence + 0.15 ? luna : terra;
    return selected.correct;
  });
  const terraAccuracy = candidates.find((entry) => entry.conditionId === 'terra-low')?.accuracy ?? 0;
  const assistedAccuracy = ratio(assisted.filter(Boolean).length, assisted.length);
  const gain = assistedAccuracy - terraAccuracy;
  return {
    itemCount: sketches.length,
    candidates,
    assistedAccuracy,
    cheaperModelAssistGain: gain,
    significantGainThreshold: 0.05,
    cheaperModelAssistDefault: gain >= 0.05 ? 'on' : 'off',
    rows,
  };
}

export function seededDefectOps(defect: SeededDefect): BoardOp[] {
  if (defect.defectKind === 'mislabeled_value') {
    return [{
      op: 'add', id: `defect-${defect.id}`, spec: {
        kind: 'numberline', at: [150, 320], w: 700, min: 0, max: 1, step: 0.25,
        marks: [{ value: 0.75, label: '2/3', color: 'red' }],
      },
    }];
  }
  if (defect.defectKind === 'reversed_arrow') {
    return [
      { op: 'add', id: `defect-${defect.id}-from`, spec: { kind: 'box', at: [280, 300], text: 'cause / source' } },
      { op: 'add', id: `defect-${defect.id}-to`, spec: { kind: 'box', at: [720, 300], text: 'effect / destination' } },
      { op: 'add', id: `defect-${defect.id}-arrow`, color: 'red', spec: { kind: 'line', from: [650, 300], to: [350, 300], arrow: 'end' } },
    ];
  }
  return Array.from({ length: 5 }, (_, index): BoardOp => ({
    op: 'add',
    id: `defect-${defect.id}-part-${index}`,
    color: index < 2 ? 'blue' : 'ink',
    spec: {
      kind: 'polygon',
      points: [[180 + index * 125, 240], [295 + index * 125, 240], [295 + index * 125, 360], [180 + index * 125, 360]],
      closed: true,
      ...(index < 2 ? { fill: true } : {}),
    },
  }));
}

export function sketchSvgDataUrl(sketch: SyntheticSketch): string {
  const points = sketch.points.map(([x, y]) => `${x},${y}`).join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600" viewBox="0 0 1000 600"><rect width="1000" height="600" fill="#fcfbf7"/><polyline points="${points}" fill="none" stroke="#26231f" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function parseVision(text: string): { approved: boolean; valid: boolean } {
  try {
    const parsed = DirectorVisionVerdictSchema.parse(JSON.parse(text));
    return { approved: parsed.approved, valid: true };
  } catch {
    return { approved: false, valid: false };
  }
}

function parseSketch(text: string): { interpretation: string; confidence: number; valid: boolean } {
  try {
    const parsed = JSON.parse(text) as { interpretation?: unknown; confidence?: unknown };
    if (typeof parsed.interpretation !== 'string' || typeof parsed.confidence !== 'number' || !Number.isFinite(parsed.confidence)) throw new Error('invalid');
    return { interpretation: parsed.interpretation.slice(0, 120), confidence: Math.max(0, Math.min(1, parsed.confidence)), valid: true };
  } catch {
    return { interpretation: '', confidence: 0, valid: false };
  }
}

function completionCost(model: 'gpt-5.6-terra' | 'gpt-5.6-luna', usage: OpenAI.Completions.CompletionUsage | undefined, text: string): number {
  return estimateTextCost(model, {
    inputTokens: usage?.prompt_tokens ?? 0,
    cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  }, text);
}

function summarizeSketchRows(conditionId: string, rows: Array<{ correct: boolean; confidence: number; validReply: boolean; costUsd: number }>) {
  return {
    conditionId,
    accuracy: ratio(rows.filter((row) => row.correct).length, rows.length),
    brierScore: ratio(rows.reduce((total, row) => total + (row.confidence - (row.correct ? 1 : 0)) ** 2, 0), rows.length),
    invalidReplyRate: ratio(rows.filter((row) => !row.validReply).length, rows.length),
    costUsd: sum(rows.map((row) => row.costUsd)),
  };
}

function normalize(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, ' '); }
function ratio(numerator: number, denominator: number): number { return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 10_000; }
function sum(values: number[]): number { return Math.round(values.reduce((total, value) => total + value, 0) * 1e8) / 1e8; }
function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] ?? 0;
}
