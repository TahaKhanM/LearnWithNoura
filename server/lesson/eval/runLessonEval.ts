import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreBlueprintQuality } from './blueprintQuality.js';
import { scoreFalseBargeIns } from './falseBargeIns.js';
import { scoreObjectPermanence } from './objectPermanence.js';
import { scoreRevealNarrationCoherence } from './revealNarrationCoherence.js';
import { scoreTurnLatencyPercentiles } from './turnLatencyPercentiles.js';
import {
  BlueprintQualityFixtureSchema,
  FalseBargeInFixtureSchema,
  LESSON_EVAL_SCHEMA_VERSION,
  ObjectPermanenceFixtureSchema,
  RevealNarrationFixtureSchema,
  TurnLatencyFixtureSchema,
  type DimensionGateResult,
  type LessonEvalReport,
} from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');

function readFixture<T>(filename: string, schema: { parse: (value: unknown) => T }): T {
  const raw = readFileSync(join(fixturesDir, filename), 'utf8');
  return schema.parse(JSON.parse(raw));
}

function gateMatchesExpectation(pass: boolean, expectPass: boolean): boolean {
  return pass === expectPass;
}

function pushGate<T extends { label: string; expectPass: boolean }, R extends { pass: boolean }>(
  gates: DimensionGateResult[],
  dimension: string,
  fixture: T,
  score: R,
): void {
  gates.push({
    dimension,
    fixtureLabel: fixture.label,
    pass: gateMatchesExpectation(score.pass, fixture.expectPass),
    expectPass: fixture.expectPass,
    details: score as Record<string, unknown>,
  });
}

export function runOfflineLessonEval(): LessonEvalReport {
  const gates: DimensionGateResult[] = [];

  pushGate(
    gates,
    'revealNarrationCoherence',
    readFixture('reveal-narration-coherent.json', RevealNarrationFixtureSchema),
    scoreRevealNarrationCoherence(readFixture('reveal-narration-coherent.json', RevealNarrationFixtureSchema)),
  );

  pushGate(
    gates,
    'revealNarrationCoherence',
    readFixture('reveal-narration-incoherent.json', RevealNarrationFixtureSchema),
    scoreRevealNarrationCoherence(readFixture('reveal-narration-incoherent.json', RevealNarrationFixtureSchema)),
  );

  pushGate(
    gates,
    'revealNarrationCoherence',
    readFixture('reveal-narration-consecutive-reveals.json', RevealNarrationFixtureSchema),
    scoreRevealNarrationCoherence(readFixture('reveal-narration-consecutive-reveals.json', RevealNarrationFixtureSchema)),
  );

  pushGate(
    gates,
    'revealNarrationCoherence',
    readFixture('reveal-narration-unbound.json', RevealNarrationFixtureSchema),
    scoreRevealNarrationCoherence(readFixture('reveal-narration-unbound.json', RevealNarrationFixtureSchema)),
  );

  pushGate(
    gates,
    'objectPermanence',
    readFixture('object-permanence-pass.json', ObjectPermanenceFixtureSchema),
    scoreObjectPermanence(readFixture('object-permanence-pass.json', ObjectPermanenceFixtureSchema)),
  );

  pushGate(
    gates,
    'objectPermanence',
    readFixture('object-permanence-fail.json', ObjectPermanenceFixtureSchema),
    scoreObjectPermanence(readFixture('object-permanence-fail.json', ObjectPermanenceFixtureSchema)),
  );

  pushGate(
    gates,
    'objectPermanence',
    readFixture('object-permanence-fail-overwrite.json', ObjectPermanenceFixtureSchema),
    scoreObjectPermanence(readFixture('object-permanence-fail-overwrite.json', ObjectPermanenceFixtureSchema)),
  );

  pushGate(
    gates,
    'objectPermanence',
    readFixture('object-permanence-fail-clear.json', ObjectPermanenceFixtureSchema),
    scoreObjectPermanence(readFixture('object-permanence-fail-clear.json', ObjectPermanenceFixtureSchema)),
  );

  pushGate(
    gates,
    'turnLatencyPercentiles',
    readFixture('turn-latency-metrics.json', TurnLatencyFixtureSchema),
    scoreTurnLatencyPercentiles(readFixture('turn-latency-metrics.json', TurnLatencyFixtureSchema)),
  );

  pushGate(
    gates,
    'turnLatencyPercentiles',
    readFixture('turn-latency-insufficient.json', TurnLatencyFixtureSchema),
    scoreTurnLatencyPercentiles(readFixture('turn-latency-insufficient.json', TurnLatencyFixtureSchema)),
  );

  pushGate(
    gates,
    'falseBargeIns',
    readFixture('barge-in-traces.json', FalseBargeInFixtureSchema),
    scoreFalseBargeIns(readFixture('barge-in-traces.json', FalseBargeInFixtureSchema)),
  );

  pushGate(
    gates,
    'falseBargeIns',
    readFixture('barge-in-negative-control.json', FalseBargeInFixtureSchema),
    scoreFalseBargeIns(readFixture('barge-in-negative-control.json', FalseBargeInFixtureSchema)),
  );

  pushGate(
    gates,
    'falseBargeIns',
    readFixture('barge-in-provider-failed.json', FalseBargeInFixtureSchema),
    scoreFalseBargeIns(readFixture('barge-in-provider-failed.json', FalseBargeInFixtureSchema)),
  );

  pushGate(
    gates,
    'blueprintQuality',
    readFixture('blueprint-good.json', BlueprintQualityFixtureSchema),
    scoreBlueprintQuality(readFixture('blueprint-good.json', BlueprintQualityFixtureSchema)),
  );

  pushGate(
    gates,
    'blueprintQuality',
    readFixture('blueprint-weak.json', BlueprintQualityFixtureSchema),
    scoreBlueprintQuality(readFixture('blueprint-weak.json', BlueprintQualityFixtureSchema)),
  );

  return {
    schemaVersion: LESSON_EVAL_SCHEMA_VERSION,
    evidenceType: 'deterministic-offline-fixture-evaluation',
    evidenceBoundary: 'Scripted fixtures and production scoring modules only; no live provider, browser, acoustic, or percentile-from-n=1 claims.',
    realChildData: false,
    runtimeProviderCalls: 0,
    liveProviderBehavior: 'UNVERIFIED',
    targetHardwareAcoustics: 'UNVERIFIED',
    generatedAt: new Date().toISOString(),
    gates,
    pass: gates.every((gate) => gate.pass),
  };
}

export function listLessonEvalFixtures(): string[] {
  return readdirSync(fixturesDir).filter((name) => name.endsWith('.json')).sort();
}
