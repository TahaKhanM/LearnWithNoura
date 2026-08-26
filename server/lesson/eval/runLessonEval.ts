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

export function runOfflineLessonEval(): LessonEvalReport {
  const gates: DimensionGateResult[] = [];

  const revealCoherent = readFixture('reveal-narration-coherent.json', RevealNarrationFixtureSchema);
  const revealCoherentScore = scoreRevealNarrationCoherence(revealCoherent);
  gates.push({
    dimension: 'revealNarrationCoherence',
    fixtureLabel: revealCoherent.label,
    pass: gateMatchesExpectation(revealCoherentScore.pass, revealCoherent.expectPass),
    expectPass: revealCoherent.expectPass,
    details: revealCoherentScore,
  });

  const revealIncoherent = readFixture('reveal-narration-incoherent.json', RevealNarrationFixtureSchema);
  const revealIncoherentScore = scoreRevealNarrationCoherence(revealIncoherent);
  gates.push({
    dimension: 'revealNarrationCoherence',
    fixtureLabel: revealIncoherent.label,
    pass: gateMatchesExpectation(revealIncoherentScore.pass, revealIncoherent.expectPass),
    expectPass: revealIncoherent.expectPass,
    details: revealIncoherentScore,
  });

  const permanencePass = readFixture('object-permanence-pass.json', ObjectPermanenceFixtureSchema);
  const permanencePassScore = scoreObjectPermanence(permanencePass);
  gates.push({
    dimension: 'objectPermanence',
    fixtureLabel: permanencePass.label,
    pass: gateMatchesExpectation(permanencePassScore.pass, permanencePass.expectPass),
    expectPass: permanencePass.expectPass,
    details: permanencePassScore,
  });

  const permanenceFail = readFixture('object-permanence-fail.json', ObjectPermanenceFixtureSchema);
  const permanenceFailScore = scoreObjectPermanence(permanenceFail);
  gates.push({
    dimension: 'objectPermanence',
    fixtureLabel: permanenceFail.label,
    pass: gateMatchesExpectation(permanenceFailScore.pass, permanenceFail.expectPass),
    expectPass: permanenceFail.expectPass,
    details: permanenceFailScore,
  });

  const latencySufficient = readFixture('turn-latency-metrics.json', TurnLatencyFixtureSchema);
  const latencyScore = scoreTurnLatencyPercentiles(latencySufficient);
  gates.push({
    dimension: 'turnLatencyPercentiles',
    fixtureLabel: latencySufficient.label,
    pass: gateMatchesExpectation(latencyScore.pass, latencySufficient.expectPass),
    expectPass: latencySufficient.expectPass,
    details: latencyScore,
  });

  const latencyInsufficient = readFixture('turn-latency-insufficient.json', TurnLatencyFixtureSchema);
  const latencyInsufficientScore = scoreTurnLatencyPercentiles(latencyInsufficient);
  gates.push({
    dimension: 'turnLatencyPercentiles',
    fixtureLabel: latencyInsufficient.label,
    pass: gateMatchesExpectation(latencyInsufficientScore.pass, latencyInsufficient.expectPass),
    expectPass: latencyInsufficient.expectPass,
    details: latencyInsufficientScore,
  });

  const bargeInTraces = readFixture('barge-in-traces.json', FalseBargeInFixtureSchema);
  const bargeInScore = scoreFalseBargeIns(bargeInTraces);
  gates.push({
    dimension: 'falseBargeIns',
    fixtureLabel: bargeInTraces.label,
    pass: gateMatchesExpectation(bargeInScore.pass, bargeInTraces.expectPass),
    expectPass: bargeInTraces.expectPass,
    details: bargeInScore,
  });

  const bargeInIsolation = readFixture('barge-in-negative-control.json', FalseBargeInFixtureSchema);
  const bargeInIsolationScore = scoreFalseBargeIns(bargeInIsolation);
  gates.push({
    dimension: 'falseBargeIns',
    fixtureLabel: bargeInIsolation.label,
    pass: gateMatchesExpectation(bargeInIsolationScore.pass, bargeInIsolation.expectPass),
    expectPass: bargeInIsolation.expectPass,
    details: bargeInIsolationScore,
  });

  const blueprintGood = readFixture('blueprint-good.json', BlueprintQualityFixtureSchema);
  const blueprintGoodScore = scoreBlueprintQuality(blueprintGood);
  gates.push({
    dimension: 'blueprintQuality',
    fixtureLabel: blueprintGood.label,
    pass: gateMatchesExpectation(blueprintGoodScore.pass, blueprintGood.expectPass),
    expectPass: blueprintGood.expectPass,
    details: blueprintGoodScore,
  });

  const blueprintWeak = readFixture('blueprint-weak.json', BlueprintQualityFixtureSchema);
  const blueprintWeakScore = scoreBlueprintQuality(blueprintWeak);
  gates.push({
    dimension: 'blueprintQuality',
    fixtureLabel: blueprintWeak.label,
    pass: gateMatchesExpectation(blueprintWeakScore.pass, blueprintWeak.expectPass),
    expectPass: blueprintWeak.expectPass,
    details: blueprintWeakScore,
  });

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
