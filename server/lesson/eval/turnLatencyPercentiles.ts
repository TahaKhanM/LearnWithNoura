import type { TurnLatencyFixture } from './types.js';

const MIN_SAMPLES_FOR_PERCENTILE = 5;

export type PercentileComputation =
  | { status: 'insufficient_n'; n: number; required: number }
  | { status: 'computed'; n: number; p50: number; p95: number; valuesMs: number[] };

export type TurnLatencyPercentileResult = {
  pass: boolean;
  speechEndToResponseStarted: PercentileComputation;
  speechEndToFirstAudio: PercentileComputation;
};

function computePercentiles(valuesMs: number[], required: number): PercentileComputation {
  const sorted = [...valuesMs].sort((left, right) => left - right);
  const n = sorted.length;
  if (n < required) {
    return { status: 'insufficient_n', n, required };
  }
  return {
    status: 'computed',
    n,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    valuesMs: sorted,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return Math.round(sorted[lower] * (1 - weight) + sorted[upper] * weight);
}

/**
 * Computes turn-latency percentiles from Phase 0 duration metric fixtures.
 * A single observation is never labelled a percentile; required n is floored at 5.
 */
export function scoreTurnLatencyPercentiles(fixture: TurnLatencyFixture): TurnLatencyPercentileResult {
  const required = Math.max(MIN_SAMPLES_FOR_PERCENTILE, fixture.minSamplesForPercentile);
  const responseStarted = fixture.metrics
    .filter((row) => row.name === 'speech_end_to_response_started')
    .map((row) => row.valueMs);
  const firstAudio = fixture.metrics
    .filter((row) => row.name === 'speech_end_to_first_audio')
    .map((row) => row.valueMs);

  const speechEndToResponseStarted = computePercentiles(responseStarted, required);
  const speechEndToFirstAudio = computePercentiles(firstAudio, required);
  const pass =
    speechEndToResponseStarted.status === 'computed' &&
    speechEndToFirstAudio.status === 'computed';

  return {
    pass,
    speechEndToResponseStarted,
    speechEndToFirstAudio,
  };
}
