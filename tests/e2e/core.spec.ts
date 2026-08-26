import { expect, test } from '@playwright/test';
import { createSyntheticSession, ORIGIN } from '../helpers';

test('Noura parent setup, explicit learner handoff, and selection persistence', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Noura/);
  await expect(page.getByRole('heading', { name: 'Noura' })).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://learnwithnoura.com/');

  const suffix = Date.now().toString(36);
  // Wait out the loading state first: a one-shot visibility check during
  // "Loading parent setup…" mistook a first-use database for returning use.
  const createHeading = page.getByRole('heading', { name: 'Create a learner' });
  const addMore = page.getByText('Add another learner');
  await expect(createHeading.or(addMore)).toBeVisible();
  if (!(await createHeading.isVisible())) await addMore.click();
  await page.getByLabel('Name').fill(`Synthetic ${suffix}`);
  await page.getByLabel('Age').fill('10');
  await page.getByRole('button', { name: 'Create learner' }).click();
  await expect(page.getByText(`Setting up for`)).toBeVisible();
  await expect(page.getByText(`Synthetic ${suffix}`, { exact: true }).first()).toBeVisible();
  await page.getByTestId('goal-input').fill('Compare two fractions on one number line');
  await page.getByRole('button', { name: `Hand to Synthetic ${suffix}` }).click();
  await expect(page).toHaveURL(/\/lesson\//);
  await expect(page.getByRole('button', { name: 'Begin' })).toBeVisible();
  await expect(page.getByText(new RegExp(`Hi Synthetic ${suffix}`))).toBeVisible();

  const childId = new URL(page.url()).searchParams.get('selectedChildId');
  expect(childId).toBeTruthy();
  await page.goto(`/?selectedChildId=${childId}`);
  await expect(page.locator('.home__child').filter({ hasText: `Synthetic ${suffix}` })).toHaveAttribute('aria-pressed', 'true');
});

test('direct Parent Area timeline loads and ended sessions are immutable', async ({ page, request }) => {
  const { child, session } = await createSyntheticSession(request, `ended-${Date.now().toString(36)}`);
  const ended = await request.post(`/api/sessions/${session.id}/end`, { headers: { Origin: ORIGIN } });
  expect(ended.ok()).toBe(true);

  await page.goto(`/parent?session=${session.id}&selectedChildId=${child.id}`);
  await expect(page.getByText('Sessions and evidence timeline')).toBeVisible();
  await expect(page.getByText('Loading transcript…')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText('This session recorded no conversation.')).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).overflowY)).toBe('auto');

  await page.goto(`/lesson/${session.id}?selectedChildId=${child.id}`);
  await expect(page.getByRole('heading', { name: 'This session is read-only.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Begin' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue in a new session' }).click();
  await expect(page).toHaveURL(new RegExp('/lesson/(?!' + session.id + ')'));
  await expect(page.getByRole('button', { name: 'Begin' })).toBeVisible();
});

test('active product surfaces contain no legacy brand text', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).not.toContainText(/s[e]neca/i);
  await page.goto('/parent');
  await expect(page.locator('body')).not.toContainText(/s[e]neca/i);
});
