import { createHash } from 'node:crypto';
import { z } from 'zod';
import manifestJson from './fixtures/m7-relational-evidence-manifest.json' with { type: 'json' };

const ShaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ManifestSchema = z.object({
  schemaVersion: z.literal('1.0.0'), sourceSha256: ShaSchema, resultSha256: ShaSchema,
  sourceRows: z.literal(36), eligibleRelationalRows: z.literal(34), originalValidatorAcceptedRows: z.literal(32),
  relationalRecoveredRows: z.literal(2), acceptedRows: z.literal(34), singleShotConjunctiveValidity: z.literal(1),
  threshold: z.literal(0.95), providerCalls: z.literal(0),
}).strict();
const RowSchema = z.object({
  intentId: z.string(),
  sourceTrial: z.object({ conditionId: z.literal('terra-low'), cacheState: z.literal('cold'), trial: z.literal(1) }).strict(),
  relationalPlacementCount: z.number().int().min(0).max(1), strictValid: z.literal(true),
  originalValidatorPassed: z.boolean(), authoredPolicyAccepted: z.literal(true), browserAccepted: z.literal(true),
  reasons: z.array(z.never()).length(0), layoutIssues: z.array(z.never()).length(0), accepted: z.literal(true),
}).strict();
const ResultSchema = z.object({
  schemaVersion: z.literal('1.0.0'), evidenceMode: z.literal('offline_m0_representative_relational_replay'),
  generatedAt: z.string().datetime(), accepted: z.literal(true), providerCalls: z.literal(0), externalRequestCount: z.literal(0),
  sourceSha256: ShaSchema, selection: z.literal('first cold terra-low trial for each of 36 M0 intents'),
  summary: z.object({
    sourceRows: z.literal(36), rows: z.literal(34), rowsWithRelationalPlacement: z.literal(34),
    originalValidatorAcceptedRows: z.literal(32), relationalRecoveredRows: z.literal(2), acceptedRows: z.literal(34),
    singleShotConjunctiveValidity: z.literal(1), threshold: z.literal(0.95),
  }).strict(),
  rows: z.array(RowSchema).length(36),
}).strict();
const M0Schema = z.object({
  trials: z.array(z.object({
    intentId: z.string(), conditionId: z.string(), cacheState: z.string(), trial: z.number().int(),
  }).passthrough()),
}).passthrough();
const manifest = ManifestSchema.parse(manifestJson);

export function compileM7RelationalEvidence(input: { m0RawJson: string; resultRawJson: string }) {
  const sourceSha256 = hash(input.m0RawJson); const resultSha256 = hash(input.resultRawJson);
  if (sourceSha256 !== manifest.sourceSha256 || resultSha256 !== manifest.resultSha256) throw new Error('M7 relational evidence hash mismatch.');
  const result = ResultSchema.parse(JSON.parse(input.resultRawJson));
  if (result.sourceSha256 !== sourceSha256) throw new Error('M7 relational replay source binding mismatch.');
  const m0 = M0Schema.parse(JSON.parse(input.m0RawJson));
  const selectedIds = m0.trials.filter((row) => row.conditionId === 'terra-low' && row.cacheState === 'cold' && row.trial === 1).map((row) => row.intentId);
  if (selectedIds.length !== 36 || new Set(selectedIds).size !== 36 || new Set(result.rows.map((row) => row.intentId)).size !== 36 || selectedIds.some((id) => !result.rows.some((row) => row.intentId === id))) {
    throw new Error('M7 relational replay does not reproduce its representative selection.');
  }
  const cohort = result.rows.filter((row) => row.relationalPlacementCount > 0);
  const originalAccepted = cohort.filter((row) => row.originalValidatorPassed).length;
  const recovered = cohort.filter((row) => !row.originalValidatorPassed && row.accepted).length;
  const accepted = cohort.filter((row) => row.accepted).length;
  if (cohort.length !== manifest.eligibleRelationalRows || originalAccepted !== manifest.originalValidatorAcceptedRows || recovered !== manifest.relationalRecoveredRows || accepted !== manifest.acceptedRows) {
    throw new Error('M7 relational replay summary does not reproduce from rows.');
  }
  return {
    accepted: accepted / cohort.length >= manifest.threshold,
    sourceSha256,
    resultSha256,
    sourceRows: manifest.sourceRows,
    eligibleRelationalRows: cohort.length,
    originalValidatorAcceptedRows: originalAccepted,
    relationalRecoveredRows: recovered,
    acceptedRows: accepted,
    singleShotConjunctiveValidity: accepted / cohort.length,
    threshold: manifest.threshold,
    providerCalls: result.providerCalls,
  };
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
