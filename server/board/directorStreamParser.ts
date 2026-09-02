import type { AddOp } from '../../shared/boardOps.js';
import type { DirectorDensity, DirectorProposal } from './directorSchema.js';
import {
  DirectorStreamHeaderSchema,
  DirectorStreamProposalSchema,
  parseDirectorStreamProposal,
  validatePolicyReadyDirectorStep,
  type DirectorStreamStep,
} from './directorStreamSchema.js';

export interface ParsedDirectorStep {
  index: number;
  header: ReturnType<typeof DirectorStreamHeaderSchema.parse>;
  step: DirectorStreamStep;
  ops: AddOp[];
  priorOps: AddOp[];
}

/** Stateful incremental parser for the strict template-first Director
 * contract. Completed steps are validated against every earlier step before
 * being returned; partial JSON is retained but never exposed as BoardOps. */
export class IncrementalDirectorStreamParser {
  private text = '';
  private emittedSteps = 0;
  private cumulativeOps: AddOp[] = [];
  private header: ReturnType<typeof DirectorStreamHeaderSchema.parse> | null = null;

  constructor(private readonly input: {
    density: DirectorDensity;
    visibleObjectIds: readonly string[];
  }) {}

  push(delta: string): ParsedDirectorStep[] {
    this.text += delta;
    const items = completeDirectorStepItems(this.text);
    if (items.length <= this.emittedSteps) return [];
    const header = this.header ?? parseCompletedDirectorHeader(this.text);
    if (!header) return [];
    this.header = header;
    const parsed: ParsedDirectorStep[] = [];
    for (let index = this.emittedSteps; index < items.length; index += 1) {
      const priorOps = [...this.cumulativeOps];
      const validated = validatePolicyReadyDirectorStep({
        step: JSON.parse(items[index] ?? '') as unknown,
        density: this.input.density,
        priorOps,
        visibleObjectIds: this.input.visibleObjectIds,
      });
      this.cumulativeOps.push(...validated.ops);
      parsed.push({ index, header, step: validated.step, ops: validated.ops, priorOps });
      this.emittedSteps += 1;
    }
    return parsed;
  }

  finish(): DirectorProposal {
    const raw = DirectorStreamProposalSchema.parse(JSON.parse(this.text));
    if (raw.steps.length !== this.emittedSteps) {
      throw new Error('Director stream finished before every step was emitted and validated.');
    }
    return parseDirectorStreamProposal(this.text, this.input.density, this.input.visibleObjectIds);
  }

  snapshot(): { text: string; emittedSteps: number; cumulativeOps: AddOp[] } {
    return { text: this.text, emittedSteps: this.emittedSteps, cumulativeOps: [...this.cumulativeOps] };
  }
}

export async function* parseDirectorTextStream(input: {
  chunks: AsyncIterable<string>;
  density: DirectorDensity;
  visibleObjectIds: readonly string[];
  signal?: AbortSignal;
}): AsyncGenerator<ParsedDirectorStep, DirectorProposal> {
  const parser = new IncrementalDirectorStreamParser(input);
  for await (const chunk of input.chunks) {
    throwIfAborted(input.signal);
    for (const parsed of parser.push(chunk)) yield parsed;
  }
  throwIfAborted(input.signal);
  return parser.finish();
}

export function completeDirectorStepItems(text: string): string[] {
  const location = findRootStepsArray(text);
  if (!location) return [];
  const items: string[] = [];
  let itemStart = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = location.itemsStart; index < text.length; index += 1) {
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
    } else if (char === ']' && depth === 0) break;
  }
  return items;
}

export function parseCompletedDirectorHeader(
  text: string,
): ReturnType<typeof DirectorStreamHeaderSchema.parse> | null {
  const location = findRootStepsArray(text);
  if (!location) return null;
  const prefix = text.slice(0, location.keyStart).replace(/,\s*$/, '');
  try { return DirectorStreamHeaderSchema.parse(JSON.parse(`${prefix}}`) as unknown); }
  catch { return null; }
}

function findRootStepsArray(text: string): { keyStart: number; itemsStart: number } | null {
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
        if (objectDepth === 1 && arrayDepth === 0 && text.slice(stringStart + 1, index) === 'steps') {
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Director stream aborted by visual request epoch.');
  error.name = 'AbortError';
  throw error;
}
