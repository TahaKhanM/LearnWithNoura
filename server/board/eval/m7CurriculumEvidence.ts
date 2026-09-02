import { createHash } from 'node:crypto';
import { z } from 'zod';
import { loadM7CurriculumFixtures, loadM7CurriculumMatrix } from './m7CurriculumMatrix.js';
import manifestJson from './fixtures/m7-curriculum-evidence-manifest.json' with { type: 'json' };

const ShaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ManifestSchema = z.object({
  schemaVersion: z.literal('1.0.0'), matrixSha256: ShaSchema, baselineFixturesSha256: ShaSchema,
  m7FixturesSha256: ShaSchema, resultSha256: ShaSchema, totalRows: z.literal(39),
  missingRows: z.literal(0), browserAccepted: z.literal(39),
  contactSheetSha256: z.array(ShaSchema).length(4), manuallyInspected: z.literal(true),
}).strict();
const RowSchema = z.object({
  rowId: z.string(), fixtureId: z.string(), policyAccepted: z.literal(true), browserAccepted: z.literal(true),
  reasons: z.array(z.never()).length(0), layoutIssues: z.array(z.never()).length(0),
  firstPaintMs: z.number().int().nonnegative(), rasterSha256: ShaSchema, screenshotPath: z.string(),
}).strict();
const ResultSchema = z.object({
  schemaVersion: z.literal('1.0.0'), evidenceMode: z.literal('offline_loopback_m7_curriculum_browser'),
  generatedAt: z.string().datetime(), accepted: z.literal(true), providerCalls: z.literal(0), externalRequestCount: z.literal(0),
  matrixSha256: ShaSchema, baselineFixturesSha256: ShaSchema, m7FixturesSha256: ShaSchema,
  summary: z.object({
    totalRows: z.literal(39), supportedRows: z.literal(28), composableRows: z.literal(11), missingRows: z.literal(0),
    fixtureRows: z.literal(39), browserAccepted: z.literal(39), maximumFirstPaintMs: z.number().int().nonnegative(),
  }).strict(),
  contactSheets: z.array(z.object({ path: z.string(), sha256: ShaSchema }).strict()).length(4),
  rows: z.array(RowSchema).length(39),
}).strict();
const manifest = ManifestSchema.parse(manifestJson);

export function compileM7CurriculumEvidence(input: {
  matrixRawJson: string;
  baselineFixturesRawJson: string;
  m7FixturesRawJson: string;
  resultRawJson: string;
  screenshots: Record<string, Buffer>;
  contactSheets: Buffer[];
}) {
  const sourceHashes = {
    matrix: hash(input.matrixRawJson),
    baselineFixtures: hash(input.baselineFixturesRawJson),
    m7Fixtures: hash(input.m7FixturesRawJson),
    result: hash(input.resultRawJson),
  };
  if (sourceHashes.matrix !== manifest.matrixSha256 || sourceHashes.baselineFixtures !== manifest.baselineFixturesSha256 ||
      sourceHashes.m7Fixtures !== manifest.m7FixturesSha256 || sourceHashes.result !== manifest.resultSha256) {
    throw new Error('M7 curriculum evidence hash mismatch.');
  }
  const result = ResultSchema.parse(JSON.parse(input.resultRawJson));
  if (result.matrixSha256 !== sourceHashes.matrix || result.baselineFixturesSha256 !== sourceHashes.baselineFixtures || result.m7FixturesSha256 !== sourceHashes.m7Fixtures) {
    throw new Error('M7 curriculum result source binding mismatch.');
  }
  const matrix = loadM7CurriculumMatrix();
  const fixtures = loadM7CurriculumFixtures();
  const expectedBindings = new Set(fixtures.map((fixture) => `${fixture.rowId}:${fixture.id}`));
  const resultBindings = new Set(result.rows.map((row) => `${row.rowId}:${row.fixtureId}`));
  if (expectedBindings.size !== 39 || resultBindings.size !== 39 || [...expectedBindings].some((binding) => !resultBindings.has(binding))) {
    throw new Error('M7 curriculum fixture bindings are incomplete.');
  }
  for (const row of result.rows) {
    const screenshot = input.screenshots[row.rowId];
    if (!screenshot || hash(screenshot) !== row.rasterSha256) throw new Error(`M7 curriculum raster hash mismatch for ${row.rowId}.`);
  }
  if (input.contactSheets.length !== 4 || input.contactSheets.some((sheet, index) => hash(sheet) !== manifest.contactSheetSha256[index] || hash(sheet) !== result.contactSheets[index].sha256)) {
    throw new Error('M7 curriculum contact-sheet hash mismatch.');
  }
  if (matrix.rows.length !== 39 || matrix.m7MissingCapabilities.length !== 0 || matrix.rows.some((row) => (row.status as string) === 'missing')) {
    throw new Error('M7 curriculum matrix still has uncovered rows.');
  }
  return {
    accepted: true,
    resultSha256: sourceHashes.result,
    summary: {
      totalRows: result.summary.totalRows,
      supportedRows: result.summary.supportedRows,
      composableRows: result.summary.composableRows,
      missingRows: result.summary.missingRows,
      browserAccepted: result.summary.browserAccepted,
      maximumFirstPaintMs: result.summary.maximumFirstPaintMs,
    },
    contactSheetsInspected: manifest.manuallyInspected,
    providerCalls: 0,
  };
}

function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
