import { describe, expect, it } from 'vitest';
import { applyDirectorBoardPolicy } from '../directorSchema.js';
import { loadM7CurriculumFixtures, loadM7CurriculumMatrix } from './m7CurriculumMatrix.js';

describe('M7 curriculum coverage matrix', () => {
  it('covers all 39 bounded taxonomy rows with one real fixture each', () => {
    const matrix = loadM7CurriculumMatrix();
    const fixtures = loadM7CurriculumFixtures();
    expect(matrix.rows).toHaveLength(39);
    expect(matrix.rows.filter((row) => (row.status as string) === 'missing')).toEqual([]);
    expect(matrix.m7MissingCapabilities).toEqual([]);
    expect(fixtures).toHaveLength(39);
    expect(new Set(fixtures.map((fixture) => fixture.rowId))).toEqual(new Set(matrix.rows.map((row) => row.id)));
  });

  it('keeps every candidate inside the authored Director policy', () => {
    for (const fixture of loadM7CurriculumFixtures()) {
      const visibleObjectIds = [...fixture.existingTutorOps, ...fixture.existingLearnerOps]
        .flatMap((op) => op.op === 'add' ? [op.id] : []);
      const policy = applyDirectorBoardPolicy(fixture.candidateOps, { density: 'standard', visibleObjectIds });
      expect(policy.ok, `${fixture.rowId}: ${policy.ok ? '' : policy.reasons.join(', ')}`).toBe(true);
    }
  });
});
