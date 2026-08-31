import type OpenAI from 'openai';
import rubric from './fixtures/director-raster-rubric.json' with { type: 'json' };
import { createHeadlessSceneValidator } from '../../lesson/headlessSceneValidator.js';
import { applyDirectorBoardPolicy, buildDirectedScene, DirectorProposalSchema } from '../directorSchema.js';
import { DIRECTOR_EVAL_CONDITIONS, loadDirectorEvalCorpus } from './corpus.js';
import { chooseCompositionWinner } from './decision.js';
import { runLiveSketchStudy, runLiveVisionAudit, type LiveStudySpend } from './liveStudies.js';
import { estimateTextCost, runStreamingProbe, type StreamingProbeResult } from './streamingProbe.js';
import type { ConditionSummary, DirectorEvalCondition, DirectorEvalIntent, DirectorEvalTrial } from './types.js';

const LIVE_TRIALS = 5;
const COMPOSITION_CALL_RESERVE_USD = 0.08;
const JUDGE_CALL_RESERVE_USD = 0.06;

export class SpendGuard implements LiveStudySpend {
  estimatedCostUsd = 0;
  providerCalls = 0;

  constructor(readonly maxSpendUsd: number) {}

  beforeCall(estimatedMaxUsd: number): void {
    if (this.estimatedCostUsd + estimatedMaxUsd > this.maxSpendUsd) {
      throw new SpendCapError(`The next provider call could cross the $${this.maxSpendUsd} spend cap.`);
    }
  }

  add(costUsd: number): void {
    this.estimatedCostUsd = round(this.estimatedCostUsd + Math.max(0, costUsd), 8);
    if (this.estimatedCostUsd > this.maxSpendUsd) {
      throw new SpendCapError(`Observed estimated cost crossed the $${this.maxSpendUsd} spend cap.`);
    }
  }

  noteCall(): void { this.providerCalls += 1; }
}

class SpendCapError extends Error {
  constructor(message: string) { super(message); this.name = 'SpendCapError'; }
}

export async function runLiveDirectorEval(input: {
  client: OpenAI;
  harnessUrl: string;
  maxSpendUsd: number;
  onProgress?: (message: string) => void;
}) {
  const corpus = loadDirectorEvalCorpus();
  const spend = new SpendGuard(input.maxSpendUsd);
  const harness = createHeadlessSceneValidator({ harnessUrl: input.harnessUrl });
  const trials: DirectorEvalTrial[] = [];
  let visionAudit: Awaited<ReturnType<typeof runLiveVisionAudit>> | null = null;
  let sketchGrounding: Awaited<ReturnType<typeof runLiveSketchStudy>> | null = null;
  let stopReason: string | null = null;
  try {
    conditionLoop:
    for (const condition of DIRECTOR_EVAL_CONDITIONS) {
      for (const intent of corpus) {
        for (const cacheState of ['cold', 'warm'] as const) {
          for (let trial = 1; trial <= LIVE_TRIALS; trial += 1) {
            input.onProgress?.(`[director-eval] ${condition.id} ${intent.id} ${cacheState} ${trial}/${LIVE_TRIALS}`);
            trials.push(await runCompositionTrial({
              client: input.client,
              harness,
              spend,
              condition,
              intent,
              cacheState,
              trial,
            }));
          }
        }
      }
      const completed = summarizeCompletedConditions(trials, corpus.length);
      const dominant = conditionDominatingByMoreThan2x(completed);
      if (dominant) {
        stopReason = `pre_registered_dominance:${dominant}`;
        break conditionLoop;
      }
    }
    visionAudit = await runLiveVisionAudit({ client: input.client, harness, spend });
    sketchGrounding = await runLiveSketchStudy({ client: input.client, spend });
  } catch (error) {
    if (error instanceof SpendCapError) stopReason = `spend_cap:${error.message}`;
    else throw error;
  } finally {
    await harness.close();
  }

  const conditionSummaries = summarizeCompletedConditions(trials, corpus.length);
  const completeComposition = conditionSummaries.length === DIRECTOR_EVAL_CONDITIONS.length || stopReason?.startsWith('pre_registered_dominance:');
  const pass = Boolean(completeComposition && visionAudit && sketchGrounding && !stopReason?.startsWith('spend_cap:'));
  return {
    schemaVersion: '1.0.0' as const,
    pass,
    evidenceMode: 'authorized_live_synthetic' as const,
    evidenceBoundary: 'Synthetic checked-in intents and synthetic board/sketch rasters only; no child data. Provider latency and output quality are live for this run; browser validation is the configured local board harness.',
    realChildData: false as const,
    providerCalls: spend.providerCalls,
    estimatedCostUsd: spend.estimatedCostUsd,
    maxSpendUsd: spend.maxSpendUsd,
    costSource: 'official_rate_card_estimate_from_provider_token_usage; aborted hedge legs use observed-partial token estimate' as const,
    pricingSource: 'https://developers.openai.com/api/docs/models/compare (checked 2026-08-30)',
    stoppedEarly: stopReason,
    corpus: {
      representative: corpus.filter((entry) => entry.split === 'representative').length,
      holdout: corpus.filter((entry) => entry.split === 'holdout').length,
      total: corpus.length,
    },
    conditions: DIRECTOR_EVAL_CONDITIONS,
    trials,
    conditionSummaries,
    compositionDecision: {
      status: 'authorized_live_evidence' as const,
      ...chooseCompositionWinner(conditionSummaries),
    },
    visionAudit,
    sketchGrounding,
    rasterRubric: rubric,
  };
}

async function runCompositionTrial(input: {
  client: OpenAI;
  harness: ReturnType<typeof createHeadlessSceneValidator>;
  spend: SpendGuard;
  condition: DirectorEvalCondition;
  intent: DirectorEvalIntent;
  cacheState: 'cold' | 'warm';
  trial: number;
}): Promise<DirectorEvalTrial> {
  const trialKey = `${input.condition.id}:${input.intent.id}:${input.cacheState}:${input.trial}`;
  const probe = await runConditionProbe(input, trialKey);
  input.spend.add(probe.estimatedCostUsd);
  let strictSchemaValid = false;
  let validatorPassed = false;
  let storyboardCoverage = false;
  let qualityGrade = 1;
  try {
    const proposal = DirectorProposalSchema.parse(JSON.parse(probe.text));
    strictSchemaValid = true;
    const policy = applyDirectorBoardPolicy(proposal.ops, {
      density: input.intent.density,
      visibleObjectIds: [],
    });
    if (policy.ok) {
      const scene = buildDirectedScene({
        groupId: `eval-${input.intent.id}`.replace(/[^a-z0-9_-]/gi, '-').slice(0, 80),
        groupLabel: proposal.groupLabel,
        ops: policy.ops,
        storyboard: proposal.storyboard,
      });
      storyboardCoverage = true;
      const validation = await input.harness.validate(scene.ops);
      validatorPassed = validation.ok;
      if (validation.ok) {
        const raster = await input.harness.render(scene.ops, scene.groupId);
        if (raster) qualityGrade = await blindRasterGrade(input.client, input.spend, input.intent, raster);
      }
    }
  } catch {
    // First-pass validity metrics deliberately retain malformed/rejected rows.
  }
  return {
    intentId: input.intent.id,
    split: input.intent.split,
    conditionId: input.condition.id,
    cacheState: input.cacheState,
    trial: input.trial,
    ttftMs: probe.ttftMs,
    firstValidOpMs: probe.firstValidOpMs,
    completeSceneMs: probe.completeMs,
    strictSchemaValid,
    validatorPassed,
    storyboardCoverage,
    qualityGrade,
    cachedInputTokens: probe.usage.cachedInputTokens,
    costUsd: probe.estimatedCostUsd,
  };
}

async function runConditionProbe(
  input: Parameters<typeof runCompositionTrial>[0],
  trialKey: string,
): Promise<StreamingProbeResult> {
  if (input.condition.legs.length === 1) {
    input.spend.beforeCall(COMPOSITION_CALL_RESERVE_USD);
    input.spend.noteCall();
    const leg = input.condition.legs[0];
    return runStreamingProbe({
      client: input.client,
      intent: input.intent,
      model: leg.model,
      reasoningEffort: leg.reasoningEffort,
      cacheState: input.cacheState,
      trialKey,
    });
  }
  input.spend.beforeCall(COMPOSITION_CALL_RESERVE_USD * input.condition.legs.length);
  const controllers = input.condition.legs.map(() => new AbortController());
  let winner = -1;
  const promises = input.condition.legs.map((leg, index) => {
    input.spend.noteCall();
    return runStreamingProbe({
      client: input.client,
      intent: input.intent,
      model: leg.model,
      reasoningEffort: leg.reasoningEffort,
      cacheState: input.cacheState,
      trialKey: `${trialKey}:leg-${index}`,
      signal: controllers[index].signal,
      onFirstValidOp: () => {
        if (winner >= 0) return;
        winner = index;
        controllers.forEach((controller, candidate) => { if (candidate !== index) controller.abort('hedge lost'); });
      },
    });
  });
  const results = await Promise.all(promises);
  if (winner < 0) winner = results.map((result) => result.firstValidOpMs).indexOf(Math.min(...results.map((result) => result.firstValidOpMs)));
  const chosen = results[Math.max(0, winner)];
  return {
    ...chosen,
    estimatedCostUsd: round(results.reduce((total, result) => total + result.estimatedCostUsd, 0), 8),
    usage: {
      inputTokens: results.reduce((total, result) => total + result.usage.inputTokens, 0),
      cachedInputTokens: results.reduce((total, result) => total + result.usage.cachedInputTokens, 0),
      outputTokens: results.reduce((total, result) => total + result.usage.outputTokens, 0),
    },
  };
}

async function blindRasterGrade(client: OpenAI, spend: SpendGuard, intent: DirectorEvalIntent, raster: string): Promise<number> {
  spend.beforeCall(JUDGE_CALL_RESERVE_USD);
  spend.noteCall();
  const response = await client.chat.completions.create({
    model: rubric.judgeModel,
    reasoning_effort: rubric.judgeReasoningEffort as 'low',
    max_completion_tokens: 800,
    prompt_cache_key: 'noura-director-raster-rubric-v1',
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'noura_director_raster_grade',
        strict: true,
        schema: {
          type: 'object', additionalProperties: false,
          properties: { grade: { type: 'number', minimum: 1, maximum: 5 }, reasons: { type: 'array', maxItems: 5, items: { type: 'string' } } },
          required: ['grade', 'reasons'],
        },
      },
    },
    messages: [
      { role: 'system', content: `Blindly grade an educational board raster from 1 to 5. Apply this fixed rubric: ${JSON.stringify(rubric.dimensions)}. Do not infer which model produced it. Return JSON only.` },
      { role: 'user', content: [{ type: 'text', text: `Requested idea: ${intent.intent}` }, { type: 'image_url', image_url: { url: raster, detail: 'high' } }] },
    ],
  });
  const text = response.choices[0]?.message?.content ?? '';
  const usage = response.usage;
  spend.add(estimateTextCost('gpt-5.6-terra', {
    inputTokens: usage?.prompt_tokens ?? 0,
    cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  }, text));
  try {
    const parsed = JSON.parse(text) as { grade?: unknown };
    return typeof parsed.grade === 'number' && Number.isFinite(parsed.grade)
      ? Math.max(1, Math.min(5, parsed.grade))
      : 1;
  } catch {
    return 1;
  }
}

function summarizeCompletedConditions(trials: DirectorEvalTrial[], intentCount: number): ConditionSummary[] {
  const expected = intentCount * 2 * LIVE_TRIALS;
  return DIRECTOR_EVAL_CONDITIONS.flatMap((condition): ConditionSummary[] => {
    const rows = trials.filter((trial) => trial.conditionId === condition.id);
    if (rows.length !== expected) return [];
    const valid = rows.filter((row) => row.strictSchemaValid && row.validatorPassed && row.storyboardCoverage);
    return [{
      conditionId: condition.id,
      firstPassValidity: ratio(valid.length, rows.length),
      qualityGrade: round(mean(valid.map((row) => row.qualityGrade)), 2),
      p50FirstValidOpMs: percentile(valid.map((row) => row.firstValidOpMs), 0.5),
      meanCostUsd: round(mean(rows.map((row) => row.costUsd)), 8),
    }];
  });
}

function conditionDominatingByMoreThan2x(summaries: ConditionSummary[]): string | null {
  if (summaries.length < 2) return null;
  return summaries.find((candidate) => summaries.every((other) => candidate === other || (
    candidate.p50FirstValidOpMs * 2 < other.p50FirstValidOpMs &&
    candidate.meanCostUsd * 2 < other.meanCostUsd &&
    candidate.firstPassValidity >= other.firstPassValidity &&
    candidate.qualityGrade >= other.qualityGrade
  )))?.conditionId ?? null;
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] ?? 0;
}
function mean(values: number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function ratio(numerator: number, denominator: number): number { return denominator === 0 ? 0 : round(numerator / denominator, 4); }
function round(value: number, digits: number): number { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
