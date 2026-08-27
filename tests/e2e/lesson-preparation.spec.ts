import { expect, test } from '@playwright/test';
import { ORIGIN, createSyntheticSession } from '../helpers';

/**
 * Phase 2 session-creation flows: lessons start only from a compiled lesson.
 * The server runs with the deterministic fixture compiler, so a concrete
 * goal compiles immediately, a vague goal yields candidate objectives, and
 * the preparing/failed states are the UI's honest read of the compilation
 * record.
 */

async function createLearner(request: import('@playwright/test').APIRequestContext, suffix: string) {
  const response = await request.post('/api/children', {
    headers: { Origin: ORIGIN },
    data: { name: `Synthetic ${suffix}`, age: 10 },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).child as { id: string; name: string };
}

test('a lesson starts from a precompiled fixture lesson', async ({ page, request }) => {
  const suffix = `prep-${Date.now().toString(36)}`;
  const child = await createLearner(request, suffix);

  await page.goto(`/?selectedChildId=${child.id}`);
  await page.getByTestId('goal-input').fill('Why triangle angles always add up to 180°');
  await page.getByTestId('start-session').click();

  await expect(page).toHaveURL(/\/lesson\//);
  await expect(page.getByRole('button', { name: 'Begin' })).toBeEnabled();

  const sessionId = new URL(page.url()).pathname.split('/').pop() as string;
  const info = await request.get(`/api/sessions/${sessionId}`, { headers: { Origin: ORIGIN } });
  const body = await info.json() as { compilation: { status: string; objective: string | null } | null };
  expect(body.compilation?.status).toBe('ready');
  expect(body.compilation?.objective).toBeTruthy();
});

test('a vague goal offers candidate objectives and the chosen one compiles', async ({ page, request }) => {
  const suffix = `cand-${Date.now().toString(36)}`;
  const child = await createLearner(request, suffix);

  await page.goto(`/?selectedChildId=${child.id}`);
  await page.getByTestId('goal-input').fill('Help my child catch up in school');
  await page.getByTestId('start-session').click();

  // No session exists yet: the parent must choose the concrete focus first.
  const picker = page.getByTestId('objective-candidates');
  await expect(picker).toBeVisible();
  await expect(page).toHaveURL(/\/\?selectedChildId=/);
  const candidates = picker.locator('.home__candidate');
  expect(await candidates.count()).toBeGreaterThanOrEqual(2);

  await candidates.first().click();
  await expect(page).toHaveURL(/\/lesson\//);
  await expect(page.getByRole('button', { name: 'Begin' })).toBeEnabled();
});

test('the preparing state renders while compilation is pending and releases when ready', async ({ page, request }) => {
  const suffix = `pending-${Date.now().toString(36)}`;
  const { child, session } = await createSyntheticSession(request, suffix);

  // The fixture compiler is synchronous, so simulate the live compiler's
  // pending window at the network boundary: every poll sees pending until
  // the test releases the real (ready) record.
  let compilationFinished = false;
  await page.route(`**/api/sessions/${session.id}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { compilation: unknown };
    if (!compilationFinished) {
      body.compilation = { status: 'pending', objective: null, failureReason: null };
    }
    await route.fulfill({ response, json: body });
  });

  await page.goto(`/lesson/${session.id}?selectedChildId=${child.id}`);
  await expect(page.getByTestId('preparing-lesson')).toBeVisible();
  await expect(page.getByTestId('start-lesson')).toBeDisabled();

  // Polling picks up the ready record and only then releases Begin.
  compilationFinished = true;
  await expect(page.getByRole('button', { name: 'Begin' })).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByTestId('preparing-lesson')).toHaveCount(0);
});

test('a failed compilation is an honest error state, never a started lesson', async ({ page, request }) => {
  const suffix = `failed-${Date.now().toString(36)}`;
  const { child, session } = await createSyntheticSession(request, suffix);

  await page.route(`**/api/sessions/${session.id}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { compilation: unknown };
    body.compilation = {
      status: 'failed',
      objective: null,
      failureReason: 'Noura could not build a clear enough board for this goal.',
    };
    await route.fulfill({ response, json: body });
  });

  await page.goto(`/lesson/${session.id}?selectedChildId=${child.id}`);
  await expect(page.getByTestId('compilation-failed')).toBeVisible();
  await expect(page.getByText('Noura couldn’t prepare this lesson.')).toBeVisible();
  await expect(page.getByTestId('start-lesson')).toHaveCount(0);
  await page.getByRole('button', { name: 'Choose another goal' }).click();
  await expect(page).toHaveURL(new RegExp(`/\\?selectedChildId=${child.id}`));
});
