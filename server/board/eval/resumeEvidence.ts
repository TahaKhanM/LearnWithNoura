import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DIRECTOR_EVAL_CONDITIONS } from './corpus.js';
import { DIRECTOR_MIN_WARM_CACHED_INPUT_TOKENS } from './budget.js';
import type { DirectorEvalTrial } from './types.js';

export interface DirectorResumeEvidenceMetadata {
  sourcePath: string;
  sourceSha256: string;
  sourceRunId: string;
  sourceLiabilityUsd: number;
  retainedTrialCount: number;
  discardedTrialCount: number;
  retainedTrialKeys: string[];
}

export interface DirectorResumeEvidence {
  trials: DirectorEvalTrial[];
  metadata: DirectorResumeEvidenceMetadata[];
}

export function loadDirectorResumeEvidence(path: string): DirectorResumeEvidence {
  const absolutePath = resolve(path);
  const raw = readFileSync(absolutePath, 'utf8');
  const sourceSha256 = createHash('sha256').update(raw).digest('hex');
  const records = raw.trimEnd().split('\n').map((line, index) => {
    try { return JSON.parse(line) as Record<string, unknown>; }
    catch { throw new Error(`Resume evidence has invalid NDJSON at line ${index + 1}.`); }
  });
  const header = records.find((record) => record.kind === 'run_started');
  const sourceRunId = typeof header?.runId === 'string' ? header.runId : null;
  if (!sourceRunId) throw new Error('Resume evidence has no run identity.');

  const spendEvents = records.flatMap((record) => {
    if (record.kind !== 'spend' || !record.event || typeof record.event !== 'object') return [];
    return [record.event as {
      sequence: number;
      runId: string;
      callId: string;
      status: 'reserved' | 'started' | 'completed' | 'failed';
      cumulativeAccountedCostUsd: number;
      openReservationUsd: number;
    }];
  });
  const openCalls = new Set<string>();
  for (const [index, event] of spendEvents.entries()) {
    if (event.sequence !== index + 1 || event.runId !== sourceRunId) {
      throw new Error(`Resume spend ledger is discontinuous at sequence ${index + 1}.`);
    }
    if (event.status === 'reserved') openCalls.add(event.callId);
    else if (event.status === 'completed' || event.status === 'failed') openCalls.delete(event.callId);
  }
  const terminal = spendEvents.at(-1);
  if (!terminal || openCalls.size > 0 || terminal.openReservationUsd !== 0) {
    throw new Error('Resume spend ledger retains an open provider reservation.');
  }

  const sourceTrials = records.flatMap((record) => {
    if (record.kind !== 'trial' || !record.checkpoint || typeof record.checkpoint !== 'object') return [];
    const trial = (record.checkpoint as { trial?: unknown }).trial;
    return trial && typeof trial === 'object' ? [trial as DirectorEvalTrial] : [];
  });
  const conditionById = new Map(DIRECTOR_EVAL_CONDITIONS.map((condition) => [condition.id, condition]));
  const seen = new Set<string>();
  const retained = sourceTrials.filter((trial) => {
    const key = directorTrialKey(trial);
    if (seen.has(key)) throw new Error(`Resume evidence repeats trial ${key}.`);
    seen.add(key);
    const condition = conditionById.get(trial.conditionId);
    const selectedUsage = trial.modelUsage[trial.selectedLegIndex];
    const expectedCacheFlag = trial.cacheState === 'warm'
      ? (selectedUsage?.cachedInputTokens ?? 0) >= DIRECTOR_MIN_WARM_CACHED_INPUT_TOKENS
      : (selectedUsage?.cachedInputTokens ?? 0) === 0;
    const qualityCompatible = !trial.qualitySampled || !trial.validatorPassed ||
      trial.qualityEvidenceComplete;
    return trial.cacheExpectationMet === expectedCacheFlag && Boolean(condition) &&
      qualityCompatible &&
      trial.modelUsage.length === condition?.legs.length &&
      trial.modelUsage.every((usage, index) =>
        usage.model === condition?.legs[index]?.model &&
        usage.maxCompletionTokens === condition?.legs[index]?.maxCompletionTokens);
  });
  return {
    trials: retained,
    metadata: [{
      sourcePath: relative(process.cwd(), absolutePath),
      sourceSha256,
      sourceRunId,
      sourceLiabilityUsd: money(terminal.cumulativeAccountedCostUsd + terminal.openReservationUsd),
      retainedTrialCount: retained.length,
      discardedTrialCount: sourceTrials.length - retained.length,
      retainedTrialKeys: retained.map(directorTrialKey).sort(),
    }],
  };
}

export function mergeDirectorResumeEvidence(sources: DirectorResumeEvidence[]): DirectorResumeEvidence {
  const trialsByKey = new Map<string, DirectorEvalTrial>();
  for (const source of sources) {
    for (const trial of source.trials) {
      const key = directorTrialKey(trial);
      const existing = trialsByKey.get(key);
      if (existing && !isDeepStrictEqual(existing, trial)) {
        throw new Error(`Resume sources disagree on trial ${key}.`);
      }
      trialsByKey.set(key, trial);
    }
  }
  return {
    trials: [...trialsByKey.values()],
    metadata: sources.flatMap((source) => source.metadata),
  };
}

export function directorTrialKey(trial: Pick<DirectorEvalTrial,
  'intentId' | 'conditionId' | 'cacheState' | 'trial'>): string {
  return `${trial.intentId}:${trial.conditionId}:${trial.cacheState}:${trial.trial}`;
}

function money(value: number): number {
  return Math.round(value * 1e10) / 1e10;
}
