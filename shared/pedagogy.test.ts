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
      { evidenceId: '1', taxonomy: 'correct', independent: true, explanationOrApplication: true, laterRetrieval: false, taskId: 'application', opportunityId: 'turn-1', ts: 1 },
      { evidenceId: '2', taxonomy: 'correct', independent: true, explanationOrApplication: false, laterRetrieval: true, taskId: 'retrieval', opportunityId: 'turn-2', retrievalOf: 'application', ts: 2 },
    ])).toBe('demonstrated');
  });

  it('does not count duplicate classifications from the same task and turn', () => {
    expect(projectConceptHistories([
      row('e1', 'correct', 'application', 1, { sessionId: 'same', taskId: 'same', turnId: 'same' }),
      row('e2', 'correct', 'retrieval', 2, { sessionId: 'same', taskId: 'same', turnId: 'same', retrievalOf: 'same' }),
    ])[0]?.status).toBe('progressing');
  });

  it('requires retrieval to follow and identify the earlier learning task', () => {
    expect(projectConceptHistories([
      row('e1', 'correct', 'retrieval', 1, { taskId: 'retrieval', retrievalOf: 'application' }),
      row('e2', 'correct', 'application', 2, { taskId: 'application' }),
    ])[0]?.status).toBe('progressing');
  });

  it('keeps correct plus retrieval plus a later incorrect answer uncertain', () => {
    expect(projectConceptHistories([
      row('e1', 'correct', 'application', 1, { taskId: 'application' }),
      row('e2', 'correct', 'retrieval', 2, { retrievalOf: 'application' }),
      row('e3', 'incorrect', 'recall', 3),
    ])[0]).toMatchObject({ status: 'uncertain', latestEvidenceId: 'e3', hasContradiction: true });
  });

  it('does not leave a demonstrated label after later partial or ambiguous evidence', () => {
    for (const taxonomy of ['partially_correct', 'uncertain_or_ambiguous'] as const) {
      expect(projectConceptHistories([
        row('e1', 'correct', 'application', 1, { taskId: 'application' }),
        row('e2', 'correct', 'retrieval', 2, { retrievalOf: 'application' }),
        row('e3', taxonomy, 'recall', 3),
      ])[0]?.status).not.toBe('demonstrated');
    }
  });

  it('keeps an explicit unresolved contradiction uncertain even when both classifications are positive', () => {
    expect(projectConceptHistories([
      row('e1', 'correct', 'application', 1, { taskId: 'application' }),
      row('e2', 'correct', 'retrieval', 2, { retrievalOf: 'application', contradicts: ['e1'] }),
    ])[0]).toMatchObject({ status: 'uncertain', hasContradiction: true });
  });

  it('keeps a misconception and one explicit correction progressing', () => {
    expect(projectConceptHistories([
      row('e1', 'confident_misconception', 'recall', 1),
      row('e2', 'correct', 'application', 2, { supersedes: ['e1'] }),
    ])[0]).toMatchObject({ status: 'progressing', hasUnresolvedMisconception: false });
  });

  it('requires confirmation beyond explicit resolution before demonstrated', () => {
    const conservative = projectConceptHistories([
      row('e1', 'confident_misconception', 'recall', 1),
      row('e2', 'correct', 'application', 2, { taskId: 'resolution', supersedes: ['e1'] }),
      row('e3', 'correct', 'retrieval', 3, { retrievalOf: 'resolution' }),
    ])[0];
    expect(conservative).toMatchObject({ status: 'progressing', hasContradiction: true, hasUnresolvedMisconception: false });

    const confirmed = projectConceptHistories([
      row('e1', 'confident_misconception', 'recall', 1),
      row('e2', 'correct', 'recall', 2, { supersedes: ['e1'] }),
      row('e3', 'correct', 'application', 3, { taskId: 'fresh-application' }),
      row('e4', 'correct', 'retrieval', 4, { retrievalOf: 'fresh-application' }),
    ])[0];
    expect(confirmed).toMatchObject({ status: 'demonstrated', hasUnresolvedMisconception: false });
  });

  it('permits a genuine later retrieval across sessions', () => {
    expect(projectConceptHistories([
      row('e1', 'correct', 'application', 1, { sessionId: 'session-1', taskId: 'source-task' }),
      row('e2', 'correct', 'retrieval', 2, { sessionId: 'session-2', retrievalOf: 'source-task' }),
    ])[0]?.status).toBe('demonstrated');
  });
});

function row(
  evidenceId: string,
  taxonomy: Parameters<typeof projectConceptStatus>[0][number]['taxonomy'],
  opportunityKind: 'recall' | 'explanation' | 'application' | 'retrieval',
  ts: number,
  overrides: Partial<Parameters<typeof projectConceptHistories>[0][number]> = {},
) {
  return {
    evidenceId,
    concept: 'fractions',
    conceptId: 'fractions',
    taxonomy,
    independenceLevel: 'independent' as const,
    opportunityKind,
    taskId: `task-${evidenceId}`,
    sessionId: 'session',
    turnId: `turn-${evidenceId}`,
    ts,
    retrievalOf: null,
    contradicts: [],
    supersedes: [],
    ...overrides,
  };
}
