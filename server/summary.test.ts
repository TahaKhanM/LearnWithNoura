import { describe, expect, it } from 'vitest';
import { validateSummaryCitations } from './summary';
import type { EvidenceRow } from './store/repo';

const evidence = [{ evidenceId: 'evidence-1' }] as EvidenceRow[];
const base = {
  headline: 'Session update.', workedOn: ['fractions'],
  strengths: [{ concept: 'fractions', evidence: 'The learner said “two thirds is farther right”.', evidenceIds: ['evidence-1'] }],
  struggles: [], recommendation: 'Try another fraction comparison.', recommendationEvidenceIds: ['evidence-1'],
  confidenceNote: 'Limited evidence.',
};

describe('summary lineage validation', () => {
  it('accepts only existing evidence IDs and matching quotes', () => {
    expect(validateSummaryCitations(base, evidence, 'Learner: two thirds is farther right')).toBe(true);
  });
  it('rejects unsupported citations and invented quotes', () => {
    expect(validateSummaryCitations({ ...base, recommendationEvidenceIds: ['missing'] }, evidence, 'Learner: two thirds is farther right')).toBe(false);
    expect(validateSummaryCitations({ ...base, strengths: [{ ...base.strengths[0], evidence: 'The learner said “I mastered it”.' }] }, evidence, 'Learner: two thirds is farther right')).toBe(false);
  });
});
