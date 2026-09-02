import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ImageRegionSelector } from '../../../shared/boardOps.js';
import { evaluateImageGroundingStudy, type GroundingStudyObservations } from './imageGroundingStudy.js';
import manifestJson from './fixtures/m7-image-grounding-evidence-manifest.json' with { type: 'json' };

const ShaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ManifestSchema = z.object({
  schemaVersion: z.literal('1.0.0'), fixtureSha256: ShaSchema, rawResultSha256: ShaSchema,
  ledgerSha256: ShaSchema, maximumProviderCalls: z.literal(17), actualProviderCalls: z.literal(17),
  hardCapUsd: z.literal(0.6), conservativeAccountedCostUsd: z.literal(0.51),
  observedCostUsd: z.literal(0.005022), syntheticOnly: z.literal(true),
}).strict();
const SelectorSchema = z.union([
  z.object({ type: z.literal('FragmentSelector'), unit: z.literal('percent'), x: z.number(), y: z.number(), w: z.number(), h: z.number() }).strict(),
  z.object({ type: z.literal('PointSelector'), x: z.number(), y: z.number() }).strict(),
  z.object({ type: z.literal('SvgSelector'), points: z.array(z.tuple([z.number(), z.number()])).min(3) }).strict(),
]);
const OutcomeSchema = z.enum(['approved', 'rejected', 'invalid']);
const ObservationsSchema = z.object({
  proposals: z.array(z.object({ itemId: z.string(), selector: SelectorSchema, confidence: z.number() }).strict()),
  correctSelfChecks: z.array(z.object({ itemId: z.string(), outcome: OutcomeSchema }).strict()),
  defectSelfChecks: z.array(z.object({ itemId: z.string(), outcome: OutcomeSchema }).strict()),
  malformedReplies: z.number().int().nonnegative(),
}).strict();
const EntrySchema = z.object({
  sequence: z.number().int().positive(), runId: z.string(), callId: z.string(),
  status: z.enum(['reserved', 'started', 'completed', 'failed']),
  phase: z.literal('image_grounding'), models: z.tuple([z.literal('gpt-5.6-luna')]),
  reserveUsd: z.literal(0.03), providerCallCount: z.number().int().min(0).max(1),
  observedCostUsd: z.number().nonnegative(), upperBoundUsd: z.literal(0.03),
  usage: z.array(z.object({
    model: z.literal('gpt-5.6-luna'), inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(), cacheWriteTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(), usageComplete: z.literal(true),
  }).strict()).max(1),
  cumulativeProviderCalls: z.number().int().nonnegative(), cumulativeObservedCostUsd: z.number().nonnegative(),
  cumulativeAccountedCostUsd: z.number().nonnegative(), openReservationUsd: z.number().nonnegative(),
}).strict();
const LedgerSchema = z.object({
  schemaVersion: z.literal('1.0.0'), runId: z.string(), maxSpendUsd: z.literal(0.6),
  providerCalls: z.literal(17), observedCostUsd: z.literal(0.005022), accountedCostUsd: z.literal(0.51),
  openReservationUsd: z.literal(0), entries: z.array(EntrySchema).length(51),
}).strict();
const ResultSchema = z.object({
  schemaVersion: z.literal('1.0.0'), evidenceMode: z.literal('authorized_synthetic_image_grounding_microstudy'),
  generatedAt: z.string().datetime(), fixtureSha256: ShaSchema,
  model: z.literal('gpt-5.6-luna'), reasoningEffort: z.literal('low'),
  plan: z.object({
    syntheticItems: z.literal(6),
    canary: z.object({ proposals: z.literal(2), correctSelfChecks: z.literal(2), seededDefectChecks: z.literal(1), maximumCalls: z.literal(5), conservativeCostUsd: z.literal(0.15) }).strict(),
    full: z.object({ proposals: z.literal(6), correctSelfChecks: z.literal(6), seededDefectChecks: z.literal(5), maximumCalls: z.literal(17), conservativeCostUsd: z.literal(0.51) }).strict(),
    capUsd: z.literal(0.6), fits: z.literal(true),
  }).strict(),
  stoppedAfterCanary: z.literal(false), observations: ObservationsSchema,
  report: z.object({ accepted: z.literal(true) }).passthrough(), ledger: LedgerSchema,
}).strict();
const manifest = ManifestSchema.parse(manifestJson);

export function compileImageGroundingStudyEvidence(input: {
  fixtureRawJson: string;
  resultRawJson: string;
  ledgerRawJsonl: string;
}) {
  if (sha(input.fixtureRawJson) !== manifest.fixtureSha256) throw new Error('Image grounding fixture hash mismatch.');
  if (sha(input.resultRawJson) !== manifest.rawResultSha256) throw new Error('Image grounding result hash mismatch.');
  if (sha(input.ledgerRawJsonl) !== manifest.ledgerSha256) throw new Error('Image grounding ledger hash mismatch.');
  const result = ResultSchema.parse(JSON.parse(input.resultRawJson));
  if (result.fixtureSha256 !== manifest.fixtureSha256) throw new Error('Image grounding result is bound to another fixture.');
  const ledgerEntries = input.ledgerRawJsonl.trim().split('\n').map((line) => EntrySchema.parse(JSON.parse(line)));
  if (!isDeepStrictEqual(ledgerEntries, result.ledger.entries)) throw new Error('Image grounding result ledger does not match its append-only source.');
  verifyLedger(ledgerEntries, result.ledger.runId);
  const observations: GroundingStudyObservations = {
    proposals: result.observations.proposals.map((row) => ({ ...row, selector: row.selector as ImageRegionSelector })),
    correctSelfChecks: result.observations.correctSelfChecks,
    defectSelfChecks: result.observations.defectSelfChecks,
    malformedReplies: result.observations.malformedReplies,
  };
  const corrected = evaluateImageGroundingStudy(input.fixtureRawJson, observations);
  if (!corrected.accepted) throw new Error('Image grounding corrected metrics do not meet the pre-registered gates.');
  return {
    accepted: true,
    evidenceMode: 'authorized_synthetic_image_grounding_microstudy' as const,
    resultSha256: manifest.rawResultSha256,
    ledgerSha256: manifest.ledgerSha256,
    metrics: corrected.metrics,
    spend: {
      maximumProviderCalls: manifest.maximumProviderCalls,
      actualProviderCalls: result.ledger.providerCalls,
      hardCapUsd: result.ledger.maxSpendUsd,
      observedCostUsd: result.ledger.observedCostUsd,
      conservativeAccountedCostUsd: result.ledger.accountedCostUsd,
      openReservationUsd: result.ledger.openReservationUsd,
    },
    rawPointingMetricSuperseded: result.report,
    scope: 'six synthetic diagrams; no learner data' as const,
  };
}

function verifyLedger(entries: z.infer<typeof EntrySchema>[], runId: string): void {
  const calls = new Map<string, typeof entries>();
  entries.forEach((entry, index) => {
    if (entry.sequence !== index + 1 || entry.runId !== runId) throw new Error('Image grounding ledger sequence or run id is invalid.');
    calls.set(entry.callId, [...(calls.get(entry.callId) ?? []), entry]);
  });
  if (calls.size !== 17) throw new Error('Image grounding ledger call count is invalid.');
  for (const rows of calls.values()) {
    if (rows.length !== 3 || rows[0].status !== 'reserved' || rows[1].status !== 'started' || rows[2].status !== 'completed') {
      throw new Error('Image grounding ledger transition is invalid.');
    }
    if (rows[0].providerCallCount !== 0 || rows[1].providerCallCount !== 1 || rows[2].providerCallCount !== 1 || rows[2].usage.length !== 1) {
      throw new Error('Image grounding ledger usage is incomplete.');
    }
  }
  const final = entries.at(-1);
  if (!final || final.cumulativeProviderCalls !== 17 || final.cumulativeAccountedCostUsd !== 0.51 || final.openReservationUsd !== 0) {
    throw new Error('Image grounding ledger final totals are invalid.');
  }
}

function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
