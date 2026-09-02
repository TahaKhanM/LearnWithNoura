import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFirstPaintReplayRows, compileFirstPaintReplayEvidence, summarizeFirstPaintReplay } from './firstPaintReplay.js';

const sourceRawJson = readFileSync(resolve('server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json'), 'utf8');
const m1RawJson = readFileSync(resolve('server/board/eval/results/2026-09-01-drawing-m1-pipeline-study.json'), 'utf8');
const resultRawJson = readFileSync(resolve('server/board/eval/results/2026-09-01-drawing-g4-first-paint.json'), 'utf8');

describe('G4 actual Lesson first-paint replay', () => {
  it('binds the 290 paired-valid diagram rows to immutable M0/M1 evidence', () => {
    const rows = buildFirstPaintReplayRows(sourceRawJson, m1RawJson);

    expect(rows).toHaveLength(290);
    expect(new Set(rows.map((row) => row.sourceKey)).size).toBe(290);
    expect(rows.every((row) => row.streamingOps.length > 0 && row.classicOps.length >= row.streamingOps.length)).toBe(true);
    expect(rows.every((row) => row.firstValidOpMs <= row.completeSceneMs)).toBe(true);
    expect(percentile(rows.map((row) => row.firstValidOpMs), 0.5)).toBe(2_655);
    expect(percentile(rows.map((row) => row.completeSceneMs), 0.5)).toBe(4_708);
  });

  it('reconstructs the hash-bound actual Lesson ops_presented artifact', () => {
    const evidence = compileFirstPaintReplayEvidence(resultRawJson);

    expect(evidence).toMatchObject({
      resultSha256: 'c54a2798afb290779fe3c8580ed4c3dd3f01c7361f83156b5fab24db4ae27e5e',
      providerCalls: 0,
      externalRequestCount: 0,
      pairedRows: 290,
      summary: {
        streaming: { p50FirstPaintMs: 2_818 },
        classic: { p50FirstPaintMs: 4_909 },
        p50Cut: 0.425952,
        accepted: true,
      },
    });
    expect(() => compileFirstPaintReplayEvidence(
      resultRawJson.replace('"providerCalls": 0', '"providerCalls": 1'),
    )).toThrow(/SHA-256/i);
  });

  it('computes acceptance from measured ops_presented timestamps, not provider readiness alone', () => {
    const rows = buildFirstPaintReplayRows(sourceRawJson, m1RawJson);
    const observations = rows.flatMap((row) => [
      {
        sourceKey: row.sourceKey,
        lane: 'streaming' as const,
        providerDelayMs: row.firstValidOpMs,
        uiCommitMs: 45,
        firstPaintMs: row.firstValidOpMs + 45,
      },
      {
        sourceKey: row.sourceKey,
        lane: 'classic' as const,
        providerDelayMs: row.completeSceneMs,
        uiCommitMs: 65,
        firstPaintMs: row.completeSceneMs + 65,
      },
    ]);
    const summary = summarizeFirstPaintReplay(observations);

    expect(summary.streaming.p50FirstPaintMs).toBe(2_700);
    expect(summary.classic.p50FirstPaintMs).toBe(4_773);
    expect(summary.p50Cut).toBeGreaterThanOrEqual(0.4);
    expect(summary.streamingWithinFourSeconds).toBe(true);
    expect(summary.accepted).toBe(true);
  });
});

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] ?? 0;
}
