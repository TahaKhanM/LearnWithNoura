import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileCurriculumMatrixEvidence, loadCurriculumFixtures, loadCurriculumMatrix } from './curriculumMatrix.js';
import { validateOps } from '../../../shared/boardOps.js';

const requiredRows = [
  'nvr-shape-sequences', 'nvr-shape-matrices', 'nvr-shape-analogies', 'nvr-shape-codes',
  'nvr-odd-one-out', 'nvr-rotation', 'nvr-reflection', 'nvr-hidden-shapes',
  'nvr-paper-fold-hole-punch', 'nvr-combining-shapes', 'nvr-nets-and-cubes',
  'nvr-rotating-solids', 'nvr-block-building', 'nvr-plan-views',
  'sat-transform-points-and-shapes', 'sat-transform-function-graphs',
  'sat-coordinate-geometry', 'sat-systems-graphs', 'sat-inequalities',
  'sat-scatterplots', 'sat-histograms', 'sat-boxplots', 'sat-two-way-tables',
  'arithmetic-bar-models', 'arithmetic-fraction-strips', 'arithmetic-fraction-areas',
  'arithmetic-fraction-sets', 'arithmetic-ratio-tables', 'arithmetic-number-lines',
  'science-labelled-processes', 'english-grammar-trees', 'humanities-timelines',
  'annotation-tutor-objects', 'annotation-subparts', 'annotation-learner-strokes',
  'annotation-image-regions', 'instruments-grid-paper', 'instruments-clock',
  'instruments-protractor',
].sort();

const expectedMissing = [
  'anchorRef', 'annotate', 'boxplot', 'clock', 'cubeNet', 'gridPaper', 'histogram',
  'imageRegionGrounding', 'isometricSolid', 'panelGrid', 'paperFoldHolePunch',
  'planView', 'protractor', 'regionFill', 'scatter', 'transform',
].sort();

describe('11+/SAT Curriculum Visual Coverage Matrix', () => {
  it('enumerates the full required taxonomy and the explicit M7 missing set', () => {
    const matrix = loadCurriculumMatrix();
    expect(matrix.rows.map((row) => row.id).sort()).toEqual(requiredRows);
    expect(matrix.m7MissingCapabilities.slice().sort()).toEqual(expectedMissing);
    expect(matrix.rows.every((row) => row.evalIntents.length >= 2)).toBe(true);
    expect(matrix.rows.every((row) => row.status === 'missing' || row.missingCapabilities.length === 0)).toBe(true);
    expect(matrix.rows.every((row) => row.status !== 'missing' || row.missingCapabilities.length > 0)).toBe(true);
  });

  it('fixture-backs every supported or composable status with schema-valid BoardOps', () => {
    const matrix = loadCurriculumMatrix();
    const fixtures = new Map(loadCurriculumFixtures().map((fixture) => [fixture.id, fixture]));
    const covered = matrix.rows.filter((row) => row.status !== 'missing');

    expect(covered.length).toBeGreaterThanOrEqual(14);
    for (const row of covered) {
      expect(row.fixtureId, row.id).not.toBeNull();
      const fixture = fixtures.get(row.fixtureId!);
      expect(fixture?.rowId).toBe(row.id);
      expect(validateOps(fixture!.ops).rejected, row.id).toEqual([]);
    }
    expect(fixtures.size).toBe(covered.length);
  });

  it('hash-verifies all covered rows through the real browser preflight artifact', () => {
    const read = (path: string) => readFileSync(resolve(path), 'utf8');
    const evidence = compileCurriculumMatrixEvidence({
      matrixRawJson: read('server/board/eval/curriculum-matrix.json'),
      fixturesRawJson: read('server/board/eval/fixtures/curriculum-matrix-scenes.json'),
      resultRawJson: read('server/board/eval/results/2026-09-02-curriculum-matrix-validation.json'),
    });

    expect(evidence.result.accepted).toBe(true);
    expect(evidence.result.summary).toEqual({
      totalRows: 39,
      supportedRows: 5,
      composableRows: 10,
      missingRows: 24,
      fixtureRows: 15,
      fixturesAccepted: 15,
    });
    expect(evidence.resultSha256).toBe('62d6654d5ea16ae154ba1cfd54d9fc1a41e9fa133b16a2b5e218ffb29553c583');
  });

  it('never overstates the current endpoint as universal open-set coverage', () => {
    const matrix = loadCurriculumMatrix();
    expect(matrix.claim).toBe('bounded_11_plus_and_sat_taxonomy');
    expect(matrix.rows.some((row) => row.status === 'missing')).toBe(true);
    expect(matrix.m7ExitCriterion).toMatch(/every row.*supported|composable/i);
  });
});
