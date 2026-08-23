import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('Home has no serious or critical automated accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Noura' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))).toEqual([]);
});

test('canonical board fixture exposes a programmatic long description', async ({ page }) => {
  await page.goto('/dev/board');
  await page.getByRole('button', { name: 'fractions' }).click();
  const board = page.getByRole('img', { name: 'Shared Noura whiteboard' });
  await expect(board).toHaveAttribute('aria-describedby', 'noura-board-description');
  await expect(page.locator('#noura-board-description')).toContainText('number line');
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
  expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))).toEqual([]);
});
