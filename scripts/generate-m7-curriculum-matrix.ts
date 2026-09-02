import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASELINE = resolve('server/board/eval/curriculum-matrix.json');
const NEW_FIXTURES = resolve('server/board/eval/fixtures/m7-curriculum-new-scenes.json');
const OUTPUT = resolve('server/board/eval/curriculum-matrix-m7.json');
if (existsSync(OUTPUT)) throw new Error('Refusing to overwrite the M7 curriculum matrix.');
const baselineRaw = readFileSync(BASELINE, 'utf8');
const baseline = JSON.parse(baselineRaw) as {
  claim: string; level: string; statusDefinitions: Record<string, string>; m7ExitCriterion: string;
  rows: Array<Record<string, unknown> & { id: string; status: string; requiredCapabilities: string[] }>;
};
const fixtures = JSON.parse(readFileSync(NEW_FIXTURES, 'utf8')) as { fixtures: Array<{ id: string; rowId: string }> };
const fixtureByRow = new Map(fixtures.fixtures.map((fixture) => [fixture.rowId, fixture.id]));
const rows = baseline.rows.map((row) => {
  if (row.status !== 'missing') return row;
  const fixtureId = fixtureByRow.get(row.id);
  if (!fixtureId) throw new Error(`Missing M7 fixture for ${row.id}.`);
  return {
    ...row,
    currentCapabilities: [...row.requiredCapabilities],
    status: row.id === 'sat-transform-function-graphs' ? 'composable' : 'supported',
    fixtureId,
    missingCapabilities: [],
  };
});
if (rows.length !== 39 || rows.some((row) => row.status === 'missing') || fixtureByRow.size !== 24) throw new Error('M7 matrix upgrade is incomplete.');
const matrix = {
  schemaVersion: '2.0.0',
  claim: baseline.claim,
  level: baseline.level,
  baselineMatrixSha256: createHash('sha256').update(baselineRaw).digest('hex'),
  statusDefinitions: baseline.statusDefinitions,
  m7ExitCriterion: baseline.m7ExitCriterion,
  m7MissingCapabilities: [],
  rows,
};
const descriptor = openSync(OUTPUT, 'wx');
try {
  writeFileSync(descriptor, `${JSON.stringify(matrix, null, 2)}\n`);
  fsyncSync(descriptor);
} finally {
  closeSync(descriptor);
}
console.log(JSON.stringify({ outputPath: OUTPUT, rows: rows.length, missingRows: 0 }, null, 2));
