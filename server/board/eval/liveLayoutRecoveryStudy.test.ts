import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runAuthorizedLayoutRecoveryStudy } from './liveLayoutRecoveryStudy.js';

const sourceRawJson = readFileSync(resolve('server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json'), 'utf8');
const observationsRawJson = readFileSync(resolve('server/board/eval/results/2026-09-01-drawing-m1-pipeline-browser-observations.json'), 'utf8');
const feedbackRawJson = readFileSync(resolve('server/board/eval/results/2026-09-01-drawing-f9-layout-feedback.json'), 'utf8');

describe('authorized F9 runner offline dry-run', () => {
  it('executes canary then scale through the exact accounted transports', async () => {
    let proposalId = 0;
    const callSchemas: string[] = [];
    const create = vi.fn(async (body: Record<string, unknown>) => {
      const responseFormat = body.response_format as { json_schema?: { name?: string } } | undefined;
      const schema = String(responseFormat?.json_schema?.name ?? 'none');
      callSchemas.push(schema);
      if (body.stream === true) {
        if (schema === 'noura_director_layout_correction') {
          const messages = body.messages as Array<{ content?: Array<{ type?: string; text?: string }> }>;
          const payload = JSON.parse(messages[1]?.content?.find((part) => part.type === 'text')?.text ?? '{}') as {
            rejectedStepOps?: Array<{ id?: string; spec?: { kind?: string; side?: string } }>;
            layoutIssues?: Array<{ itemId?: string; withItemId?: string }>;
          };
          const rejectedIds = new Set(payload.rejectedStepOps?.map((op) => op.id).filter(Boolean));
          const implicated = payload.layoutIssues?.flatMap((issue) => [issue.itemId, issue.withItemId])
            .find((id) => id && rejectedIds.has(id));
          const op = payload.rejectedStepOps?.find((candidate) => candidate.id === implicated) ?? payload.rejectedStepOps?.[0];
          const side = op?.spec?.kind === 'label' ? (op.spec.side === 'above' ? 'below' : 'above') : null;
          return streamResponse(JSON.stringify({ placements: [{ id: op?.id, dx: 12, dy: 12, side }] }));
        }
        proposalId += 1;
        return streamResponse(JSON.stringify({
          template: null,
          groupLabel: 'Recovered scene',
          representation: 'diagram',
          illustration: null,
          steps: [{
            id: `step-${proposalId}`,
            reveal: 'outline',
            narration: 'Here is the recovered idea.',
            ops: [{
              op: 'add', id: `recovered-${proposalId}`, color: 'blue',
              spec: { kind: 'box', at: [500, 300], w: 220, h: 100, text: 'Recovered' },
            }],
          }],
        }));
      }
      return {
        id: `judge-${callSchemas.length}`,
        object: 'chat.completion',
        created: 1,
        model: 'gpt-5.6-luna',
        choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', refusal: null, annotations: [], content: '{"grade":4,"reasons":[]}' } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, audio_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
        },
      };
    });
    const harness = {
      validate: async () => ({ ok: true as const }),
      render: async () => 'data:image/jpeg;base64,Ym9hcmQ=',
      close: async () => {},
    };

    const report = await runAuthorizedLayoutRecoveryStudy({
      client: { chat: { completions: { create } } } as never,
      harness,
      sourceRawJson,
      observationsRawJson,
      feedbackRawJson,
      maxSpendUsd: 5,
    });

    expect(callSchemas.slice(0, 4)).toEqual([
      'noura_director_vnext_eval',
      'noura_director_layout_correction',
      'noura_director_layout_correction',
      'noura_director_vnext_eval',
    ]);
    expect(report.decision.canary).toMatchObject({ passed: true, intents: 3, providerCalls: 4 });
    expect(new Set(report.decision.canary.sourceKeys.map((key) => key.split(':', 1)[0])).size).toBe(3);
    expect(report.decision.winner).not.toBeNull();
    expect(report.providerCalls).toBeLessThanOrEqual(90);
    expect(report.accountedCostUsd).toBeLessThan(5);
    expect(report.spendLedger.openReservationUsd).toBe(0);
  });

  it('rejects a non-fitting authorization before any provider call', async () => {
    const create = vi.fn();
    await expect(runAuthorizedLayoutRecoveryStudy({
      client: { chat: { completions: { create } } } as never,
      harness: { validate: async () => ({ ok: true }), render: async () => null, close: async () => {} },
      sourceRawJson,
      observationsRawJson,
      feedbackRawJson,
      maxSpendUsd: 2.9,
    })).rejects.toThrow(/conservative plan/i);
    expect(create).not.toHaveBeenCalled();
  });
});

async function* streamResponse(content: string) {
  yield { choices: [{ delta: { content }, finish_reason: null }] };
  yield {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    },
  };
}
