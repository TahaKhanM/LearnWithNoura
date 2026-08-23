import { expect, test } from '@playwright/test';

test('Parent Area calibrates one answer, retrieval, self-correction, contradiction, resolution, and later improvement', async ({ page }) => {
  const child = { id: 'child-evidence', name: 'Maya', age: 10 };
  const now = Date.now();
  const evidence = [
    row(1, 'single correct', 'correct', 'recall'),
    row(2, 'retrieved concept', 'correct', 'application'),
    row(3, 'retrieved concept', 'correct', 'retrieval', 'independent', { retrievalOf: 'task-2' }),
    row(4, 'self corrected concept', 'self_corrected', 'explanation', 'reduced'),
    row(5, 'contradicted concept', 'correct', 'application'),
    row(6, 'contradicted concept', 'incorrect', 'retrieval'),
    row(7, 'resolved misconception', 'confident_misconception', 'recall'),
    row(8, 'resolved misconception', 'correct', 'application', 'independent', { supersedes: ['evidence-7'] }),
    row(9, 'resolved misconception', 'correct', 'retrieval', 'independent', { retrievalOf: 'task-8' }),
  ].map((entry, index) => ({ ...entry, ts: now + index }));
  const summary = {
    headline: 'Maya compared fractions using several recorded opportunities.',
    workedOn: ['fraction comparison'],
    strengths: [
      { concept: 'single correct', evidence: 'One correct response.', status: 'progressing', evidenceIds: ['evidence-1'] },
      { concept: 'retrieved concept', evidence: 'Applied and later retrieved.', status: 'demonstrated', evidenceIds: ['evidence-2', 'evidence-3'] },
    ],
    struggles: [{ concept: 'contradicted concept', evidence: 'Later evidence differed.', kind: 'uncertain', evidenceIds: ['evidence-5', 'evidence-6'] }],
    recommendation: 'Revisit the contradicted concept independently.',
    confidenceNote: 'Labels reflect the complete evidence history.',
  };
  await page.route('**/api/children', (route) => route.fulfill({ json: { children: [child] } }));
  await page.route('**/api/children/child-evidence/overview', (route) => route.fulfill({ json: {
    child,
    sessions: [{ id: 'session-evidence', goal: 'fractions', status: 'ended', startedAt: now, endedAt: now + 20, summary }],
    evidence: [...evidence].reverse(),
  } }));

  await page.goto('/parent?selectedChildId=child-evidence');
  await expect(page.getByRole('heading', { name: 'Demonstrated across opportunities' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Progressing', exact: true })).toBeVisible();
  await expect(page.getByText('single correct.', { exact: false }).first()).toBeVisible();

  await expectConceptStatus(page, 'single correct', 'Progressing');
  await expectConceptStatus(page, 'retrieved concept', 'Demonstrated');
  await expectConceptStatus(page, 'self corrected concept', 'Progressing');
  await expectConceptStatus(page, 'contradicted concept', 'Uncertain');
  await expectConceptStatus(page, 'resolved misconception', 'Progressing');
  const improved = page.locator('.parent__concepts li').filter({ hasText: 'resolved misconception' });
  await expect(improved.getByText('View 2 earlier observations')).toBeVisible();
  await improved.getByText('View 2 earlier observations').click();
  await expect(improved).toContainText('Observation 7');
  await expect(improved).toContainText('Evidence differs across opportunities');
});

async function expectConceptStatus(page: import('@playwright/test').Page, concept: string, status: string) {
  const item = page.locator('.parent__concepts li').filter({ hasText: concept });
  await expect(item.locator('.parent__verdict')).toHaveText(status);
}

function row(
  id: number,
  concept: string,
  taxonomy: string,
  opportunityKind: string,
  independenceLevel = 'independent',
  lineage: { retrievalOf?: string; supersedes?: string[] } = {},
) {
  return {
    id,
    sessionId: 'session-evidence',
    concept,
    conceptId: concept.replace(/\s+/g, '-'),
    observation: `Observation ${id}`,
    verdict: taxonomy === 'confident_misconception' ? 'misconception' : taxonomy === 'incorrect' ? 'struggling' : 'progressing',
    confidence: 'medium',
    excerpt: null,
    goal: 'fractions',
    evidenceId: `evidence-${id}`,
    taxonomy,
    independenceLevel,
    opportunityKind,
    taskId: `task-${id}`,
    turnId: `turn-${id}`,
    retrievalOf: lineage.retrievalOf ?? null,
    contradicts: [],
    supersedes: lineage.supersedes ?? [],
  };
}
