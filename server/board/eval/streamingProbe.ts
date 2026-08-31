import type OpenAI from 'openai';
import type { AddOp } from '../../../shared/boardOps.js';
import type { DirectorDensity } from '../directorSchema.js';
import {
  compositionCallReserveUsd,
  DIRECTOR_PROPOSAL_MAX_COMPLETION_TOKENS,
  estimateUsageCostUsd,
} from './budget.js';
import type { DirectorEvalIntent } from './types.js';
import {
  DIRECTOR_VNEXT_EVAL_RESPONSE_FORMAT,
  DIRECTOR_VNEXT_EVAL_STATIC_PROMPT,
  VNextEvalHeaderSchema,
  validatePolicyReadyEvalStep,
} from './vnextEvalSchema.js';

export interface ProbeUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface StreamingProbeResult {
  text: string;
  ttftMs: number;
  firstValidOpMs: number | null;
  firstStepStatus: 'valid' | 'invalid' | 'missing';
  completeMs: number;
  usage: ProbeUsage;
  aborted: boolean;
  usageComplete: boolean;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null;
  maxCompletionTokens: number;
  estimatedCostUsd: number;
  costUpperBoundUsd: number;
  selectedLegIndex?: number;
  legUsage?: Array<{
    model: 'gpt-5.6-terra' | 'gpt-5.6-luna';
    usage: ProbeUsage;
    usageComplete: boolean;
    finishReason: StreamingProbeResult['finishReason'];
    maxCompletionTokens: number;
  }>;
}

interface ProbeInput {
  client: OpenAI;
  intent: DirectorEvalIntent;
  model: 'gpt-5.6-terra' | 'gpt-5.6-luna';
  reasoningEffort: 'low' | 'medium';
  maxCompletionTokens?: number;
  cacheState: 'cold' | 'warm';
  trialKey: string;
  signal?: AbortSignal;
  currentBoardRaster?: string | null;
  visibleObjectIds?: string[];
  validateFirstStep?: (ops: AddOp[]) => Promise<boolean>;
  onFirstValidStep?: (elapsedMs: number) => void;
}

/** One live streaming probe. The static Director policy is the first message
 * and every per-intent value stays in the dynamic final message, preserving
 * a reusable cache prefix. */
export async function runStreamingProbe(input: ProbeInput): Promise<StreamingProbeResult> {
  const maxCompletionTokens = input.maxCompletionTokens ??
    DIRECTOR_PROPOSAL_MAX_COMPLETION_TOKENS[input.model][input.reasoningEffort];
  const startedAt = performance.now();
  let ttftMs = Number.POSITIVE_INFINITY;
  let firstValidOpMs = Number.POSITIVE_INFINITY;
  let firstStepStatus: 'valid' | 'invalid' | 'missing' = 'missing';
  let text = '';
  let usage: ProbeUsage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  let usageComplete = false;
  let finishReason: StreamingProbeResult['finishReason'] = null;
  let firstStepChecked = false;
  let aborted = false;
  try {
    const stream = await input.client.chat.completions.create({
      model: input.model,
      reasoning_effort: input.reasoningEffort,
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: maxCompletionTokens,
      verbosity: 'low',
      response_format: DIRECTOR_VNEXT_EVAL_RESPONSE_FORMAT,
      prompt_cache_key: input.cacheState === 'warm'
        ? `noura-director-eval:${input.model}:${input.reasoningEffort}`
        : `noura-director-eval-cold:${input.trialKey}`,
      messages: directorEvalMessages(input.intent, {
        cacheState: input.cacheState,
        trialKey: input.trialKey,
        currentBoardRaster: input.currentBoardRaster,
      }),
    }, { signal: input.signal });
    for await (const chunk of stream) {
      if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      const delta = chunk.choices[0]?.delta?.content ?? '';
      if (delta) {
        if (!Number.isFinite(ttftMs)) ttftMs = performance.now() - startedAt;
        text += delta;
        if (!firstStepChecked && !Number.isFinite(firstValidOpMs)) {
          const candidate = inspectFirstCompleteStep(
            text,
            input.intent.density,
            input.visibleObjectIds ?? [],
          );
          if (candidate.status !== 'missing') {
            firstStepChecked = true;
            const browserAccepted = candidate.status === 'valid'
              ? await input.validateFirstStep?.(candidate.ops) ?? true
              : false;
            if (candidate.status === 'valid' && browserAccepted) {
              firstStepStatus = 'valid';
              firstValidOpMs = performance.now() - startedAt;
              input.onFirstValidStep?.(firstValidOpMs);
            } else firstStepStatus = 'invalid';
          }
        }
      }
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens: chunk.usage.prompt_tokens_details?.cache_write_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens,
        };
        usageComplete = true;
      }
    }
  } catch (error) {
    if (input.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) aborted = true;
    else throw error;
  }
  const completeMs = performance.now() - startedAt;
  const estimatedCostUsd = estimateTextCost(input.model, usage, text);
  return {
    text,
    ttftMs: finiteMs(ttftMs, completeMs),
    firstValidOpMs: Number.isFinite(firstValidOpMs) ? Math.round(firstValidOpMs) : null,
    firstStepStatus,
    completeMs: Math.round(completeMs),
    usage,
    aborted,
    usageComplete,
    finishReason,
    maxCompletionTokens,
    estimatedCostUsd,
    costUpperBoundUsd: usageComplete
      ? estimatedCostUsd
      : compositionCallReserveUsd(
          input.model,
          'cold',
          Boolean(input.currentBoardRaster),
          input.reasoningEffort,
          maxCompletionTokens,
        ),
  };
}

export function directorEvalMessages(
  intent: DirectorEvalIntent,
  options: {
    cacheState?: 'cold' | 'warm';
    trialKey?: string;
    currentBoardRaster?: string | null;
  } = {},
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const system = options.cacheState === 'cold' && options.trialKey
    ? `${DIRECTOR_VNEXT_EVAL_STATIC_PROMPT}\nCold-cache nonce: ${options.trialKey}`
    : DIRECTOR_VNEXT_EVAL_STATIC_PROMPT;
  const dynamicText = dynamicIntentPrompt(intent);
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: options.currentBoardRaster
        ? [
            { type: 'text', text: dynamicText },
            { type: 'image_url', image_url: { url: options.currentBoardRaster, detail: 'high' } },
          ]
        : dynamicText,
    },
  ];
}

/** A hedge may commit only after one complete step has crossed the strict
 * local contract, authored BoardOp validation, and cumulative Director policy.
 * Merely completing an isolated add operation is insufficient. */
export function containsCompleteValidStep(text: string, density: DirectorDensity = 'standard'): boolean {
  return inspectFirstCompleteStep(text, density, []).status === 'valid';
}

export function inspectFirstCompleteStep(
  text: string,
  density: DirectorDensity = 'standard',
  visibleObjectIds: string[] = [],
): { status: 'missing' } | { status: 'invalid' } | { status: 'valid'; ops: AddOp[] } {
  if (!hasTemplateFirstPrefix(text) || !hasValidCompletedHeader(text)) return { status: 'missing' };
  const [first] = completeStepsArrayItems(text);
  if (!first) return { status: 'missing' };
  try {
    const validated = validatePolicyReadyEvalStep({
      step: JSON.parse(first) as unknown,
      density,
      visibleObjectIds,
    });
    return { status: 'valid', ops: validated.ops };
  } catch {
    return { status: 'invalid' };
  }
}

export function completeStepsArrayItems(text: string): string[] {
  return completeTopLevelObjectItems(text, 'steps');
}

function completeTopLevelObjectItems(text: string, property: 'steps'): string[] {
  const location = findRootArrayProperty(text, property);
  if (!location) return [];
  const start = location.itemsStart;
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

function hasTemplateFirstPrefix(text: string): boolean {
  return /^\s*\{\s*"template"\s*:\s*(?:null|"[a-z0-9_]+")\s*,/.test(text);
}

function hasValidCompletedHeader(text: string): boolean {
  const location = findRootArrayProperty(text, 'steps');
  if (!location) return false;
  const prefix = text.slice(0, location.keyStart).replace(/,\s*$/, '');
  try {
    VNextEvalHeaderSchema.parse(JSON.parse(`${prefix}}`) as unknown);
    return true;
  } catch {
    return false;
  }
}

function findRootArrayProperty(
  text: string,
  property: 'steps',
): { keyStart: number; itemsStart: number } | null {
  let objectDepth = 0;
  let arrayDepth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        inString = false;
        if (objectDepth === 1 && arrayDepth === 0 && text.slice(stringStart + 1, index) === property) {
          let cursor = index + 1;
          while (/\s/.test(text[cursor] ?? '')) cursor += 1;
          if (text[cursor] !== ':') continue;
          cursor += 1;
          while (/\s/.test(text[cursor] ?? '')) cursor += 1;
          if (text[cursor] === '[') return { keyStart: stringStart, itemsStart: cursor + 1 };
        }
      }
      continue;
    }
    if (char === '"') { inString = true; stringStart = index; continue; }
    if (char === '{') objectDepth += 1;
    else if (char === '}') objectDepth -= 1;
    else if (char === '[') arrayDepth += 1;
    else if (char === ']') arrayDepth -= 1;
  }
  return null;
}

export function estimateTextCost(
  model: 'gpt-5.6-terra' | 'gpt-5.6-luna',
  usage: ProbeUsage,
  partialText = '',
): number {
  const observedOutput = usage.outputTokens || Math.ceil(partialText.length / 4);
  return estimateUsageCostUsd(model, { ...usage, outputTokens: observedOutput });
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
