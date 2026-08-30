import type OpenAI from 'openai';
import { validateOps } from '../../../shared/boardOps.js';
import { directorProposePrompt } from '../directorPrompts.js';
import type { DirectorEvalIntent } from './types.js';

export interface ProbeUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface StreamingProbeResult {
  text: string;
  ttftMs: number;
  firstValidOpMs: number;
  completeMs: number;
  usage: ProbeUsage;
  aborted: boolean;
  estimatedCostUsd: number;
}

interface ProbeInput {
  client: OpenAI;
  intent: DirectorEvalIntent;
  model: 'gpt-5.6-terra' | 'gpt-5.6-luna';
  reasoningEffort: 'low' | 'medium';
  cacheState: 'cold' | 'warm';
  trialKey: string;
  signal?: AbortSignal;
  onFirstValidOp?: (elapsedMs: number) => void;
}

/** One live streaming probe. The static Director policy is the first message
 * and every per-intent value stays in the dynamic final message, preserving
 * a reusable cache prefix. */
export async function runStreamingProbe(input: ProbeInput): Promise<StreamingProbeResult> {
  const startedAt = performance.now();
  let ttftMs = Number.POSITIVE_INFINITY;
  let firstValidOpMs = Number.POSITIVE_INFINITY;
  let text = '';
  let usage: ProbeUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let aborted = false;
  try {
    const stream = await input.client.chat.completions.create({
      model: input.model,
      reasoning_effort: input.reasoningEffort,
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 4_000,
      response_format: { type: 'json_object' },
      prompt_cache_key: input.cacheState === 'warm'
        ? `noura-director-eval:${input.model}:${input.reasoningEffort}`
        : `noura-director-eval-cold:${input.trialKey}`,
      messages: directorEvalMessages(input.intent),
    }, { signal: input.signal });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? '';
      if (delta) {
        if (!Number.isFinite(ttftMs)) ttftMs = performance.now() - startedAt;
        text += delta;
        if (!Number.isFinite(firstValidOpMs) && containsCompleteValidAdd(text)) {
          firstValidOpMs = performance.now() - startedAt;
          input.onFirstValidOp?.(firstValidOpMs);
        }
      }
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens,
        };
      }
    }
  } catch (error) {
    if (input.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) aborted = true;
    else throw error;
  }
  const completeMs = performance.now() - startedAt;
  return {
    text,
    ttftMs: finiteMs(ttftMs, completeMs),
    firstValidOpMs: finiteMs(firstValidOpMs, completeMs),
    completeMs: Math.round(completeMs),
    usage,
    aborted,
    estimatedCostUsd: estimateTextCost(input.model, usage, text),
  };
}

export function directorEvalMessages(intent: DirectorEvalIntent): Array<{
  role: 'system' | 'user';
  content: string;
}> {
  return [
    { role: 'system', content: directorProposePrompt(false) },
    { role: 'user', content: dynamicIntentPrompt(intent) },
  ];
}

export function containsCompleteValidAdd(text: string): boolean {
  for (const candidate of completeOpsArrayItems(text)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const validated = validateOps([parsed], { tier: 'authored' });
      if (validated.rejected.length === 0 && validated.ops[0]?.op === 'add') return true;
    } catch {
      // An incomplete or non-object array item is not a valid first op.
    }
  }
  return false;
}

/** Incrementally locates complete top-level object items in the `ops` array
 * while respecting strings and escape sequences. */
export function completeOpsArrayItems(text: string): string[] {
  const key = /"ops"\s*:\s*\[/.exec(text);
  if (!key) return [];
  const start = (key.index ?? 0) + key[0].length;
  const items: string[] = [];
  let itemStart = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') {
      if (depth === 0) itemStart = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && itemStart >= 0) {
        items.push(text.slice(itemStart, index + 1));
        itemStart = -1;
      }
    } else if (char === ']' && depth === 0) {
      break;
    }
  }
  return items;
}

export function estimateTextCost(
  model: 'gpt-5.6-terra' | 'gpt-5.6-luna',
  usage: ProbeUsage,
  partialText = '',
): number {
  const rates = model === 'gpt-5.6-terra'
    ? { input: 2, cached: 0.2, output: 12 }
    : { input: 0.2, cached: 0.02, output: 1.2 };
  const observedOutput = usage.outputTokens || Math.ceil(partialText.length / 4);
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return round((uncachedInput * rates.input + usage.cachedInputTokens * rates.cached + observedOutput * rates.output) / 1_000_000, 8);
}

function dynamicIntentPrompt(intent: DirectorEvalIntent): string {
  return [
    'Synthetic evaluation intent; no learner data is present.',
    `Purpose: ${intent.purpose}`,
    `Idea: ${intent.intent}`,
    `Density: ${intent.density}`,
    `Section id: eval-${intent.id}`,
    intent.existingBoardDescription ? `Existing released board: ${intent.existingBoardDescription}` : 'Existing released board: empty.',
    'Reply with the requested JSON object only.',
  ].join('\n');
}

function finiteMs(value: number, fallback: number): number {
  return Math.round(Number.isFinite(value) ? value : fallback);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
