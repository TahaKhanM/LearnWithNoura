import { describe, expect, it } from 'vitest';
import { buildDeterministicSummary, validateSummaryCitations } from './summary';
import type { EvidenceOpportunityKind, ResponseTaxonomy } from '../shared/pedagogy';
import type { EvidenceRow } from './store/repo';

function observation(
  id: string,
  taxonomy: ResponseTaxonomy,
  opportunityKind: EvidenceOpportunityKind = 'recall',
  overrides: Partial<EvidenceRow> = {},
): EvidenceRow {
  return {
    id: Number(id.replace(/\D/g, '')) || 1,
    sessionId: 'session-1',
    ts: Number(id.replace(/\D/g, '')) || 1,
    concept: 'fraction comparison',
    observation: `Observation ${id}`,
    verdict: taxonomy === 'confident_misconception' ? 'misconception' : ['incorrect', 'missing_prerequisite'].includes(taxonomy) ? 'struggling' : 'progressing',
    confidence: 'medium',
    excerpt: null,
    evidenceId: id,
    childId: 'child-1',
    conceptId: 'fraction-comparison',
    taxonomy,
    confidenceBasis: 'Deterministic test fixture.',
    sourceEventIds: [1],
    normalizedExcerpt: '',
    sourceSpan: null,
    taskId: `task-${id}`,
    independenceLevel: taxonomy === 'self_corrected' ? 'reduced' : 'independent',
    domainCheck: null,
    turnId: `turn-${id}`,
    generationId: `generation-${id}`,
    contradicts: [],
    supersedes: [],
    opportunityKind,
    retrievalOf: opportunityKind === 'retrieval' ? 'task-e1' : null,
    ...overrides,
  };
}

const base = {
  headline: 'Session update.', workedOn: ['fractions'],
  strengths: [{ concept: 'fractions', evidence: 'The learner said “two thirds is farther right”.', status: 'progressing' as const, evidenceIds: ['e1'] }],
  struggles: [], recommendation: 'Try another fraction comparison.', recommendationEvidenceIds: ['e1'],
  confidenceNote: 'Limited evidence.',
};

describe('summary lineage and calibration', () => {
  it('accepts existing evidence IDs, matching quotes, and the authoritative progressing label', () => {
    expect(validateSummaryCitations(base, [observation('e1', 'correct')], 'Learner: two thirds is farther right')).toBe(true);
  });

  it('rejects unsupported citations, invented quotes, and a one-answer demonstrated claim', () => {
    const evidence = [observation('e1', 'correct')];
    expect(validateSummaryCitations({ ...base, recommendationEvidenceIds: ['missing'] }, evidence, 'Learner: two thirds is farther right')).toBe(false);
    expect(validateSummaryCitations({ ...base, strengths: [{ ...base.strengths[0], evidence: 'The learner said “I mastered it”.' }] }, evidence, 'Learner: two thirds is farther right')).toBe(false);
    expect(validateSummaryCitations({ ...base, strengths: [{ ...base.strengths[0], status: 'demonstrated' }] }, evidence, 'Learner: two thirds is farther right')).toBe(false);
  });

  it('requires independent explanation/application plus later retrieval before demonstrated', () => {
    const evidence = [
      observation('e1', 'correct', 'application'),
      observation('e2', 'correct', 'retrieval'),
    ];
    const summary = buildDeterministicSummary('Maya', 'fractions', evidence, 2);
    expect(summary.strengths).toEqual([expect.objectContaining({ status: 'demonstrated', evidenceIds: ['e1', 'e2'] })]);
  });

  it('keeps self-correction progressing and contradictions uncertain', () => {
    const selfCorrected = buildDeterministicSummary('Maya', 'fractions', [observation('e1', 'self_corrected', 'explanation')], 1);
    expect(selfCorrected.strengths[0]?.status).toBe('progressing');

    const contradicted = buildDeterministicSummary('Maya', 'fractions', [
      observation('e1', 'correct', 'application'),
      observation('e2', 'incorrect', 'retrieval'),
    ], 2);
    expect(contradicted.strengths).toEqual([]);
    expect(contradicted.struggles[0]).toMatchObject({ kind: 'uncertain' });
  });

  it('shows unresolved misconception, then later independent improvement without overclaiming', () => {
    const unresolved = buildDeterministicSummary('Maya', 'fractions', [observation('e1', 'confident_misconception')], 1);
    expect(unresolved.struggles[0]).toMatchObject({ kind: 'misconception' });

    const improved = buildDeterministicSummary('Maya', 'fractions', [
      observation('e1', 'confident_misconception'),
      observation('e2', 'correct', 'application'),
      observation('e3', 'correct', 'retrieval'),
    ], 3);
    expect(improved.strengths[0]?.status).toBe('demonstrated');
    expect(improved.struggles).toEqual([]);
  });
});
