import { z } from 'zod';
import { validateOps, type BoardOp } from '../../../shared/boardOps.js';
import { learnerBoardOps } from '../../../shared/learnerSubmissionOps.js';
import matrixJson from './curriculum-matrix-m7.json' with { type: 'json' };
import baselineFixturesJson from './fixtures/curriculum-matrix-scenes.json' with { type: 'json' };
import m7FixturesJson from './fixtures/m7-curriculum-new-scenes.json' with { type: 'json' };

const RowSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), domain: z.string(), family: z.string(), visualType: z.string(),
  requiredCapabilities: z.array(z.string()).min(1), currentCapabilities: z.array(z.string()).min(1),
  status: z.enum(['supported', 'composable']), routeHint: z.enum(['template_then_generative', 'generative']),
  template: z.string().nullable(), fixtureId: z.string(), missingCapabilities: z.array(z.never()).length(0),
  evalIntents: z.array(z.string()).min(2),
}).strict();
const MatrixSchema = z.object({
  schemaVersion: z.literal('2.0.0'), claim: z.literal('bounded_11_plus_and_sat_taxonomy'),
  level: z.string(), baselineMatrixSha256: z.literal('bad84b66a673df27841c19fd6c20d921c9c084c190618b3492adea941d13664a'),
  statusDefinitions: z.object({ supported: z.string(), composable: z.string(), missing: z.string() }).strict(),
  m7ExitCriterion: z.string(), m7MissingCapabilities: z.array(z.never()).length(0),
  rows: z.array(RowSchema).length(39),
}).strict();
const BaselineFixturesSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  fixtures: z.array(z.object({ id: z.string(), rowId: z.string(), ops: z.array(z.unknown()).min(1) }).strict()).length(15),
}).strict();
const M7FixturesSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  fixtures: z.array(z.object({
    id: z.string(), rowId: z.string(), existingTutorOps: z.array(z.unknown()),
    existingLearnerOps: z.array(z.unknown()), candidateOps: z.array(z.unknown()).min(1),
  }).strict()).length(24),
}).strict();

export interface M7CurriculumFixture {
  id: string;
  rowId: string;
  existingTutorOps: BoardOp[];
  existingLearnerOps: BoardOp[];
  candidateOps: BoardOp[];
}

export function loadM7CurriculumMatrix() {
  const matrix = MatrixSchema.parse(matrixJson);
  if (new Set(matrix.rows.map((row) => row.id)).size !== 39) throw new Error('M7 curriculum row ids must be unique.');
  return matrix;
}

export function loadM7CurriculumFixtures(): M7CurriculumFixture[] {
  const baseline = BaselineFixturesSchema.parse(baselineFixturesJson).fixtures.map((fixture) => ({
    id: fixture.id, rowId: fixture.rowId, existingTutorOps: [] as BoardOp[], existingLearnerOps: [] as BoardOp[],
    candidateOps: authoredOps(fixture.ops, fixture.id),
  }));
  const added = M7FixturesSchema.parse(m7FixturesJson).fixtures.map((fixture) => ({
    id: fixture.id,
    rowId: fixture.rowId,
    existingTutorOps: authoredOps(fixture.existingTutorOps, fixture.id),
    existingLearnerOps: learnerBoardOps(fixture.existingLearnerOps, { trustPersistedManipulativeUpdates: true }),
    candidateOps: authoredOps(fixture.candidateOps, fixture.id),
  }));
  const fixtures = [...baseline, ...added];
  if (fixtures.length !== 39 || new Set(fixtures.map((fixture) => fixture.id)).size !== 39) throw new Error('M7 curriculum fixtures must be unique and complete.');
  const matrix = loadM7CurriculumMatrix();
  const fixtureByRow = new Map(fixtures.map((fixture) => [fixture.rowId, fixture.id]));
  for (const row of matrix.rows) if (fixtureByRow.get(row.id) !== row.fixtureId) throw new Error(`M7 fixture binding mismatch for ${row.id}.`);
  for (const fixture of added) {
    const raw = M7FixturesSchema.parse(m7FixturesJson).fixtures.find((candidate) => candidate.id === fixture.id)!;
    if (fixture.existingLearnerOps.length !== raw.existingLearnerOps.length) throw new Error(`M7 learner context rejected in ${fixture.id}.`);
  }
  return fixtures;
}

function authoredOps(raw: unknown[], fixtureId: string): BoardOp[] {
  const validated = validateOps(raw, { tier: 'authored' });
  if (validated.rejected.length > 0 || validated.ops.length !== raw.length) {
    throw new Error(`M7 curriculum fixture ${fixtureId} contains rejected authored operations: ${validated.rejected.map((entry) => entry.reason).join(', ')}`);
  }
  return validated.ops;
}
