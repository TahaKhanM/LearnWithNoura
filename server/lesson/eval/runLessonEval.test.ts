import { describe, expect, it } from 'vitest';
import {
  assertLiveLessonEvalAuthorized,
  assertLiveSessionBudget,
  MAX_AUTHORIZED_LIVE_LESSON_SESSIONS,
  parseLessonEvalAuthorization,
} from './authorization.js';
import { scoreBlueprintQuality } from './blueprintQuality.js';
import { scoreFalseBargeIns } from './falseBargeIns.js';
import { scoreObjectPermanence } from './objectPermanence.js';
import { scoreRevealNarrationCoherence } from './revealNarrationCoherence.js';
import { listLessonEvalFixtures, runOfflineLessonEval } from './runLessonEval.js';
import { scoreTurnLatencyPercentiles } from './turnLatencyPercentiles.js';
import {
  BlueprintQualityFixtureSchema,
  FalseBargeInFixtureSchema,
  ObjectPermanenceFixtureSchema,
  RevealNarrationFixtureSchema,
  TurnLatencyFixtureSchema,
} from './types.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFixture<T>(name: string, schema: { parse: (value: unknown) => T }): T {
  return schema.parse(JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')));
}

describe('lesson eval authorization', () => {
  it('refuses live evaluation without --authorized-live-run', () => {
    const auth = parseLessonEvalAuthorization([]);
    expect(() => assertLiveLessonEvalAuthorized(auth)).toThrow(/authorized-live-run/);
  });

  it('caps live sessions at two even when authorized', () => {
    const auth = parseLessonEvalAuthorization(['--authorized-live-run']);
    expect(auth.liveSessionBudget).toBe(MAX_AUTHORIZED_LIVE_LESSON_SESSIONS);
    expect(() => assertLiveSessionBudget(auth, 3)).toThrow(/refuses 3 sessions/);
    expect(() => assertLiveSessionBudget(auth, 2)).not.toThrow();
  });
});

describe('reveal–narration coherence', () => {
  it('passes a coherent scripted timeline', () => {
    const fixture = loadFixture('reveal-narration-coherent.json', RevealNarrationFixtureSchema);
    const score = scoreRevealNarrationCoherence(fixture);
    expect(score.pass).toBe(true);
    expect(score.violations).toEqual([]);
  });

  it('fails when narration references objects before reveal', () => {
    const fixture = loadFixture('reveal-narration-incoherent.json', RevealNarrationFixtureSchema);
    const score = scoreRevealNarrationCoherence(fixture);
    expect(score.pass).toBe(false);
    expect(score.violations.length).toBeGreaterThan(0);
  });
});

describe('object permanence', () => {
  it('passes when tutor objects only accumulate', () => {
    const fixture = loadFixture('object-permanence-pass.json', ObjectPermanenceFixtureSchema);
    expect(scoreObjectPermanence(fixture).pass).toBe(true);
  });

  it('fails on unexplained tutor disappearance', () => {
    const fixture = loadFixture('object-permanence-fail.json', ObjectPermanenceFixtureSchema);
    const score = scoreObjectPermanence(fixture);
    expect(score.pass).toBe(false);
    expect(score.unexplainedDisappearances.length).toBeGreaterThan(0);
  });
});

describe('turn latency percentiles', () => {
  it('computes p50 and p95 when enough samples exist', () => {
    const fixture = loadFixture('turn-latency-metrics.json', TurnLatencyFixtureSchema);
    const score = scoreTurnLatencyPercentiles(fixture);
    expect(score.pass).toBe(true);
    expect(score.speechEndToResponseStarted.status).toBe('computed');
    expect(score.speechEndToFirstAudio.status).toBe('computed');
    if (score.speechEndToResponseStarted.status === 'computed') {
      expect(score.speechEndToResponseStarted.p50).toBeGreaterThan(0);
      expect(score.speechEndToResponseStarted.p95).toBeGreaterThanOrEqual(score.speechEndToResponseStarted.p50);
    }
  });

  it('reports insufficient_n instead of inventing a percentile from n=1', () => {
    const fixture = loadFixture('turn-latency-insufficient.json', TurnLatencyFixtureSchema);
    const score = scoreTurnLatencyPercentiles(fixture);
    expect(score.pass).toBe(false);
    expect(score.speechEndToResponseStarted).toEqual({ status: 'insufficient_n', n: 1, required: 5 });
    expect(score.speechEndToFirstAudio).toEqual({ status: 'insufficient_n', n: 1, required: 5 });
  });
});

describe('false barge-ins', () => {
  it('separates confirmed-then-cancelled from true interrupts without labelling unlabelled rows', () => {
    const fixture = loadFixture('barge-in-traces.json', FalseBargeInFixtureSchema);
    const score = scoreFalseBargeIns(fixture);
    expect(score.confirmedThenCancelled).toBe(1);
    expect(score.trueInterrupts).toBe(1);
    expect(score.unlabelledCancellations).toBe(1);
  });

  it('supports negative-control isolation on confirmed-then-cancelled count', () => {
    const fixture = loadFixture('barge-in-negative-control.json', FalseBargeInFixtureSchema);
    expect(scoreFalseBargeIns(fixture).pass).toBe(true);
  });
});

describe('blueprint quality rubric', () => {
  it('scores the triangle fixture above threshold', () => {
    const fixture = loadFixture('blueprint-good.json', BlueprintQualityFixtureSchema);
    const score = scoreBlueprintQuality(fixture);
    expect(score.pass).toBe(true);
    expect(score.totalScore).toBeGreaterThanOrEqual(0.7);
  });

  it('scores the weak fixture below threshold', () => {
    const fixture = loadFixture('blueprint-weak.json', BlueprintQualityFixtureSchema);
    const score = scoreBlueprintQuality(fixture);
    expect(score.pass).toBe(false);
    expect(score.totalScore).toBeLessThan(fixture.minimumTotalScore);
  });
});

describe('offline lesson eval runner', () => {
  it('lists checked-in fixtures', () => {
    expect(listLessonEvalFixtures().length).toBeGreaterThanOrEqual(10);
  });

  it('passes every dimension gate including negative controls', () => {
    const report = runOfflineLessonEval();
    expect(report.pass).toBe(true);
    expect(report.runtimeProviderCalls).toBe(0);
    expect(report.gates.every((gate) => gate.pass)).toBe(true);
  });
});
