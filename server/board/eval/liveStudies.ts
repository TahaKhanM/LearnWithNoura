import type OpenAI from 'openai';
import { validateOps, type BoardOp } from '../../../shared/boardOps.js';
import { DirectorVisionVerdictSchema } from '../directorSchema.js';
import { applyDirectorBoardPolicy } from '../directorSchema.js';
import type { HeadlessSceneValidatorHandle } from '../../lesson/headlessSceneValidator.js';
import { loadSeededDefects, materializeSketchCorpus, type SyntheticSketch } from './corpus.js';
import type { SeededDefect } from './types.js';
import { estimateTextCost } from './streamingProbe.js';
import { sketchCallReserveUsd, visionCallReserveUsd } from './budget.js';

export interface LiveStudySpend {
  beforeCall(estimatedMaxUsd: number): void;
  add(costUsd: number, upperBoundUsd?: number): void;
  noteCall(): void;
}

interface VisionAuditTrial {
  defectId: string;
  defectKind: SeededDefect['defectKind'];
  sample: 'defect' | 'clean_control';
  conditionId: string;
  latencyMs: number;
  expectedReject: boolean;
  rejected: boolean;
  caught: boolean;
  falseRejected: boolean;
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

export interface VisionAuditCandidateSummary {
  conditionId: string;
  model: 'gpt-5.6-terra' | 'gpt-5.6-luna';
  catchRate: number;
  falseRejectRate: number;
  invalidReplyRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  costUsd: number;
}

const AUDIT_MIN_CATCH_RATE = 0.8;
const AUDIT_MAX_FALSE_REJECT_RATE = 0.1;
const AUDIT_MAX_INVALID_REPLY_RATE = 0.05;
const AUDIT_NETWORK_MARGIN_MS = 250;
const AUDIT_MIN_BUDGET_MS = 1_500;
const AUDIT_MAX_BUDGET_MS = 5_000;
const AUDIT_BUDGET_INCREMENT_MS = 500;

/** Pre-registered audit adoption rule. Semantic detection is primary;
 * false rejects and junk replies are hard eligibility bars. The latency
 * budget is derived from the selected model's measured p95, not a constant. */
export function chooseVisionAuditDecision(candidates: VisionAuditCandidateSummary[]) {
  const eligible = candidates.filter((candidate) =>
    candidate.catchRate >= AUDIT_MIN_CATCH_RATE &&
    candidate.falseRejectRate <= AUDIT_MAX_FALSE_REJECT_RATE &&
    candidate.invalidReplyRate <= AUDIT_MAX_INVALID_REPLY_RATE &&
    candidate.p95LatencyMs + AUDIT_NETWORK_MARGIN_MS <= AUDIT_MAX_BUDGET_MS)
    .sort((left, right) =>
      right.catchRate - left.catchRate ||
      left.falseRejectRate - right.falseRejectRate ||
      left.invalidReplyRate - right.invalidReplyRate ||
      left.p95LatencyMs - right.p95LatencyMs ||
      left.costUsd - right.costUsd);
  const selected = eligible[0];
  if (!selected) {
    return {
      selectedConditionId: null,
      selectedModel: null,
      auditBudgetMs: 0,
      revealGate: 'deterministic_only' as const,
      minimumCatchRate: AUDIT_MIN_CATCH_RATE,
      maximumFalseRejectRate: AUDIT_MAX_FALSE_REJECT_RATE,
      maximumInvalidReplyRate: AUDIT_MAX_INVALID_REPLY_RATE,
      reason: 'No audit model cleared the pre-registered catch, false-reject, and valid-reply bars.',
    };
  }
  const budgetWithMargin = selected.p95LatencyMs + AUDIT_NETWORK_MARGIN_MS;
  const boundedBudget = Math.max(AUDIT_MIN_BUDGET_MS, budgetWithMargin);
  const auditBudgetMs = Math.ceil(boundedBudget / AUDIT_BUDGET_INCREMENT_MS) * AUDIT_BUDGET_INCREMENT_MS;
  return {
    selectedConditionId: selected.conditionId,
    selectedModel: selected.model,
    auditBudgetMs,
    revealGate: 'step1_budgeted' as const,
    minimumCatchRate: AUDIT_MIN_CATCH_RATE,
    maximumFalseRejectRate: AUDIT_MAX_FALSE_REJECT_RATE,
    maximumInvalidReplyRate: AUDIT_MAX_INVALID_REPLY_RATE,
    reason: `${selected.conditionId} cleared the audit quality bars; the budget covers its measured p95 plus a bounded network margin`,
  };
}

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
    const samples = [
      { sample: 'defect' as const, expectedReject: true, ops: seededDefectOps(defect) },
      { sample: 'clean_control' as const, expectedReject: false, ops: seededCleanOps(defect) },
    ];
    for (const sample of samples) {
      await assertDeterministicFixture(input.harness, defect, sample.sample, sample.ops);
      const raster = await input.harness.render(sample.ops, `audit-${defect.id}-${sample.sample}`);
      if (!raster) throw new Error(`Could not render seeded ${sample.sample} ${defect.id}.`);
      for (const condition of conditions) {
        const startedAt = performance.now();
        input.spend.beforeCall(visionCallReserveUsd(condition.model));
        input.spend.noteCall();
        const reserve = visionCallReserveUsd(condition.model);
        let response: OpenAI.Chat.Completions.ChatCompletion;
        try {
          response = await input.client.chat.completions.create({
          model: condition.model,
          reasoning_effort: 'low',
          max_completion_tokens: 500,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'noura_vision_audit', strict: true, schema: VERDICT_SCHEMA },
          },
          messages: [
            {
              role: 'system',
              content: 'Audit a synthetic educational board raster against its stated intent. Reject semantic mismatches including wrong shading, incorrect values, and reversed arrows. Approve a semantically correct raster. Return JSON only. Deterministic geometry checks have already passed.',
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
        } catch (error) {
          input.spend.add(0, reserve);
          throw error;
        }
        const text = response.choices[0]?.message?.content ?? '';
        const parsed = parseVision(text);
        const rejected = !parsed.approved;
        const costUsd = completionCost(condition.model, response.usage, text);
        input.spend.add(costUsd, response.usage ? costUsd : reserve);
        trials.push({
          defectId: defect.id,
          defectKind: defect.defectKind,
          sample: sample.sample,
          conditionId: condition.id,
          latencyMs: Math.round(performance.now() - startedAt),
          expectedReject: sample.expectedReject,
          rejected,
          caught: sample.expectedReject && rejected,
          falseRejected: !sample.expectedReject && rejected,
          validReply: parsed.valid,
          costUsd,
        });
      }
    }
  }
  const candidates: VisionAuditCandidateSummary[] = conditions.map((condition) => {
    const rows = trials.filter((trial) => trial.conditionId === condition.id);
    const defectRows = rows.filter((trial) => trial.sample === 'defect');
    const cleanRows = rows.filter((trial) => trial.sample === 'clean_control');
    return {
      conditionId: condition.id,
      model: condition.model,
      catchRate: ratio(defectRows.filter((row) => row.caught).length, defectRows.length),
      falseRejectRate: ratio(cleanRows.filter((row) => row.falseRejected).length, cleanRows.length),
      invalidReplyRate: ratio(rows.filter((row) => !row.validReply).length, rows.length),
      p50LatencyMs: percentile(rows.map((row) => row.latencyMs), 0.5),
      p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 0.95),
      costUsd: sum(rows.map((row) => row.costUsd)),
    };
  });
  const decision = chooseVisionAuditDecision(candidates);
  return {
    seededDefectCount: defects.length,
    cleanControlCount: defects.length,
    deterministicCatchRate: 0,
    deterministicFalseRejectRate: 0,
    candidates,
    trials,
    decision,
    auditBudgetMs: decision.auditBudgetMs,
  };
}

export async function runLiveSketchStudy(input: {
  client: OpenAI;
  harness: HeadlessSceneValidatorHandle;
  spend: LiveStudySpend;
}) {
  const sketches = materializeSketchCorpus();
  const conditions = [
    { id: 'terra-low', model: 'gpt-5.6-terra' as const },
    { id: 'luna-low', model: 'gpt-5.6-luna' as const },
  ];
  const allowed = [...new Set(sketches.map((entry) => entry.expectedInterpretation))];
  const rows: SketchStudyRow[] = [];
  for (const sketch of sketches) {
    const raster = await renderSyntheticSketchRaster(input.harness, sketch);
    if (!raster) throw new Error(`Could not render synthetic sketch ${sketch.id} through the board harness.`);
    for (const condition of conditions) {
      input.spend.beforeCall(sketchCallReserveUsd(condition.model));
      input.spend.noteCall();
      const reserve = sketchCallReserveUsd(condition.model);
      let response: OpenAI.Chat.Completions.ChatCompletion;
      try {
        response = await input.client.chat.completions.create({
        model: condition.model,
        reasoning_effort: 'low',
        max_completion_tokens: 300,
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
              { type: 'image_url', image_url: { url: raster, detail: 'high' } },
            ],
          },
        ],
        });
      } catch (error) {
        input.spend.add(0, reserve);
        throw error;
      }
      const text = response.choices[0]?.message?.content ?? '';
      const parsed = parseSketch(text);
      const correct = normalize(parsed.interpretation) === normalize(sketch.expectedInterpretation);
      const costUsd = completionCost(condition.model, response.usage, text);
      input.spend.add(costUsd, response.usage ? costUsd : reserve);
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
  const assistedAccuracy = ratio(assisted.filter(Boolean).length, assisted.length);
  const terraCorrect = sketches.map((sketch) => rows.find((row) =>
    row.sketchId === sketch.id && row.conditionId === 'terra-low')?.correct ?? false);
  const assistDecision = pairedAssistDecision(terraCorrect, assisted);
  return {
    itemCount: sketches.length,
    candidates,
    assistedAccuracy,
    cheaperModelAssistGain: assistDecision.gain,
    significantGainThreshold: 0.05,
    pairedImprovementPValue: assistDecision.pValue,
    statisticallySignificant: assistDecision.statisticallySignificant,
    assistDecisionEligibleForCheckGrading: false,
    cheaperModelAssistDefault: 'off' as const,
    decisionReason: 'This synthetic corpus measures sketch interpretation, not semantic check grading; it cannot authorize a grading assist.',
    rows,
  };
}

export function pairedAssistDecision(terraCorrect: boolean[], assistedCorrect: boolean[]) {
  if (terraCorrect.length === 0 || terraCorrect.length !== assistedCorrect.length) {
    throw new Error('Paired sketch results must have the same non-zero length.');
  }
  let improved = 0;
  let regressed = 0;
  for (let index = 0; index < terraCorrect.length; index += 1) {
    if (!terraCorrect[index] && assistedCorrect[index]) improved += 1;
    else if (terraCorrect[index] && !assistedCorrect[index]) regressed += 1;
  }
  const gain = ratio(
    assistedCorrect.filter(Boolean).length - terraCorrect.filter(Boolean).length,
    terraCorrect.length,
  );
  const pValue = oneSidedBinomialTail(improved, improved + regressed);
  const statisticallySignificant = pValue < 0.05;
  return {
    gain,
    improved,
    regressed,
    pValue,
    statisticallySignificant,
    adopt: gain >= 0.05 && statisticallySignificant,
  };
}

function oneSidedBinomialTail(successes: number, trials: number): number {
  if (trials === 0) return 1;
  let probability = 0;
  for (let value = successes; value <= trials; value += 1) {
    probability += combinations(trials, value) * 0.5 ** trials;
  }
  return Math.round(probability * 1e6) / 1e6;
}

function combinations(n: number, k: number): number {
  const choose = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= choose; index += 1) {
    result = (result * (n - choose + index)) / index;
  }
  return result;
}

export function seededDefectOps(defect: SeededDefect): BoardOp[] {
  return defect.defectOps;
}

export function seededCleanOps(defect: SeededDefect): BoardOp[] {
  return defect.cleanOps;
}

export function syntheticSketchOps(sketch: SyntheticSketch): BoardOp[] {
  return [{
    op: 'add',
    id: `synthetic-sketch-${sketch.id}`,
    color: 'ink',
    spec: { kind: 'path', points: sketch.points, width: 10 },
  }];
}

export async function renderSyntheticSketchRaster(
  harness: HeadlessSceneValidatorHandle,
  sketch: SyntheticSketch,
): Promise<string | null> {
  return harness.render(syntheticSketchOps(sketch), `sketch-${sketch.id}`);
}

function validateAuthoredFixture(ops: BoardOp[]): boolean {
  const { ops: accepted, rejected } = validateOps(ops, { tier: 'authored' });
  return rejected.length === 0 && accepted.length === ops.length;
}

async function assertDeterministicFixture(
  harness: HeadlessSceneValidatorHandle,
  defect: SeededDefect,
  sample: 'defect' | 'clean_control',
  ops: BoardOp[],
): Promise<void> {
  if (!validateAuthoredFixture(ops)) {
    throw new Error(`Seeded ${sample} ${defect.id} failed authored validation.`);
  }
  const policy = applyDirectorBoardPolicy(ops, { density: 'standard', visibleObjectIds: [] });
  if (!policy.ok || policy.ops.length !== ops.length) {
    throw new Error(`Seeded ${sample} ${defect.id} failed Director policy.`);
  }
  const preflight = await harness.validate(ops);
  if (!preflight.ok) {
    throw new Error(`Seeded ${sample} ${defect.id} failed browser preflight: ${preflight.issues.join('; ')}`);
  }
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
    cacheWriteTokens: usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
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
