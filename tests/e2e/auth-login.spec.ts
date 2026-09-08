import { expect, test } from '@playwright/test';

test('required login gates the application and releases it after valid credentials', async ({ page }) => {
  await page.route('**/api/auth/session', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ required: true, authenticated: false }) });
  });
  await page.route('**/api/auth/login', async (route) => {
    const body = route.request().postDataJSON() as { email?: string; password?: string };
    if (body.email === 'demo@example.test' && body.password === 'fixture-password') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, email: body.email }) });
    } else {
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'The email or password is incorrect.' }) });
    }
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Open Noura’s teaching board' })).toBeVisible();
  await expect(page.locator('#login-password')).toHaveAttribute('autocomplete', 'current-password');
  await page.getByLabel('Email address').fill('demo@example.test');
  await page.locator('#login-password').fill('fixture-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'LearnWithNoura' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
});
