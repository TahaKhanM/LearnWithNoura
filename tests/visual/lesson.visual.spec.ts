import { expect, test } from '@playwright/test';
import { installFakeRealtime, setLessonCapability } from '../helpers';

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`Lesson board awareness ${viewport.name}`, async ({ page }) => {
    const sessionId = `visual-awareness-${viewport.name}`;
    await page.route(`**/api/sessions/${sessionId}`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ child: { id: 'visual-child', name: `Synthetic visual-awareness-${viewport.name}` }, session: { goal: 'Compare two fractions on one number line', status: 'active' } }),
    }));
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installFakeRealtime(page);
    await setLessonCapability(page, sessionId, 'visual-fixture-capability');
    await page.goto(`/lesson/${sessionId}`);
    await page.getByRole('button', { name: 'Begin' }).click();
    await expect(page.getByText(/Type below — Noura is ready|Listening/)).toBeVisible();
    await page.evaluate(() => {
      const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
      socket.emit('response_started', { response_id: 'visual-response' });
      socket.emit('board_ops', {
        response_id: 'visual-response', groupLabel: 'Fraction model',
        ops: [{ op: 'add', id: 'fraction-model-scale', spec: { kind: 'numberline', at: [130, 300], w: 740, min: 0, max: 1, marks: [{ value: 0.5, label: '1/2', color: 'blue' }, { value: 0.75, label: '3/4', color: 'red' }] } }],
      }, { audioSampleOffsets: { start: 0, end: 0 }, semanticObjectId: 'fraction-model', providerResponseId: 'visual-response' });
    });
    await expect(page.getByRole('status')).toContainText('Fraction model');
    await page.waitForTimeout(1_700);
    await expect(page).toHaveScreenshot(`lesson-board-awareness-${viewport.name}.png`, { animations: 'disabled' });
  });
}
