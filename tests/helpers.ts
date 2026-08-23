import type { APIRequestContext, Page } from '@playwright/test';

export const ORIGIN = 'http://localhost:5180';

export async function createSyntheticSession(request: APIRequestContext, suffix = Date.now().toString(36)) {
  const childResponse = await request.post('/api/children', {
    headers: { Origin: ORIGIN },
    data: { name: `Synthetic ${suffix}`, age: 10 },
  });
  if (!childResponse.ok()) throw new Error(`child create failed: ${childResponse.status()}`);
  const child = (await childResponse.json()).child as { id: string; name: string };
  const sessionResponse = await request.post('/api/sessions', {
    headers: { Origin: ORIGIN },
    data: { childId: child.id, goal: 'Compare two fractions on one number line' },
  });
  if (!sessionResponse.ok()) throw new Error(`session create failed: ${sessionResponse.status()}`);
  const body = await sessionResponse.json() as { session: { id: string }; lessonCapability?: string };
  return { child, session: body.session, lessonCapability: body.lessonCapability };
}

export async function setLessonCapability(page: Page, sessionId: string, capability?: string) {
  if (!capability) return;
  await page.addInitScript(([key, value]) => sessionStorage.setItem(key, value), [
    `noura.lessonCapability.${sessionId}`,
    capability,
  ]);
}
