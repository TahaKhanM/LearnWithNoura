import { describe, expect, it } from 'vitest';
import { projectConceptStatus, ResponseTaxonomySchema, TAXONOMY_POLICY } from './pedagogy';

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
});
