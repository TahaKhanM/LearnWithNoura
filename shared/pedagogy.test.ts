import { describe, expect, it } from 'vitest';
import { projectConceptHistories, projectConceptStatus, ResponseTaxonomySchema, TAXONOMY_POLICY } from './pedagogy';

describe('pedagogy taxonomy and projection', () => {
  it('defines policy for every response class', () => {
    for (const classification of ResponseTaxonomySchema.options) expect(TAXONOMY_POLICY[classification]).toBeTruthy();
  });

  it('never treats one correct answer as demonstrated understanding', () => {
    expect(projectConceptStatus([{ evidenceId: '1', taxonomy: 'correct', independent: true, explanationOrApplication: true, laterRetrieval: false }])).toBe('progressing');
  });

  it('preserves contradiction and blocks unresolved confident misconceptions', () => {
    expect(projectConceptStatus([
      { evidenceId: '1', taxonomy: 'correct', independent: true, explanationOrApplication: true, laterRetrieval: false },
      { evidenceId: '2', taxonomy: 'confident_misconception', independent: true, explanationOrApplication: false, laterRetrieval: false },
    ])).toBe('uncertain');
  });

  it('requires multiple independent opportunities, transfer, and retrieval', () => {
    expect(projectConceptStatus([
      { evidenceId: '1', taxonomy: 'correct', independent: true, explanationOrApplication: true, laterRetrieval: false },
      { evidenceId: '2', taxonomy: 'correct', independent: true, explanationOrApplication: false, laterRetrieval: true },
    ])).toBe('demonstrated');
  });

  it('projects the complete ordered history and preserves later improvement', () => {
    const history = projectConceptHistories([
      { evidenceId: '1', concept: 'fractions', conceptId: 'fractions', taxonomy: 'confident_misconception', independenceLevel: 'independent', opportunityKind: 'recall', taskId: 'a', sessionId: 's', turnId: 't1', ts: 1 },
      { evidenceId: '2', concept: 'fractions', conceptId: 'fractions', taxonomy: 'correct', independenceLevel: 'independent', opportunityKind: 'application', taskId: 'b', sessionId: 's', turnId: 't2', ts: 2 },
      { evidenceId: '3', concept: 'fractions', conceptId: 'fractions', taxonomy: 'correct', independenceLevel: 'independent', opportunityKind: 'retrieval', taskId: 'c', sessionId: 's2', turnId: 't3', ts: 3 },
    ]);
    expect(history[0]).toMatchObject({ status: 'demonstrated', hasContradiction: true, hasUnresolvedMisconception: false });
  });
});
