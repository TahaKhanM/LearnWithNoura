import { describe, expect, it, vi } from 'vitest';
import { validateOps } from '../../../shared/boardOps.js';
import { loadSeededDefects, materializeSketchCorpus } from './corpus.js';
import {
  chooseVisionAuditDecision,
  pairedAssistDecision,
  renderSyntheticSketchRaster,
  runAccountedChatCompletion,
  runLiveSketchStudy,
  runLiveVisionAudit,
  seededCleanOps,
  seededDefectOps,
  syntheticSketchOps,
} from './liveStudies.js';
import { LiveSpendLedger } from './spendLedger.js';

describe('Drawing vNext live audit and sketch evidence', () => {
  it('paces and accounts bounded retries for non-streaming study calls', async () => {
    const ledger = new LiveSpendLedger(1);
    let attempts = 0;
    const result = await runAccountedChatCompletion({
      spend: ledger,
      phase: 'judge',
      model: 'gpt-5.6-luna',
      reserveUsd: 0.01,
      retryDelay: async () => undefined,
      request: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('terminated');
        return {
          choices: [{ message: { content: '{"grade":4,"reasons":[]}' } }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          },
        } as never;
      },
    });
    expect(result.response.choices[0]?.message.content).toContain('grade');
    expect(ledger.providerCalls).toBe(2);
    expect(ledger.entries.filter((entry) => entry.status === 'failed')).toHaveLength(1);
  });

  it('loads twelve exact validator-clean defect/control pairs', () => {
    const defects = loadSeededDefects();
    expect(defects).toHaveLength(12);
    for (const defect of defects) {
      const defectOps = seededDefectOps(defect);
      const cleanOps = seededCleanOps(defect);
      expect(defectOps).not.toEqual(cleanOps);
      const defectValidation = validateOps(defectOps, { tier: 'authored' });
      const cleanValidation = validateOps(cleanOps, { tier: 'authored' });
      expect(defectValidation.rejected).toEqual([]);
      expect(defectValidation.ops).toHaveLength(defectOps.length);
      expect(cleanValidation.rejected).toEqual([]);
      expect(cleanValidation.ops).toHaveLength(cleanOps.length);
      if (defect.defectKind !== 'wrong_shading') {
        expect(defectOps.map((op) => op.op === 'add' ? [op.id, op.color, op.spec.kind] : [op.op]))
          .toEqual(cleanOps.map((op) => op.op === 'add' ? [op.id, op.color, op.spec.kind] : [op.op]));
      }
    }
  });

  it('derives the audit model, latency budget, and gate from catch and false-reject evidence', () => {
    const decision = chooseVisionAuditDecision([
      {
        conditionId: 'terra-low', model: 'gpt-5.6-terra', catchRate: 0.92,
        falseRejectRate: 0.08, invalidReplyRate: 0, p50LatencyMs: 2_200,
        p95LatencyMs: 3_180, costUsd: 0.2,
      },
      {
        conditionId: 'luna-low', model: 'gpt-5.6-luna', catchRate: 0.83,
        falseRejectRate: 0, invalidReplyRate: 0, p50LatencyMs: 1_400,
        p95LatencyMs: 2_960, costUsd: 0.04,
      },
    ]);
    expect(decision).toEqual({
      selectedConditionId: 'terra-low',
      selectedModel: 'gpt-5.6-terra',
      auditBudgetMs: 3_500,
      revealGate: 'step1_budgeted',
      minimumCatchRate: 0.8,
      maximumFalseRejectRate: 0.1,
      maximumInvalidReplyRate: 0.05,
      reason: 'terra-low cleared the audit quality bars; the budget covers its measured p95 plus a bounded network margin',
    });

    expect(chooseVisionAuditDecision([{
      conditionId: 'luna-low', model: 'gpt-5.6-luna', catchRate: 0.75,
      falseRejectRate: 0.25, invalidReplyRate: 0, p50LatencyMs: 1_000,
      p95LatencyMs: 1_400, costUsd: 0.01,
    }])).toMatchObject({
      selectedConditionId: null,
      selectedModel: null,
      auditBudgetMs: 0,
      revealGate: 'deterministic_only',
    });
    expect(chooseVisionAuditDecision([{
      conditionId: 'terra-low', model: 'gpt-5.6-terra', catchRate: 0.95,
      falseRejectRate: 0, invalidReplyRate: 0, p50LatencyMs: 4_000,
      p95LatencyMs: 5_100, costUsd: 0.2,
    }])).toMatchObject({ selectedConditionId: null, revealGate: 'deterministic_only' });
  });

  it('represents each synthetic sketch as one learner path for harness rendering', () => {
    const sketch = materializeSketchCorpus()[0];
    expect(syntheticSketchOps(sketch)).toEqual([{
      op: 'add',
      id: `synthetic-sketch-${sketch.id}`,
      color: 'ink',
      spec: { kind: 'path', points: sketch.points, width: 4 },
    }]);
  });

  it('will render sketch rasters through the supplied board harness', async () => {
    const sketch = materializeSketchCorpus()[0];
    const render = vi.fn(async () => 'data:image/jpeg;base64,c2tldGNo');
    const harness = { render } as never;
    await expect(renderSyntheticSketchRaster(harness, sketch)).resolves.toBe('data:image/jpeg;base64,c2tldGNo');
    expect(render).toHaveBeenCalledWith(syntheticSketchOps(sketch), `sketch-${sketch.id}`);
  });

  it('measures defect catches and matched-control false rejects before selecting the gate', async () => {
    const render = vi.fn(async (_ops, groupId: string) => groupId.endsWith('clean_control')
      ? 'data:image/jpeg;base64,Y2xlYW4='
      : 'data:image/jpeg;base64,ZGVmZWN0');
    const create = vi.fn(async (request: { messages: Array<{ content?: unknown }> }) => {
      const content = request.messages[1]?.content as Array<{ type: string; image_url?: { url: string } }>;
      const clean = content.find((part) => part.type === 'image_url')?.image_url?.url.endsWith('Y2xlYW4=') === true;
      return {
        choices: [{ message: { content: JSON.stringify({ approved: clean, issues: clean ? [] : ['seeded mismatch'] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 0 } },
      };
    });
    const spend = new LiveSpendLedger(30);
    const report = await runLiveVisionAudit({
      client: { chat: { completions: { create } } } as never,
      harness: { render, validate: async () => ({ ok: true }) } as never,
      spend,
    });

    expect(render).toHaveBeenCalledTimes(24);
    expect(create).toHaveBeenCalledTimes(48);
    expect(report.seededDefectCount).toBe(12);
    expect(report.cleanControlCount).toBe(12);
    expect(report.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ catchRate: 1, falseRejectRate: 0, invalidReplyRate: 0 }),
    ]));
    expect(report.decision).toMatchObject({ revealGate: 'step1_budgeted' });
    expect(report.auditBudgetMs).toBe(report.decision.auditBudgetMs);
  });

  it('uses harness-rendered JPEGs for every live sketch interpretation call', async () => {
    const sketches = materializeSketchCorpus();
    const interpretationsByRaster = new Map<string, string>();
    const render = vi.fn(async (_ops, groupId: string) => {
      const sketch = sketches.find((entry) => groupId === `sketch-${entry.id}`);
      if (!sketch) return null;
      const raster = `data:image/jpeg;base64,${Buffer.from(sketch.id).toString('base64')}`;
      interpretationsByRaster.set(raster, sketch.expectedInterpretation);
      return raster;
    });
    const create = vi.fn(async (request: { messages: Array<{ content?: unknown }> }) => {
      const content = request.messages[1]?.content as Array<{ type: string; image_url?: { url: string } }>;
      const raster = content.find((part) => part.type === 'image_url')?.image_url?.url ?? '';
      return {
        choices: [{ message: { content: JSON.stringify({
          interpretation: interpretationsByRaster.get(raster) ?? '',
          confidence: 0.9,
        }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 0 } },
      };
    });
    const report = await runLiveSketchStudy({
      client: { chat: { completions: { create } } } as never,
      harness: { render } as never,
      spend: new LiveSpendLedger(30),
    });

    expect(render).toHaveBeenCalledTimes(30);
    expect(create).toHaveBeenCalledTimes(60);
    expect(report.candidates.every((candidate) => candidate.accuracy === 1)).toBe(true);
    const imageParts = create.mock.calls.flatMap(([request]) => {
      const content = request.messages[1]?.content as Array<{ type: string; image_url?: { url: string } }>;
      return content.filter((part) => part.type === 'image_url');
    });
    expect(imageParts).toHaveLength(60);
    expect(imageParts.every((part) => part.image_url?.url.startsWith('data:image/jpeg;base64,'))).toBe(true);
  });

  it('requires paired statistical evidence as well as a five-point sketch-assist gain', () => {
    const terra = Array.from({ length: 30 }, (_, index) => index < 20);
    const twoImprovements = Array.from({ length: 30 }, (_, index) => index < 22);
    const insufficient = pairedAssistDecision(terra, twoImprovements);
    expect(insufficient.gain).toBeCloseTo(2 / 30, 4);
    expect(insufficient).toMatchObject({
      statisticallySignificant: false,
      adopt: false,
    });
    const eightImprovements = Array.from({ length: 30 }, (_, index) => index < 28);
    expect(pairedAssistDecision(terra, eightImprovements)).toMatchObject({
      statisticallySignificant: true,
      adopt: true,
    });
  });
});
