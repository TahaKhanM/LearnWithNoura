import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validateOps, type BoardOp } from '../../../shared/boardOps.js';
import matrixJson from './curriculum-matrix.json' with { type: 'json' };
import fixtureJson from './fixtures/curriculum-matrix-scenes.json' with { type: 'json' };
import manifestJson from './fixtures/curriculum-matrix-evidence-manifest.json' with { type: 'json' };

const StatusSchema = z.enum(['supported', 'composable', 'missing']);
const CurriculumRowSchema = z.object({
  id: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  domain: z.string().min(1).max(100),
  family: z.string().min(1).max(100),
  visualType: z.string().min(1).max(120),
  requiredCapabilities: z.array(z.string().min(1).max(80)).min(1),
  currentCapabilities: z.array(z.string().min(1).max(80)),
  status: StatusSchema,
  routeHint: z.enum(['template_then_generative', 'generative']),
  template: z.string().min(1).max(80).nullable(),
  fixtureId: z.string().min(1).max(120).nullable(),
  missingCapabilities: z.array(z.string().min(1).max(80)),
  evalIntents: z.array(z.string().min(10).max(300)).min(2),
}).strict().superRefine((row, context) => {
  if (row.status === 'missing' && row.missingCapabilities.length === 0) {
    context.addIssue({ code: 'custom', path: ['missingCapabilities'], message: 'Missing rows require at least one named capability.' });
  }
  if (row.status !== 'missing' && (row.missingCapabilities.length > 0 || !row.fixtureId)) {
    context.addIssue({ code: 'custom', path: ['fixtureId'], message: 'Covered rows require a fixture and no missing capabilities.' });
  }
});
const CurriculumMatrixSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  claim: z.literal('bounded_11_plus_and_sat_taxonomy'),
  level: z.string().min(1),
  statusDefinitions: z.object({
    supported: z.string().min(1),
    composable: z.string().min(1),
    missing: z.string().min(1),
  }).strict(),
  m7ExitCriterion: z.string().min(1),
  m7MissingCapabilities: z.array(z.string().min(1)).min(1),
  rows: z.array(CurriculumRowSchema).min(1),
}).strict().superRefine((matrix, context) => {
  const ids = matrix.rows.map((row) => row.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['rows'], message: 'Row ids must be unique.' });
  const missing = new Set(matrix.rows.flatMap((row) => row.missingCapabilities));
  const declared = new Set(matrix.m7MissingCapabilities);
  if (missing.size !== declared.size || [...missing].some((capability) => !declared.has(capability))) {
    context.addIssue({ code: 'custom', path: ['m7MissingCapabilities'], message: 'M7 missing set must exactly match missing row capabilities.' });
  }
});
const FixtureSourceSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  fixtures: z.array(z.object({
    id: z.string().min(1).max(120),
    rowId: z.string().min(1).max(100),
    ops: z.array(z.unknown()).min(1),
  }).strict()).min(1),
}).strict();
const ManifestSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  matrixPath: z.string(),
  matrixSha256: z.string().regex(/^[a-f0-9]{64}$/),
  fixturesPath: z.string(),
  fixturesSha256: z.string().regex(/^[a-f0-9]{64}$/),
  resultPath: z.string(),
  resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
  acceptedFixtureRows: z.number().int().positive(),
  totalRows: z.number().int().positive(),
  missingRows: z.number().int().nonnegative(),
}).strict();
const ResultSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  evidenceMode: z.literal('offline_loopback_browser_fixture_validation'),
  generatedAt: z.string().datetime(),
  accepted: z.literal(true),
  providerCalls: z.literal(0),
  externalRequestCount: z.literal(0),
  matrixSha256: z.string(),
  fixturesSha256: z.string(),
  summary: z.object({
    totalRows: z.number().int(),
    supportedRows: z.number().int(),
    composableRows: z.number().int(),
    missingRows: z.number().int(),
    fixtureRows: z.number().int(),
    fixturesAccepted: z.number().int(),
  }).strict(),
  m7MissingCapabilities: z.array(z.string()),
  rows: z.array(z.object({
    rowId: z.string(),
    fixtureId: z.string(),
    policyAccepted: z.literal(true),
    browserAccepted: z.literal(true),
    reasons: z.array(z.never()).length(0),
    layoutIssues: z.array(z.never()).length(0),
    rasterSha256: z.string().regex(/^[a-f0-9]{64}$/),
    screenshotPath: z.string().min(1),
  }).strict()),
}).strict();
const manifest = ManifestSchema.parse(manifestJson);

export type CurriculumMatrix = z.infer<typeof CurriculumMatrixSchema>;
export interface CurriculumFixture {
  id: string;
  rowId: string;
  ops: BoardOp[];
}

export function loadCurriculumMatrix(): CurriculumMatrix {
  return CurriculumMatrixSchema.parse(matrixJson);
}

export function loadCurriculumFixtures(): CurriculumFixture[] {
  const source = FixtureSourceSchema.parse(fixtureJson);
  const fixtures = source.fixtures.map((fixture) => {
    const validated = validateOps(fixture.ops);
    if (validated.rejected.length > 0 || validated.ops.length !== fixture.ops.length) {
      throw new Error(`Curriculum fixture ${fixture.id} contains rejected BoardOps.`);
    }
    return { id: fixture.id, rowId: fixture.rowId, ops: validated.ops };
  });
  if (new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length) {
    throw new Error('Curriculum fixture ids must be unique.');
  }
  const matrix = loadCurriculumMatrix();
  const coveredRows = new Map(matrix.rows.filter((row) => row.status !== 'missing').map((row) => [row.id, row.fixtureId]));
  for (const fixture of fixtures) {
    if (coveredRows.get(fixture.rowId) !== fixture.id) throw new Error(`Curriculum fixture ${fixture.id} is not bound to its matrix row.`);
  }
  if (fixtures.length !== coveredRows.size) throw new Error('Each covered curriculum row must have exactly one fixture.');
  return fixtures;
}

export function compileCurriculumMatrixEvidence(input: {
  matrixRawJson: string;
  fixturesRawJson: string;
  resultRawJson: string;
}) {
  const matrixSha256 = sha256(input.matrixRawJson);
  const fixturesSha256 = sha256(input.fixturesRawJson);
  const resultSha256 = sha256(input.resultRawJson);
  if (matrixSha256 !== manifest.matrixSha256 || fixturesSha256 !== manifest.fixturesSha256 || resultSha256 !== manifest.resultSha256) {
    throw new Error('Curriculum matrix evidence SHA-256 does not match the manifest.');
  }
  const matrix = CurriculumMatrixSchema.parse(JSON.parse(input.matrixRawJson));
  const fixtures = FixtureSourceSchema.parse(JSON.parse(input.fixturesRawJson));
  const result = ResultSchema.parse(JSON.parse(input.resultRawJson));
  const covered = matrix.rows.filter((row) => row.status !== 'missing');
  const statusCounts = {
    supported: matrix.rows.filter((row) => row.status === 'supported').length,
    composable: matrix.rows.filter((row) => row.status === 'composable').length,
    missing: matrix.rows.filter((row) => row.status === 'missing').length,
  };
  const resultBindings = new Set(result.rows.map((row) => `${row.rowId}:${row.fixtureId}`));
  const expectedBindings = new Set(fixtures.fixtures.map((fixture) => `${fixture.rowId}:${fixture.id}`));
  if (resultBindings.size !== expectedBindings.size || [...expectedBindings].some((binding) => !resultBindings.has(binding))) {
    throw new Error('Curriculum browser results do not cover the exact fixture set.');
  }
  if (
    matrixSha256 !== result.matrixSha256 || fixturesSha256 !== result.fixturesSha256 ||
    matrix.rows.length !== manifest.totalRows || statusCounts.missing !== manifest.missingRows ||
    covered.length !== manifest.acceptedFixtureRows || fixtures.fixtures.length !== covered.length ||
    result.summary.totalRows !== matrix.rows.length || result.summary.supportedRows !== statusCounts.supported ||
    result.summary.composableRows !== statusCounts.composable || result.summary.missingRows !== statusCounts.missing ||
    result.summary.fixtureRows !== covered.length || result.summary.fixturesAccepted !== covered.length ||
    JSON.stringify(result.m7MissingCapabilities) !== JSON.stringify(matrix.m7MissingCapabilities)
  ) {
    throw new Error('Curriculum matrix evidence summary does not reproduce from its sources.');
  }
  return { matrix, result, matrixSha256, fixturesSha256, resultSha256 };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
